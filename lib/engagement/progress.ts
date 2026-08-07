import "server-only";

import { db } from "@/lib/db/client";
import type { User } from "@/lib/db/types";
import { PASS_GRADE } from "@/lib/srs/sm2";

/**
 * Is the student actually getting better?
 *
 * `/streak` answers "have you shown up", which is not the same question and is
 * the only one the bot could answer until now. Every graded review has been
 * logged to `revisiones` since phase 4 and never read back; this is that log
 * finally doing its job.
 *
 * The headline is review accuracy over the last N answers against the N before
 * them. It moves within a week, unlike mastery — six spaced successes is months
 * — so it can show progress while the slower number is still zero.
 *
 * A "right" answer is the same threshold the scheduler uses to advance an item
 * (PASS_GRADE). Two definitions of correct in one product is how you end up
 * telling someone they got 70% while their items reset to tomorrow.
 */

/** Answers per comparison block. */
const BLOCK = 30;
/** Below this the percentage is noise and we say nothing rather than mislead. */
const MIN_SAMPLE = 8;

export interface Accuracy {
  total: number;
  right: number;
  /** 0–100, rounded. */
  percent: number;
}

export interface ProgressReport {
  /** Null until there are enough graded answers to mean anything. */
  recent: Accuracy | null;
  /** Null when there is no earlier block to compare against yet. */
  previous: Accuracy | null;
  mastered: { mistakes: number; vocab: number; avgDaysToMaster: number | null };
  /** Active mistakes that keep coming back, worst first. */
  stubborn: Array<{ pattern: string; mastery: number; frequency: number }>;
  /** Graded answers ever, so the caller can explain an empty report. */
  totalReviews: number;
}

export async function buildProgress(user: User): Promise<ProgressReport> {
  const supabase = db();

  const [{ data: reviews }, { data: masteredMistakes }, { data: masteredVocab }, { data: stubborn }] =
    await Promise.all([
      supabase
        .from("revisiones")
        .select("calidad, item_id, item_tipo, respondido_en")
        .eq("usuario_id", user.id)
        .order("respondido_en", { ascending: false })
        .limit(BLOCK * 2),
      supabase
        .from("errores")
        .select("id, detectado_en")
        .eq("usuario_id", user.id)
        .eq("estado", "dominado"),
      supabase
        .from("vocabulario")
        .select("id")
        .eq("usuario_id", user.id)
        .eq("estado", "dominado"),
      supabase
        .from("errores")
        .select("patron, nivel_dominio, frecuencia")
        .eq("usuario_id", user.id)
        .eq("estado", "activo")
        .gt("frecuencia", 1)
        .order("frecuencia", { ascending: false })
        .order("nivel_dominio", { ascending: true })
        .limit(3),
    ]);

  const graded = reviews ?? [];

  return {
    recent: accuracy(graded.slice(0, BLOCK)),
    previous: accuracy(graded.slice(BLOCK, BLOCK * 2)),
    mastered: {
      mistakes: masteredMistakes?.length ?? 0,
      vocab: masteredVocab?.length ?? 0,
      avgDaysToMaster: await averageDaysToMaster(user.id, masteredMistakes ?? []),
    },
    stubborn: (stubborn ?? []).map((s) => ({
      pattern: s.patron,
      mastery: s.nivel_dominio,
      frequency: s.frecuencia,
    })),
    totalReviews: graded.length,
  };
}

function accuracy(block: Array<{ calidad: number }>): Accuracy | null {
  if (block.length < MIN_SAMPLE) return null;

  const right = block.filter((r) => r.calidad >= PASS_GRADE).length;
  return { total: block.length, right, percent: Math.round((right / block.length) * 100) };
}

/**
 * How long a mistake takes to retire, from first detection to the review that
 * finished it.
 *
 * Nothing records WHEN an item became `dominado`, so the last review of that
 * item stands in for it — it is the review that pushed it over, give or take
 * the minutes since. Adding a column for a number shown in one line of one
 * command isn't worth a migration.
 */
async function averageDaysToMaster(
  userId: string,
  mastered: Array<{ id: string; detectado_en: string }>,
): Promise<number | null> {
  if (!mastered.length) return null;

  const { data } = await db()
    .from("revisiones")
    .select("item_id, respondido_en")
    .eq("usuario_id", userId)
    .in("item_id", mastered.map((m) => m.id))
    .order("respondido_en", { ascending: false });

  const lastReview = new Map<string, string>();
  for (const row of data ?? []) {
    if (!lastReview.has(row.item_id)) lastReview.set(row.item_id, row.respondido_en);
  }

  const spans = mastered
    .map((m) => {
      const end = lastReview.get(m.id);
      return end ? (Date.parse(end) - Date.parse(m.detectado_en)) / 86_400_000 : null;
    })
    .filter((d): d is number => d !== null && d >= 0);

  if (!spans.length) return null;
  return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
}
