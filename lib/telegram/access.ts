import "server-only";

import { db } from "@/lib/db/client";
import { createUser, findUserByChat } from "@/lib/db/queries";
import type { User } from "@/lib/db/types";
import { env } from "@/lib/env";

/**
 * Who is allowed to talk to the bot, and how much.
 *
 * The webhook secret only proves the caller is Telegram — it says nothing about
 * who is writing. The bot's handle is public, so without this anyone who finds
 * it spends the free tier, and every stranger's turn is an LLM call.
 *
 * A row in `usuarios` IS the permission: existing users always pass, which is
 * why no schema change is needed. New chats only get a row if they own the bot
 * or send a valid invite code, so an unknown chat costs one cheap SELECT and a
 * canned reply — never a model call.
 */

export type Gate =
  | { user: User }
  /** Nothing further happens; `reply` is sent verbatim when present. */
  | { user: null; reply?: string };

/** Empty means the gate is off — see TELEGRAM_OWNER_CHAT_IDS in lib/env.ts. */
export function ownerChatIds(): number[] {
  return env.TELEGRAM_OWNER_CHAT_IDS.split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id !== 0);
}

export async function authorize(
  chatId: number,
  text: string | undefined,
  name?: string,
): Promise<Gate> {
  const existing = await findUserByChat(chatId);
  if (existing) return { user: existing };

  const owners = ownerChatIds();

  if (!owners.length) {
    console.warn("[access] TELEGRAM_OWNER_CHAT_IDS is unset — the bot is open to anyone");
    return { user: await createUser(chatId, name) };
  }

  if (owners.includes(chatId)) return { user: await createUser(chatId, name) };

  const code = redeemed(text);
  if (code && env.INVITE_CODE && code === env.INVITE_CODE) {
    return { user: await createUser(chatId, name) };
  }

  // Deliberately the same answer for a wrong code and no code: distinguishing
  // them turns the bot into an oracle for guessing the code.
  return {
    user: null,
    reply:
      "This bot is private — it's one person's English coach, running on a free tier " +
      "that one person can afford. If you were invited, send <code>/invite CODE</code>.",
  };
}

/** `/invite CODE` — the only command an unregistered chat can use. */
function redeemed(text: string | undefined): string | null {
  const match = text?.trim().match(/^\/invite(?:@\w+)?\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Has this user spent their 24-hour allowance?
 *
 * A rolling window rather than a calendar day on purpose: the calendar version
 * needs the user's timezone and hands a fresh budget to anyone who waits for
 * local midnight. The ceiling is on cost, and cost doesn't reset at midnight.
 *
 * Fails open. A counting error must not silence the bot for a legitimate user —
 * the gate above is what keeps strangers out; this only caps the ones already in.
 */
export async function withinDailyLimit(user: User): Promise<boolean> {
  if (ownerChatIds().includes(user.telegram_chat_id)) return true;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const supabase = db();

  try {
    // Two queries instead of a join: sessions stay open across days, so
    // filtering messages by their session's start date would miss turns.
    const { data: sessions } = await supabase
      .from("sesiones")
      .select("id")
      .eq("usuario_id", user.id)
      .gte("iniciada_en", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const ids = (sessions ?? []).map((s) => s.id);
    if (!ids.length) return true;

    const { count } = await supabase
      .from("mensajes")
      .select("*", { count: "exact", head: true })
      .in("sesion_id", ids)
      .eq("rol", "user")
      .gte("created_at", since);

    return (count ?? 0) < env.DAILY_TURN_LIMIT;
  } catch (e) {
    console.error("[access] daily limit check failed, allowing turn:", e);
    return true;
  }
}

export const LIMIT_REACHED =
  "That's enough for today — you've hit the daily limit I can afford on the free tier. " +
  "It frees up as the last 24 hours roll past, so come back later and we'll keep going.";
