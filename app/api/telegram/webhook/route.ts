import { NextResponse } from "next/server";

import { sttProvider } from "@/lib/audio";
import { activeSession } from "@/lib/db/queries";
import type { Session, User } from "@/lib/db/types";
import { env } from "@/lib/env";
import { LlmUnavailableError } from "@/lib/llm/chat";
import { processTurn } from "@/lib/modes";
import { ACTIONS, SNOOZE_REPLY, isAction } from "@/lib/telegram/actions";
import { LIMIT_REACHED, authorize, withinDailyLimit } from "@/lib/telegram/access";
import {
  answerCallback,
  clearKeyboard,
  downloadFile,
  sendChatAction,
  sendMessage,
} from "@/lib/telegram/client";
import { handleCommand, startFromNudge } from "@/lib/telegram/commands";
import { deliver } from "@/lib/telegram/deliver";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Longer than this and transcription plus a reply won't fit in maxDuration. */
const MAX_VOICE_SECONDS = 240;

/**
 * How long the whole request may take, measured from the moment it arrives.
 *
 * Under maxDuration with room to send the failure message if we give up. Every
 * slow step downstream is measured against this one clock, so transcription
 * time comes out of the LLM's budget rather than being added on top of it.
 */
const REQUEST_BUDGET_MS = 52_000;

