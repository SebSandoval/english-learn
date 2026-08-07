import "server-only";

import { db } from "@/lib/db/client";
import { latestSummary, startSession } from "@/lib/db/queries";
import type { PracticeMode, User } from "@/lib/db/types";
import { decideTone } from "@/lib/engagement/nudge-tone";
import { masteredCount, readStreak } from "@/lib/engagement/streak";
import { localDate, localTime, localWeekday, withinWindow } from "@/lib/engagement/time";
import { callLlm } from "@/lib/llm/chat";
import { buildNudgePrompt } from "@/lib/llm/prompts/nudge";
import { chooseMode } from "@/lib/modes/selector";
import { buildQueue } from "@/lib/srs/queue";
import { nudgeKeyboard } from "@/lib/telegram/actions";
import { sendMessage } from "@/lib/telegram/client";

export type SkipReason =
  | "inactive"
  | "outside-window"
  | "rest-day"
  | "practised-today"
  | "already-nudged";

export type NudgeOutcome =
  | { sent: false; userId: string; reason: SkipReason }
  | { sent: true; userId: string; tone: string; mode: string; daysSince: number | null };

/**
 * Decides whether to contact one user right now, and does it.
 *
 * The cron fires every 30 minutes and cannot be trusted to be punctual, so all
 * the scheduling intelligence lives here: this function is safe to call at any
 * moment and will do nothing unless it should.
 */
export async function nudgeUser(user: User, now = new Date()): Promise<NudgeOutcome> {
  const skip = (reason: SkipReason): NudgeOutcome => ({ sent: false, userId: user.id, reason });

  if (!user.activo) return skip("inactive");

  const today = localDate(user.zona_horaria, now);

  if (!user.dias_activos.includes(localWeekday(user.zona_horaria, now))) {
    return skip("rest-day");
  }

  if (!withinWindow(localTime(user.zona_horaria, now), user.ventana_inicio, user.ventana_fin)) {
    return skip("outside-window");
  }

  const streak = await readStreak(user);
  if (streak.lastPractice === today) return skip("practised-today");

  if (await nudgedToday(user, today)) return skip("already-nudged");

  const [choice, mastered, lastTopic] = await Promise.all([
    chooseMode(user),
    masteredCount(user.id),
    latestSummary(user.id),
  ]);

  const decision = decideTone(streak);

  // Review needs a queue. If nothing is actually due by the time we get here,
  // fall back to conversation rather than opening an empty review session.
  const review = choice.mode === "spaced_review" ? await buildQueue(user) : [];
  const mode = choice.mode === "spaced_review" && !review.length ? "free_conversation" : choice.mode;

  const message = await writeMessage(user, streak.daysSince, decision, mode, {
    mastered,
    best: streak.best,
    total: streak.totalSessions,
    lastTopic,
  });

  // The session opens before the message goes out: whatever they reply lands in
  // the mode we proposed, instead of defaulting to free conversation.
  const session = await startSession(user.id, mode, {
    from_nudge: true,
    quick_mode: decision.offerQuickMode,
    ...(review.length ? { review: { items: review, index: 0, ungraded: 0 } } : {}),
  });

  // The buttons matter more than the copy: this is the moment the session is
  // won or lost, and one tap beats typing a command.
  await sendMessage(user.telegram_chat_id, message, {
    keyboard: nudgeKeyboard(mode, decision.offerQuickMode),
  });

  await db().from("nudges").insert({
    usuario_id: user.id,
    tono: decision.tone,
    modo_propuesto: mode,
    // A first-ever nudge has no gap to record; 0 reads correctly in the history.
    dias_sin_practicar: streak.daysSince ?? 0,
    mensaje: message,
    sesion_id: session.id,
  });

  return {
    sent: true,
    userId: user.id,
    tone: decision.tone,
    mode,
    daysSince: streak.daysSince,
  };
}

async function nudgedToday(user: User, today: string): Promise<boolean> {
  const { data } = await db()
    .from("nudges")
    .select("enviado_en")
    .eq("usuario_id", user.id)
    .order("enviado_en", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return false;
  return localDate(user.zona_horaria, new Date(data.enviado_en)) === today;
}

async function writeMessage(
  user: User,
  daysSince: number | null,
  decision: ReturnType<typeof decideTone>,
  mode: PracticeMode,
  facts: { mastered: number; best: number; total: number; lastTopic: string | null },
): Promise<string> {
  const prompt = buildNudgePrompt({
    level: user.nivel,
    mode,
    decision,
    name: user.nombre,
    positiveFact: positiveFact(facts),
    lastTopic: facts.lastTopic,
  });

  try {
    const text = await callLlm([{ role: "system", content: prompt }, { role: "user", content: "Write it." }], {
      temperature: 0.95,
      maxTokens: 300,
    });
    return text.trim().replace(/^["']|["']$/g, "");
  } catch (e) {
    console.error("[nudge] LLM failed, using fallback:", e);
    return fallbackMessage(daysSince);
  }
}

/** Picks the strongest true statement available. Never invents one. */
function positiveFact(facts: { mastered: number; best: number; total: number }): string | null {
  if (facts.mastered > 0) {
    return `they've fully mastered ${facts.mastered} item${facts.mastered === 1 ? "" : "s"} that used to trip them up`;
  }
  if (facts.best >= 3) return `their longest streak so far is ${facts.best} days`;
  if (facts.total > 1) return `they've already done ${facts.total} sessions`;
  return null;
}

/**
 * Used when the LLM is unreachable. A generic nudge still keeps the habit
 * alive; silence doesn't.
 */
function fallbackMessage(daysSince: number | null): string {
  if (daysSince === null) {
    return "Hey — I'm your English coach. Let's start small: tell me one thing you did today, in English.";
  }
  if (daysSince <= 1) return "Got a few minutes? Tell me one thing you did today — in English.";
  if (daysSince <= 3)
    return "It's been a couple of days. Two minutes is enough: what are you working on right now?";
  return (
    "Been a while. Let's make this easy — one sentence about your day, that's the whole ask. " +
    "Small counts, and it beats another day of nothing."
  );
}
