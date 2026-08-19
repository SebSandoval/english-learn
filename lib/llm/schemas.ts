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
  /**
   * SPACED REVIEW only: which item the grade refers to.
   *
   * Without this we would assume the model asked whichever item our own index
   * pointed at, and grade that one. When the model asks something else — which
   * it does — the grade lands on the wrong item and silently corrupts its
   * schedule. Making the model name the item turns a silent error into a
   * detectable mismatch.
   */
  review_item_id: z.string().nullish(),
  end_session: z.boolean().default(false),
});

export type Correction = z.infer<typeof correctionSchema>;
export type NewVocab = z.infer<typeof vocabSchema>;
export type TutorReply = z.infer<typeof tutorReplySchema>;

const CORRECTION_TYPES = ["gramatica", "vocabulario", "pronunciacion", "uso"] as const;
const VOCAB_TYPES = ["palabra", "expresion", "phrasal_verb", "collocation"] as const;

/**
 * Free models don't guarantee clean JSON: they wrap it in ```json, prepend
 * prose, think out loud before answering, or get cut off mid-object when the
 * token budget runs out.
 *
 * Returns null when nothing usable came back, and the caller moves to the next
 * model. It used to return the raw text as the reply instead, on the theory
 * that whatever the model said was better than nothing. It is not: on
 * 2026-08-18 that shipped a reasoning model's chain of thought
 * ("We need to respond in English only... Let's analyze.") and a truncated JSON
 * object straight into the chat, as the tutor's own words.
 *
 * Degradation inside a valid object stays per-item, though. A single bad
 * correction must not cost us the reply — an earlier version validated the
 * whole object at once and dumped raw JSON into the chat when any field was off.
 */
export function parseTutorReply(raw: string): TutorReply | null {
  const obj = extractJsonObject(stripWrapping(raw));

  // No object, or no usable reply: this attempt produced nothing to send.
  if (!obj || typeof obj.reply !== "string" || !obj.reply.trim()) return null;

  return {
    reply: obj.reply.trim(),
    corrections: salvage(obj.corrections, coerceCorrection, correctionSchema),
    new_vocab: salvage(obj.new_vocab, coerceVocab, vocabSchema),
    review_quality: asGrade(obj.review_quality),
    review_item_id: typeof obj.review_item_id === "string" ? obj.review_item_id : null,
    end_session: obj.end_session === true,
  };
}

/** Markdown fences and the <think> block some reasoning models emit inline. */
function stripWrapping(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  const slice = outermostObject(text.slice(start));
  if (!slice) return null;

  try {
    const parsed: unknown = JSON.parse(slice);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Cuts `text` — which starts at an opening brace — down to one JSON object.
 *
 * Two things it repairs, both seen in production:
 *   · prose after the object: stop at the brace that closes it
 *   · a reply truncated by max_tokens mid-object: reopen at the last field that
 *     ended cleanly and close what is still open
 *
 * Truncation inside "reply" itself is deliberately NOT repaired: closing the
 * string there would send half a sentence as if the tutor meant to stop. Since
 * "reply" is the first key in the contract, the repair finds no complete field,
 * returns nothing, and the turn is retried on another model.
 */
function outermostObject(text: string): string | null {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  /** End of the last field that closed cleanly, and the nesting around it. */
  let safeEnd = -1;
  let safeOpen = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      open.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      open.pop();
      if (!open.length) return text.slice(0, i + 1);
      safeEnd = i + 1;
      safeOpen = open.join("");
    } else if (ch === ",") {
      safeEnd = i;
      safeOpen = open.join("");
    }
  }

  if (safeEnd < 0) return null;

  return text.slice(0, safeEnd) + [...safeOpen].reverse().join("");
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
