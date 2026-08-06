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

export async function sendMessage(chatId: number, text: string): Promise<void> {
  for (const chunk of splitIntoChunks(text)) {
    await call("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
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
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

/** Escapes text embedded in a parse_mode: HTML message. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
