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

  // Phase 2 — the LLM + Telegram
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  /**
   * The fallback chain, tried in order: `provider:model`, comma-separated.
   *
   * Groq leads because the chain has to cross PROVIDERS to be worth anything.
   * On 2026-08-06 the bot went down with every OpenRouter model returning 429
   * `free-models-per-day`: one shared daily quota, so a chain living entirely
   * inside OpenRouter fails all at once and the fallback buys nothing. Groq's
   * quota is counted separately, and its key was already configured for
   * transcription.
   *
   * Order inside Groq is measured against the real LISTENING prompt — the
   * longest generation the bot ever asks for: llama-3.3-70b 1350ms,
   * gpt-oss-120b 1733ms, both valid JSON. qwen3.6-27b is absent because it
   * failed JSON validation outright. Re-run `npm run bench` when replies
   * degrade, and reorder here.
   */
  LLM_CHAIN: z
    .string()
    .default(
      "groq:llama-3.3-70b-versatile," +
        "groq:openai/gpt-oss-120b," +
        "openrouter:openrouter/free," +
        "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    ),

  // Legacy, appended after LLM_CHAIN. Entries with no provider prefix are read
  // as OpenRouter. Kept so an override already set in Vercel keeps working.
  OPENROUTER_MODEL: z.string().default(""),
  OPENROUTER_MODEL_FALLBACK: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Phase 3 — cron
  CRON_SECRET: z.string().min(1).optional(),

  // Phase 5 — voice
  GROQ_API_KEY: z.string().min(1).optional(),
  // TTS: Deepgram wins when both are set. See ttsProvider() in lib/audio.
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_TTS_VOICE: z.string().default(""),
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
