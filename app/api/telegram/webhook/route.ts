import { NextResponse } from "next/server";

import { activeSession, getOrCreateUser } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { processTurn } from "@/lib/modes";
import { sendChatAction, sendMessage } from "@/lib/telegram/client";
import { handleCommand } from "@/lib/telegram/commands";
import { formatTutorReply } from "@/lib/telegram/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { first_name?: string; is_bot?: boolean };
    text?: string;
    voice?: { file_id: string; duration: number };
    audio?: { file_id: string };
  };
}

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

  try {
    await handleUpdate(chatId, message);
  } catch (e) {
    console.error("[webhook]", e);
    await sendMessage(
      chatId,
      "Something broke on my end. Try again in a moment — if it keeps happening, it's a bug worth looking at.",
    ).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

async function handleUpdate(chatId: number, message: NonNullable<TelegramUpdate["message"]>) {
  const user = await getOrCreateUser(chatId, message.from?.first_name);

  // Voice arrives in phase 5; until then we say so rather than ignore it.
  if (message.voice || message.audio) {
    await sendMessage(
      chatId,
      "I can't listen yet — the audio layer is the last piece being built. Write it to me instead?",
    );
    return;
  }

  const text = message.text?.trim();
  if (!text) return;

  await sendChatAction(chatId, "typing");

  const command = await handleCommand(user, text);
  if (command) {
    await sendMessage(chatId, command.text);
    return;
  }

  const session = await activeSession(user.id, "free_conversation");
  const reply = await processTurn({ user, session, text });

  await sendMessage(chatId, formatTutorReply(reply));
}
