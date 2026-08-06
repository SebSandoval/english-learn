import "server-only";

import { db } from "@/lib/db/client";
import type { SrsItemType, User } from "@/lib/db/types";
import { localDate } from "@/lib/engagement/time";
import { schedule, type SrsState } from "@/lib/srs/sm2";

/** Items per review session. Enough to be worth it, short enough to finish. */
export const REVIEW_BATCH = 5;

export interface ReviewItem {
  id: string;
  type: SrsItemType;
  /** The rule or term being reviewed. */
  label: string;
  /** The right answer — for the tutor to grade against, never to show upfront. */
  correct: string;
  explanation: string | null;
  /** How the user originally got it wrong, when we have it. */
  wrongExample: string | null;
  mastery: number;
  timesSeen: number;
}

/**
 * Builds today's review set.
 *
 * Ordering is deliberate: overdue items first, then the ones the user gets
 * wrong most often, then the least mastered. Reviewing an item the user
 * already half-knows before one that's three days overdue wastes the session.
 */
export async function buildQueue(user: User, limit = REVIEW_BATCH): Promise<ReviewItem[]> {
  const supabase = db();
  const today = localDate(user.zona_horaria);

  const [mistakes, vocab] = await Promise.all([
    supabase
      .from("errores")
      .select("id, patron, correccion, explicacion, ejemplo_incorrecto, frecuencia, nivel_dominio, proxima_revision")
      .eq("usuario_id", user.id)
      .eq("estado", "activo")
      .lte("proxima_revision", today)
      .order("proxima_revision", { ascending: true })
      .order("frecuencia", { ascending: false })
      .limit(limit),
    supabase
      .from("vocabulario")
      .select("id, termino, ejemplo_en, significado_es, nivel_dominio, proxima_revision")
      .eq("usuario_id", user.id)
      .eq("estado", "activo")
      .lte("proxima_revision", today)
      .order("proxima_revision", { ascending: true })
      .limit(limit),
  ]);

  const items: Array<ReviewItem & { due: string }> = [
    ...(mistakes.data ?? []).map((m) => ({
      id: m.id,
      type: "error" as const,
      label: m.patron,
      correct: m.correccion,
      explanation: m.explicacion,
      wrongExample: m.ejemplo_incorrecto,
      mastery: m.nivel_dominio,
      timesSeen: m.frecuencia,
      due: m.proxima_revision,
    })),
    ...(vocab.data ?? []).map((v) => ({
      id: v.id,
      type: "vocabulario" as const,
      label: v.termino,
      correct: v.ejemplo_en ?? v.termino,
      explanation: v.significado_es,
      wrongExample: null,
      mastery: v.nivel_dominio,
      timesSeen: 1,
      due: v.proxima_revision,
    })),
  ];

  items.sort(
    (a, b) =>
      a.due.localeCompare(b.due) || b.timesSeen - a.timesSeen || a.mastery - b.mastery,
  );

  // Rebuilt explicitly rather than spread, to drop `due` without an unused binding.
  return items.slice(0, limit).map((i) => ({
    id: i.id,
    type: i.type,
    label: i.label,
    correct: i.correct,
    explanation: i.explanation,
    wrongExample: i.wrongExample,
    mastery: i.mastery,
    timesSeen: i.timesSeen,
  }));
}

export async function countDue(user: User): Promise<number> {
  const { count } = await db()
    .from("srs_pendientes")
    .select("*", { count: "exact", head: true })
    .eq("usuario_id", user.id)
    .lte("proxima_revision", localDate(user.zona_horaria));

  return count ?? 0;
}

/**
 * Records a graded answer: advances the item's schedule and logs the review.
 *
 * The log in `revisiones` is not redundant with the item's own state — the
 * item only remembers where it is now, while the log is what lets us see
 * later whether an item is genuinely improving or just cycling.
 */
export async function applyGrade(
  user: User,
  item: { id: string; type: SrsItemType },
  grade: number,
  sessionId: string,
): Promise<void> {
  const supabase = db();
  const table = item.type === "error" ? "errores" : "vocabulario";
  const today = localDate(user.zona_horaria);

  const { data: row } = await supabase
    .from(table)
    .select("facilidad, intervalo_dias, repeticiones, nivel_dominio")
    .eq("id", item.id)
    .maybeSingle();

  if (!row) {
    console.warn(`[srs] item ${item.id} vanished before grading`);
    return;
  }

  const current: SrsState = {
    ease: Number(row.facilidad),
    interval: row.intervalo_dias,
    repetitions: row.repeticiones,
    mastery: row.nivel_dominio,
  };

  const next = schedule(current, grade, today);

  await Promise.all([
    supabase
      .from(table)
      .update({
        facilidad: next.ease,
        intervalo_dias: next.interval,
        repeticiones: next.repetitions,
        nivel_dominio: next.mastery,
        proxima_revision: next.nextReview,
        estado: next.state,
      })
      .eq("id", item.id),
    supabase.from("revisiones").insert({
      usuario_id: user.id,
      item_tipo: item.type,
      item_id: item.id,
      sesion_id: sessionId,
      calidad: Math.round(grade),
    }),
  ]);
}
