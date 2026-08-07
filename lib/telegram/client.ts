import type { AudioClip } from "@/lib/audio/types";
import { requireEnv } from "@/lib/env";

function base(): string {
  return `https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN")}`;
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${base()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result as T;
}

/** Telegram caps messages at 4096 characters; we split on paragraph boundaries. */
function splitIntoChunks(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split("\n\n")) {
    if ((current + paragraph).length > limit && current) {
      chunks.push(current.trim());
      current = "";
    }
    current += paragraph + "\n\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Buttons attached under a message.
 *
 * `callback_data` is capped at 64 bytes by Telegram and is echoed back to us
 * verbatim, so it stays a short opaque token — never anything we'd trust as
 * input. See ACTIONS in lib/telegram/actions.ts.
 */
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export async function sendMessage(
  chatId: number,
  text: string,
  options: { keyboard?: InlineKeyboard } = {},
): Promise<void> {
  const chunks = splitIntoChunks(text);

  for (const [i, chunk] of chunks.entries()) {
    await call("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      // On the last chunk only: buttons belong under the end of what they answer.
      ...(options.keyboard && i === chunks.length - 1
        ? { reply_markup: { inline_keyboard: options.keyboard } }
        : {}),
    });
  }
}

/**
 * Acknowledges a button press.
 *
 * Not optional: until this call lands, Telegram leaves a spinner on the button
 * and the user assumes it's broken. It runs before the slow work, never after.
 */
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  try {
    await call("answerCallbackQuery", { callback_query_id: callbackId, text });
  } catch {
    // Cosmetic, and the turn behind it matters more.
  }
}

/**
 * Strips the buttons off a message that has been acted on.
 *
 * Without it yesterday's reminder still offers a live "Two minutes" button
 * tomorrow, and pressing it opens a session out of nowhere.
 */
export async function clearKeyboard(chatId: number, messageId: number): Promise<void> {
  try {
    await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId });
  } catch {
    // Already edited, too old, or deleted. None of it is worth a failed turn.
  }
}

/**
 * Sends audio as a voice note — the round bubble with a waveform, playable in
 * place. Anything other than Ogg/Opus arrives as a file attachment instead,
 * which is why the TTS provider is pinned to OGG_OPUS.
 *
 * Multipart, so it can't go through `call`.
 */
export async function sendVoice(chatId: number, clip: AudioClip, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([clip.data], { type: clip.mimeType }), clip.filename ?? "voice.ogg");
  if (caption) {
    // Telegram truncates captions at 1024 characters and drops the message if
    // the HTML is unbalanced, so callers pass short, already-escaped text.
    form.append("caption", caption.slice(0, 1024));
    form.append("parse_mode", "HTML");
  }

  const res = await fetch(`${base()}/sendVoice`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendVoice: ${data.description}`);
}

/** Downloads a file the user sent us. Telegram links expire, so we fetch on demand. */
export async function downloadFile(fileId: string): Promise<AudioClip> {
  const file = await call<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram getFile returned no path.");

  const res = await fetch(
    `https://api.telegram.org/file/bot${requireEnv("TELEGRAM_BOT_TOKEN")}/${file.file_path}`,
  );
  if (!res.ok) throw new Error(`Telegram file download: ${res.status}`);

  return {
    data: await res.arrayBuffer(),
    // Voice notes come back as audio/ogg; the header is occasionally absent.
    mimeType: res.headers.get("content-type")?.split(";")[0] ?? "audio/ogg",
  };
}

/** The "typing…" indicator. Lasts ~5s; re-sent during long operations. */
export async function sendChatAction(
  chatId: number,
  action: "typing" | "record_voice" | "upload_voice" = "typing",
): Promise<void> {
  try {
    await call("sendChatAction", { chat_id: chatId, action });
  } catch {
    // Cosmetic: must never take down the turn.
  }
}

export async function setWebhook(url: string, secret: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: secret,
    // callback_query is what button presses arrive as. Leave it out and the
    // buttons render, do nothing, and spin forever.
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

/** Escapes text embedded in a parse_mode: HTML message. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
