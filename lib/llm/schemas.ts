import { z } from "zod";

/**
 * The tutor's output contract.
 *
 * The model doesn't just converse: on every turn it extracts corrections and new
 * vocabulary. That's what feeds the SM-2 tables — without this step, SPACED
 * REVIEW would have no real material from the user and would fall back to
 * generic exercises.
 */

export const correctionSchema = z.object({
  type: z.enum(["gramatica", "vocabulario", "pronunciacion", "uso"]),
  /** A stable, reusable description of the pattern — not of this one instance. */
  pattern: z.string().min(3).max(160),
  wrong_example: z.string().max(300),
  correction: z.string().min(1).max(300),
  explanation: z.string().max(400).optional(),
});

export const vocabSchema = z.object({
  term: z.string().min(1).max(80),
  type: z.enum(["palabra", "expresion", "phrasal_verb", "collocation"]),
  /** Only filled at beginner level; empty everywhere else. */
  meaning_es: z.string().max(200).optional(),
  example_en: z.string().max(300),
});

export const tutorReplySchema = z.object({
  reply: z.string().min(1),
  corrections: z.array(correctionSchema).max(3).default([]),
  new_vocab: z.array(vocabSchema).max(3).default([]),
  /** SPACED REVIEW only: the SM-2 quality grade for the user's answer. */
  review_quality: z.number().int().min(0).max(5).nullish(),
  end_session: z.boolean().default(false),
});

export type Correction = z.infer<typeof correctionSchema>;
export type NewVocab = z.infer<typeof vocabSchema>;
export type TutorReply = z.infer<typeof tutorReplySchema>;

const CORRECTION_TYPES = ["gramatica", "vocabulario", "pronunciacion", "uso"] as const;
const VOCAB_TYPES = ["palabra", "expresion", "phrasal_verb", "collocation"] as const;

/**
 * Free models don't guarantee clean JSON: they wrap it in ```json, prepend
 * prose, or put a plausible-but-invalid value in one enum field.
 *
 * Degradation here is per-item, never all-or-nothing. A single bad correction
 * must not cost us the reply — an earlier version validated the whole object at
 * once and dumped raw JSON into the chat when any field was off.
 */
export function parseTutorReply(raw: string): TutorReply {
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const obj = extractJsonObject(cleaned);

  // No object, or no usable reply: treat the text itself as what the tutor said.
  if (!obj || typeof obj.reply !== "string" || !obj.reply.trim()) {
    return {
      reply: cleaned || raw,
      corrections: [],
      new_vocab: [],
      review_quality: null,
      end_session: false,
    };
  }

  return {
    reply: obj.reply.trim(),
    corrections: salvage(obj.corrections, coerceCorrection, correctionSchema),
    new_vocab: salvage(obj.new_vocab, coerceVocab, vocabSchema),
    review_quality: asGrade(obj.review_quality),
    end_session: obj.end_session === true,
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validates array items one by one, keeping the good ones and dropping the rest. */
function salvage<T>(
  value: unknown,
  coerce: (item: Record<string, unknown>) => Record<string, unknown>,
  schema: z.ZodType<T>,
): T[] {
  if (!Array.isArray(value)) return [];

  const kept: T[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;

    const parsed = schema.safeParse(coerce(item as Record<string, unknown>));
    if (parsed.success) kept.push(parsed.data);
    else console.warn("[tutor] dropped malformed item:", parsed.error.issues[0]?.message);

    if (kept.length === 3) break;
  }
  return kept;
}

/** Models routinely swap the two `type` enums; map back instead of discarding. */
function coerceCorrection(item: Record<string, unknown>): Record<string, unknown> {
  const type = String(item.type ?? "").toLowerCase();
  return {
    ...item,
    type: (CORRECTION_TYPES as readonly string[]).includes(type) ? type : "uso",
    wrong_example: typeof item.wrong_example === "string" ? item.wrong_example : "",
    explanation: typeof item.explanation === "string" && item.explanation.trim()
      ? item.explanation
      : undefined,
  };
}

function coerceVocab(item: Record<string, unknown>): Record<string, unknown> {
  const type = String(item.type ?? "").toLowerCase();
  const meaning = typeof item.meaning_es === "string" ? item.meaning_es.trim() : "";
  return {
    ...item,
    type: (VOCAB_TYPES as readonly string[]).includes(type) ? type : "palabra",
    meaning_es: meaning || undefined,
    example_en: typeof item.example_en === "string" ? item.example_en : "",
  };
}

function asGrade(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
}

/** Stable slug used to deduplicate mistakes and vocabulary per user. */
export function slugKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
