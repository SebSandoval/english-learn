import "server-only";

import { db } from "@/lib/db/client";
import type { PracticeMode, User } from "@/lib/db/types";
import { daysBetween, localDate } from "@/lib/engagement/time";

/**
 * Modes wired end to end today. The scorer knows about all four, but only ever
 * returns one that can actually run — a nudge proposing a mode that answers
 * "not built yet" would be worse than no nudge at all.
 *
 * Phase 5 adds voice_drill and listening.
 */
export const IMPLEMENTED_MODES: PracticeMode[] = ["free_conversation", "spaced_review"];

const ALL_MODES: PracticeMode[] = [
  "free_conversation",
  "voice_drill",
  "spaced_review",
  "listening",
];

/** Review debt outweighs variety past this point: overdue items stop accumulating. */
const REVIEW_DEBT_THRESHOLD = 3;

export interface ModeChoice {
  mode: PracticeMode;
  dueItems: number;
  /** Kept for logging — makes it possible to explain a choice after the fact. */
  scores: Record<string, number>;
}

/**
 * Chooses today's mode by scoring, not by a fixed rotation.
 *
 * Scoring rather than round-robin because the inputs pull in different
 * directions: overdue review items are urgent, staleness matters linearly, and
 * repeating yesterday's mode is merely undesirable. Weights let those trade off
 * instead of one rule always winning.
 */
export async function chooseMode(user: User): Promise<ModeChoice> {
  const supabase = db();
  const today = localDate(user.zona_horaria);

  const [{ data: recent }, { count: dueCount }] = await Promise.all([
    supabase
      .from("sesiones")
      .select("modo, iniciada_en")
      .eq("usuario_id", user.id)
      .order("iniciada_en", { ascending: false })
      .limit(40),
    supabase
      .from("srs_pendientes")
      .select("*", { count: "exact", head: true })
      .eq("usuario_id", user.id)
      .lte("proxima_revision", today),
  ]);

  const dueItems = dueCount ?? 0;
  const sessions = recent ?? [];

  const lastUsed = new Map<PracticeMode, string>();
  for (const s of sessions) {
    if (!lastUsed.has(s.modo)) lastUsed.set(s.modo, localDate(user.zona_horaria, new Date(s.iniciada_en)));
  }
  const yesterdaysMode = sessions[0]?.modo;

  const scores: Record<string, number> = {};

  for (const mode of ALL_MODES) {
    const last = lastUsed.get(mode);
    // Never practised counts as very stale, but not infinitely so — otherwise a
    // brand-new user's first nudge is decided by array order.
    const staleness = last ? Math.min(daysBetween(last, today), 14) : 7;

    let score = mode === "spaced_review" ? 10 * Math.min(dueItems, 5) : 3 * staleness;

    // Variety: two identical days in a row is the fastest way to make a habit
    // feel like a chore.
    if (mode === yesterdaysMode) score -= 15;

    scores[mode] = score;
  }

  // Hard rule on top of the scores: review debt does not get to pile up.
  if (dueItems >= REVIEW_DEBT_THRESHOLD && IMPLEMENTED_MODES.includes("spaced_review")) {
    return { mode: "spaced_review", dueItems, scores };
  }

  const mode = IMPLEMENTED_MODES.reduce((best, candidate) =>
    scores[candidate] > scores[best] ? candidate : best,
  );

  return { mode, dueItems, scores };
}
