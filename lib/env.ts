import { z } from "zod";

/**
 * Single point of environment validation. If a variable is missing, we fail at
 * startup with a clear message instead of mid-request with an opaque
 * `undefined`.
 *
 * Variables belonging to later phases are optional so the project boots without
 * them while we build phase by phase.
 */
const schema = z.object({
  // Phase 1 — Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),

  // Phase 2 — OpenRouter + Telegram
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  // Both accept a comma-separated list; they're concatenated into one fallback
  // chain, tried in order. See modelChain() in lib/llm/openrouter.ts.
  //
  // Order comes from scripts/bench-models.mts run against the real tutor prompt,
  // ranked on JSON validity first and latency second. Re-run it when a model
  // starts misbehaving — free-tier quality shifts without notice.
  OPENROUTER_MODEL: z.string().default("nvidia/nemotron-3-super-120b-a12b:free"),
  OPENROUTER_MODEL_FALLBACK: z
    .string()
    .default("openrouter/free,google/gemma-4-26b-a4b-it:free"),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Phase 3 — cron
  CRON_SECRET: z.string().min(1).optional(),

  // Phase 5 — voice
  GROQ_API_KEY: z.string().min(1).optional(),
  GOOGLE_TTS_API_KEY: z.string().min(1).optional(),
  // The voice name carries its own locale, so switching to en-GB is this one
  // variable. Empty falls back to the default in lib/audio/google-tts.ts.
  GOOGLE_TTS_VOICE: z.string().default(""),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  · ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${details}`);
}

export const env = parsed.data;

/** Fails with an actionable message when a variable from an unconfigured phase is used. */
export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing environment variable ${String(key)}.`);
  }
  return value as NonNullable<(typeof env)[K]>;
}
