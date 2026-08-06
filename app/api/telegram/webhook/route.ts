import { NextResponse } from "next/server";

import { sttProvider } from "@/lib/audio";
import { activeSession, getOrCreateUser } from "@/lib/db/queries";
import type { Session, User } from "@/lib/db/types";
import { env } from "@/lib/env";
import { LlmUnavailableError } from "@/lib/llm/openrouter";
import { processTurn } from "@/lib/modes";
import { downloadFile, sendChatAction, sendMessage } from "@/lib/telegram/client";
import { handleCommand } from "@/lib/telegram/commands";
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
}

type TelegramMessage = NonNullable<TelegramUpdate["message"]>;

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
  const message = update?.message;

  if (!message || message.from?.is_bot) return NextResponse.json({ ok: true });

  const chatId = message.chat.id;
  const deadline = Date.now() + REQUEST_BUDGET_MS;

  try {
    await handleUpdate(chatId, message, deadline);
  } catch (e) {
    console.error("[webhook]", e);
    await sendMessage(chatId, apology(e)).catch(() => {});
  }

  return NextResponse.json({ ok: true });
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
  const user = await getOrCreateUser(chatId, message.from?.first_name);

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
