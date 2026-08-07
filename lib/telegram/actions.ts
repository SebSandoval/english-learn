import type { PracticeMode } from "@/lib/db/types";
import type { InlineKeyboard } from "@/lib/telegram/client";

/**
 * The button protocol for reminders.
 *
 * The reminder arrives and the decision to practise has to survive the walk to
 * the keyboard: typing `/chat` is small friction, but it lands exactly where
 * sessions are lost — notification open, nothing written yet. A button collapses
 * that to one tap.
 *
 * `callback_data` is a fixed token, never data we act on directly. Telegram
 * echoes back whatever we put there and anyone can craft a callback, so an id
 * or a mode smuggled through here would be unvalidated input from the wire.
 * These three constants can only mean what the handler decides they mean.
 */
export const ACTIONS = {
  /** Continue in the session the reminder already opened. */
  go: "go",
  /** The two-minute version, whatever mode was proposed. */
  quick: "quick",
  /** Not now. Costs nothing and buys an honest signal. */
  snooze: "no",
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

export function isAction(data: string | undefined): data is Action {
  return !!data && Object.values(ACTIONS).includes(data as Action);
}

/** The label leads with the mode, so the tap and the offer say the same thing. */
const GO_LABEL: Record<PracticeMode, string> = {
  free_conversation: "💬 Let's talk",
  voice_drill: "🎙 Speak",
  spaced_review: "🔁 Review",
  listening: "🎧 Listen",
};

export function nudgeKeyboard(mode: PracticeMode, offerQuick: boolean): InlineKeyboard {
  const first: InlineKeyboard[number] = [{ text: GO_LABEL[mode], callback_data: ACTIONS.go }];

  // The escape hatch sits beside the real ask, not under it: "two minutes" is
  // an easier yes than "no", and only if it's on the same line as the yes.
  if (offerQuick) first.push({ text: "⏱ Two minutes", callback_data: ACTIONS.quick });

  return [first, [{ text: "Not today", callback_data: ACTIONS.snooze }]];
}

export const SNOOZE_REPLY =
  "Fine — no session today. I'll be back tomorrow; your streak record stays where it is. " +
  "If you change your mind in an hour, just write to me.";
