import "server-only";

import { db } from "@/lib/db/client";
import type { Streak, User } from "@/lib/db/types";
import { daysBetween, localDate } from "@/lib/engagement/time";

/** Streak lengths worth celebrating out loud. */
const MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365];

export interface StreakState {
  current: number;
  best: number;
  lastPractice: string | null;
  /**
   * Days since the last practice in the user's local calendar; 0 = today.
   * `null` means they have never practised — deliberately not Infinity, so
   * callers are forced to handle "no history" instead of doing arithmetic on it.
   */
  daysSince: number | null;
  totalSessions: number;
  /** True when the stored streak is stale and effectively already broken. */
  broken: boolean;
  /**
   * The streak length being hit right now, when it's one worth naming.
   *
   * Derived here rather than passed around: it used to be a parameter of
   * `decideTone`, every caller passed `null`, and MILESTONES was dead code for
   * months while celebration fired on a plain `current >= 7` — which made every
   * reminder a celebration once the streak was long, instead of the day it
   * mattered.
   */
  milestone: number | null;
}

export async function readStreak(user: User): Promise<StreakState> {
  const { data } = await db()
    .from("racha")
    .select("*")
    .eq("usuario_id", user.id)
    .maybeSingle();

  return derive(data, user.zona_horaria);
}

/**
 * The stored `streak_actual` is only valid as long as the user keeps showing
 * up. Rather than run a nightly job to expire streaks, we treat the stored
 * value as a claim and re-derive the truth from `ultima_practica` on read.
 */
function derive(row: Streak | null, timeZone: string): StreakState {
  const today = localDate(timeZone);

  if (!row?.ultima_practica) {
    return {
      current: 0,
      best: row?.streak_maximo ?? 0,
      lastPractice: null,
      daysSince: null,
      totalSessions: row?.total_sesiones ?? 0,
      broken: false,
      milestone: null,
    };
  }

  const daysSince = daysBetween(row.ultima_practica, today);
  // Practising today or yesterday keeps the streak alive; the day after that,
  // the chain is broken even though the row still says otherwise.
  const broken = daysSince > 1;
  const current = broken ? 0 : row.streak_actual;

  return {
    current,
    best: row.streak_maximo,
    lastPractice: row.ultima_practica,
    daysSince,
    totalSessions: row.total_sesiones,
    broken,
    // A broken streak is 0, which is in no milestone: nobody gets congratulated
    // on a chain they already dropped.
    milestone: MILESTONES.includes(current) ? current : null,
  };
}

/**
 * Records that the user practised, and returns the state afterwards.
 *
 * Idempotent within a day: practising ten times on Tuesday is still one day of
 * streak. Called on every user turn, so it must stay cheap and safe to repeat.
 */
export async function registerPractice(user: User): Promise<StreakState> {
  const supabase = db();
  const today = localDate(user.zona_horaria);

  const { data: row } = await supabase
    .from("racha")
    .select("*")
    .eq("usuario_id", user.id)
    .maybeSingle();

  const previous = derive(row, user.zona_horaria);

  // Already counted today — nothing to update, and no milestone to re-announce.
  if (row?.ultima_practica === today) {
    return { ...previous, milestone: null };
  }

  const current = previous.daysSince === 1 ? previous.current + 1 : 1;
  const best = Math.max(current, previous.best);
  const totalSessions = previous.totalSessions + 1;

  await supabase.from("racha").upsert(
    {
      usuario_id: user.id,
      streak_actual: current,
      streak_maximo: best,
      ultima_practica: today,
      total_sesiones: totalSessions,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "usuario_id" },
  );

  return {
    current,
    best,
    lastPractice: today,
    daysSince: 0,
    totalSessions,
    broken: false,
    milestone: MILESTONES.includes(current) ? current : null,
  };
}

/** Marks the reminder that produced this session as answered. */
export async function markNudgeAnswered(sessionId: string): Promise<void> {
  await db()
    .from("nudges")
    .update({ respondido: true })
    .eq("sesion_id", sessionId)
    .eq("respondido", false);
}

/** Count of items the user has actually mastered — the honest positive number. */
export async function masteredCount(userId: string): Promise<number> {
  const supabase = db();

  const [mistakes, vocab] = await Promise.all([
    supabase
      .from("errores")
      .select("*", { count: "exact", head: true })
      .eq("usuario_id", userId)
      .eq("estado", "dominado"),
    supabase
      .from("vocabulario")
      .select("*", { count: "exact", head: true })
      .eq("usuario_id", userId)
      .eq("estado", "dominado"),
  ]);

  return (mistakes.count ?? 0) + (vocab.count ?? 0);
}
