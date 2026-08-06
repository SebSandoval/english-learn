import "server-only";

import type { AudioClip, SynthesizeOptions, TTSProvider } from "@/lib/audio/types";
import { env, requireEnv } from "@/lib/env";

const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

/**
 * Chirp 3 HD: 1M characters/month free, permanently. Expected usage here is
 * ~40k, so it never bills. ElevenLabs' 10k/month would have lasted two days.
 *
 * Override with GOOGLE_TTS_VOICE. The name encodes the locale, so an en-GB
 * voice needs no other change.
 */
const DEFAULT_VOICE = "en-US-Chirp3-HD-Achernar";

/**
 * OGG_OPUS is what Telegram wants for a voice note (any other encoding uploads
 * as a file attachment instead, which loses the waveform and the play-in-place
 * bubble). Chirp 3 supports it natively, so nothing has to be transcoded.
 */
const ENCODING = "OGG_OPUS";

/** Google rejects inputs over 5000 bytes; leave room for multi-byte characters. */
const MAX_CHARS = 4500;

export const googleTts: TTSProvider = {
  name: "google:chirp3-hd",

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<AudioClip> {
    const input = text.trim().slice(0, MAX_CHARS);
    if (!input) throw new Error("Nothing to synthesize.");

    const voice = env.GOOGLE_TTS_VOICE || DEFAULT_VOICE;

    const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(requireEnv("GOOGLE_TTS_API_KEY"))}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Plain text only: Chirp 3 HD voices do not accept SSML.
        input: { text: input },
        voice: { languageCode: localeOf(voice), name: voice },
        audioConfig: {
          audioEncoding: ENCODING,
          // Chirp 3 ignores pitch and effects profiles, so we send neither, and
          // we omit the rate entirely when it's the default.
          ...(opts.rate && opts.rate !== 1 ? { speakingRate: opts.rate } : {}),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Google TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) throw new Error("Google TTS returned no audio.");

    return { data: decodeBase64(data.audioContent), mimeType: "audio/ogg", filename: "voice.ogg" };
  },
};

/** "en-US-Chirp3-HD-Achernar" → "en-US". */
function localeOf(voice: string): string {
  return voice.split("-").slice(0, 2).join("-");
}

function decodeBase64(value: string): ArrayBuffer {
  const buf = Buffer.from(value, "base64");
  // Buffer is a view into a pooled ArrayBuffer; slice out just our bytes.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