/** Held back from the LLM's share for synthesis and the upload to Telegram. */
const SPEAKING_RESERVE_MS = 12_000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { first_name?: string; is_bot?: boolean };
    text?: string;
    voice?: { file_id: string; duration: number };
    audio?: { file_id: string; duration?: number };
  };
  /** A button press on a reminder. Requires callback_query in allowed_updates. */
  callback_query?: {
    id: string;
    from?: { first_name?: string; is_bot?: boolean };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

type TelegramMessage = NonNullable<TelegramUpdate["message"]>;
type TelegramCallback = NonNullable<TelegramUpdate["callback_query"]>;

/**
 * Telegram webhook.
 *
 * Always returns 200: a propagated error makes Telegram retry the same update
 * in a loop, and we'd end up duplicating messages in the session. Failures are
 * reported to the user through the chat itself.
 */
export async function POST(req: Request) {
  if (
    env.TELEGRAM_WEBHOOK_SECRET &&
    req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  const deadline = Date.now() + REQUEST_BUDGET_MS;

  const callback = update?.callback_query;
  if (callback?.message && !callback.from?.is_bot) {
    const chatId = callback.message.chat.id;
    try {
      await handleCallback(chatId, callback);
    } catch (e) {
      console.error("[webhook:callback]", e);
      await sendMessage(chatId, apology(e)).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  }

  const message = update?.message;
  if (!message || message.from?.is_bot) return NextResponse.json({ ok: true });

  const chatId = message.chat.id;

  try {
    await handleUpdate(chatId, message, deadline);
  } catch (e) {
    console.error("[webhook]", e);
    await sendMessage(chatId, apology(e)).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

/**
 * A button on a reminder was pressed.
 *
 * Order matters: acknowledge first so the spinner stops, strip the buttons so
 * yesterday's reminder can't open a session tomorrow, and only then do the slow
 * work. The acknowledgement is never held behind an LLM call.
 */
async function handleCallback(chatId: number, callback: TelegramCallback) {
  await answerCallback(callback.id);
  await clearKeyboard(chatId, callback.message!.message_id);

  if (!isAction(callback.data)) return;

  // Same gate as a written message: a callback is just as forgeable, and the
  // work behind it costs just as much.
  const gate = await authorize(chatId, undefined, callback.from?.first_name);
  if (!gate.user) {
    if (gate.reply) await sendMessage(chatId, gate.reply);
    return;
  }

  if (callback.data === ACTIONS.snooze) {
    await sendMessage(chatId, SNOOZE_REPLY);
    return;
  }

  if (!(await withinDailyLimit(gate.user))) {
    await sendMessage(chatId, LIMIT_REACHED);
    return;
  }

  await sendChatAction(chatId, "typing");

  const result = await startFromNudge(gate.user, callback.data === ACTIONS.quick);

  if (result.kind === "text") await sendMessage(chatId, result.text);
  else await deliver(chatId, result.mode, result.reply);
}

/**
 * The free models fail often enough that "something broke" is the wrong story:
 * it reads as a bug in the bot when the fix is to send the message again.
 */
function apology(e: unknown): string {
  if (e instanceof LlmUnavailableError) {
    return (
      "The model I think with is overloaded right now — that's the price of the " +
      "free tier. Send that again in a few seconds and it'll usually go through."
    );
  }

  return "Something broke on my end. Try again in a moment — if it keeps happening, it's a bug worth looking at.";
}

async function handleUpdate(chatId: number, message: TelegramMessage, deadline: number) {
  // Before anything that costs: an unknown chat gets one SELECT and a canned
  // line, never a model call.
  const gate = await authorize(chatId, message.text, message.from?.first_name);
  if (!gate.user) {
    if (gate.reply) await sendMessage(chatId, gate.reply);
    return;
  }

  const user = gate.user;

  if (!(await withinDailyLimit(user))) {
    await sendMessage(chatId, LIMIT_REACHED);
    return;
  }

  const audio = message.voice ?? message.audio;
  if (audio) {
    await handleVoiceNote(chatId, user, audio, deadline);
    return;
  }

  const text = message.text?.trim();
  if (!text) return;

  await sendChatAction(chatId, "typing");

  const command = await handleCommand(user, text);
  if (command) {
    if (command.kind === "text") await sendMessage(chatId, command.text);
    else await deliver(chatId, command.mode, command.reply);
    return;
  }

  const session = await activeSession(user.id, "free_conversation");
  const reply = await processTurn({
    user,
    session,
    text,
    deadline: deadline - SPEAKING_RESERVE_MS,
  });

  await deliver(chatId, session.modo, reply);
}

/**
 * A voice note is just a turn whose text we have to recover first.
 *
 * With no session open it opens a VOICE DRILL, since speaking unprompted is
 * what that mode is for. Inside an existing session it stays in that session —
 * answering a review item out loud should still be a review answer.
 */
async function handleVoiceNote(
  chatId: number,
  user: User,
  audio: { file_id: string; duration?: number },
  deadline: number,
) {
  const stt = sttProvider();

  if (!stt) {
    await sendMessage(
      chatId,
      "I can't listen yet — transcription isn't configured on my side. Write it to me instead?",
    );
    return;
  }

  if ((audio.duration ?? 0) > MAX_VOICE_SECONDS) {
    await sendMessage(
      chatId,
      "That's a long one — keep it under four minutes and I can work with it. " +
        "Shorter answers are better practice anyway.",
    );
    return;
  }

  await sendChatAction(chatId, "typing");

  const clip = await downloadFile(audio.file_id);
  const transcript = await stt.transcribe(clip, { language: "en" });

  if (!transcript.text) {
    await sendMessage(
      chatId,
      "I couldn't make out anything in that one. Try again somewhere quieter, or write it?",
    );
    return;
  }

  // The transcript is deliberately NOT echoed back. Reading your own words
  // right after speaking them makes the exercise feel like dictation, and it
  // pulls attention onto the transcription instead of onto the answer. It is
  // still stored on the message row, so the pronunciation signal in repeated
  // mistranscriptions is not lost — it just isn't shown mid-conversation.
  const session: Session = await activeSession(user.id, "voice_drill");
  const reply = await processTurn({
    user,
    session,
    text: transcript.text,
    wasAudio: true,
    // Telegram file ids stay valid, so this is a real handle on the original
    // audio without us paying to store any of it.
    audioPath: audio.file_id,
    deadline: deadline - SPEAKING_RESERVE_MS,
  });

  await deliver(chatId, session.modo, reply);
}
