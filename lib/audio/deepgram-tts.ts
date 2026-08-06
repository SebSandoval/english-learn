import "server-only";

import type { AudioClip, TTSProvider } from "@/lib/audio/types";
import { env, requireEnv } from "@/lib/env";

const ENDPOINT = "https://api.deepgram.com/v1/speak";

/**
 * Aura-2. $200 of signup credit, no card, and — the reason it won — it returns
 * Ogg/Opus natively, which is exactly what a Telegram voice note is.
 *
 * At ~40k characters a month the credit lasts over a decade. Unlike Google's
 * contractual 1M/month it is promotional credit, so this is "free for years",
 * not "free forever". Swapping providers is this one file.
 *
 * Override with DEEPGRAM_TTS_VOICE. The name encodes the language, so a Spanish
 * or British voice needs no other change.
 */
const DEFAULT_VOICE = "aura-2-asteria-en";

/** Measured against the live API: 2001 characters returns 413. */
const MAX_CHARS = 2000;

export const deepgramTts: TTSProvider = {
  name: "deepgram:aura-2",

  // SynthesizeOptions.rate is deliberately not accepted: /v1/speak has no
  // speaking-rate parameter, and taking one to ignore it would be a lie.
  async synthesize(text: string): Promise<AudioClip> {
    const input = fitToLimit(text.trim());
    if (!input) throw new Error("Nothing to synthesize.");

    const params = new URLSearchParams({
      model: env.DEEPGRAM_TTS_VOICE || DEFAULT_VOICE,
      // Opus in an Ogg container is the one combination Telegram renders as a
      // playable voice bubble rather than a file attachment.
      encoding: "opus",
      container: "ogg",
    });

    const res = await fetch(`${ENDPOINT}?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${requireEnv("DEEPGRAM_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: input }),
    });

    if (!res.ok) {
      throw new Error(`Deepgram TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    return { data: await res.arrayBuffer(), mimeType: "audio/ogg", filename: "voice.ogg" };
  },
};

/**
 * Keeps the text under the API's hard limit, cutting at a sentence boundary.
 *
 * This should never fire: the prompt caps replies at a few sentences and
 * listening passages at 150 words, which is ~900 characters. It exists because
 * the alternative when a model rambles is a 413 and no audio at all, and it
 * warns so a systematic overrun shows up in the logs rather than as audio that
 * quietly stops early.
 */
function fitToLimit(text: string): string {
  if (text.length <= MAX_CHARS) return text;

  console.warn(`[voice] reply was ${text.length} chars; Deepgram caps at ${MAX_CHARS}`);

  const window = text.slice(0, MAX_CHARS);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));

  return lastStop > MAX_CHARS / 2 ? window.slice(0, lastStop + 1) : window;
}
