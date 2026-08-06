import "server-only";

import type {
  AudioClip,
  STTProvider,
  TranscribeOptions,
  Transcript,
} from "@/lib/audio/types";
import { requireEnv } from "@/lib/env";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * `whisper-large-v3-turbo`: ~200x real-time, 2,000 requests/day free.
 *
 * Running Whisper ourselves was rejected — Vercel is serverless, the weights
 * don't fit the bundle, and a second always-on service would cost more than the
 * free tier it replaced.
 */
const MODEL = "whisper-large-v3-turbo";

/** Groq's own limit on the free tier. A Telegram voice note is ~10KB/second. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Extensions Groq accepts. It sniffs the filename, not the bytes. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/oga": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

export const groqStt: STTProvider = {
  name: `groq:${MODEL}`,

  async transcribe(clip: AudioClip, opts: TranscribeOptions = {}): Promise<Transcript> {
    if (clip.data.byteLength > MAX_BYTES) {
      throw new Error(`Audio is ${Math.round(clip.data.byteLength / 1e6)}MB; the limit is 25MB.`);
    }

    const form = new FormData();
    form.append("file", new Blob([clip.data], { type: clip.mimeType }), normaliseFilename(clip));
    form.append("model", MODEL);
    // verbose_json is the only format that returns the duration, which we log
    // to spot notes that are silence plus a cough.
    form.append("response_format", "verbose_json");
    form.append("language", opts.language ?? "en");
    if (opts.prompt) form.append("prompt", opts.prompt.slice(0, 800));

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireEnv("GROQ_API_KEY")}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Groq STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = (await res.json()) as { text?: string; duration?: number };
    return { text: (data.text ?? "").trim(), duration: data.duration };
  },
};

/**
 * Telegram serves voice notes as `.oga`, which Groq rejects even though the
 * container is plain Ogg. Rewrite the extension from the MIME type instead of
 * trusting whatever name came down the wire.
 */
function normaliseFilename(clip: AudioClip): string {
  const base = clip.mimeType.split(";")[0].trim().toLowerCase();
  return `audio.${EXTENSION_BY_MIME[base] ?? "ogg"}`;
}
