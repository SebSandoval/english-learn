import "server-only";

import { deepgramTts } from "@/lib/audio/deepgram-tts";
import { googleTts } from "@/lib/audio/google-tts";
import { groqStt } from "@/lib/audio/groq";
import type { STTProvider, TTSProvider } from "@/lib/audio/types";
import { env } from "@/lib/env";

export type { AudioClip, STTProvider, Transcript, TTSProvider } from "@/lib/audio/types";

/**
 * Providers resolve to null when their key is missing rather than throwing.
 *
 * Voice is the one feature that can be half-configured — a Groq key without a
 * Google one is a perfectly reasonable intermediate state — and every caller
 * has a sane text-only fallback. Failing at the call site would turn a missing
 * env var into a broken conversation.
 */
export function sttProvider(): STTProvider | null {
  return env.GROQ_API_KEY ? groqStt : null;
}

/**
 * Deepgram first, Google as a fallback.
 *
 * Deepgram won on signup friction: Google's free tier is larger and contractual
 * but demands a card on the project, which is a real cost when the whole point
 * is that this runs for free. The Google provider stays because it works and
 * costs nothing to keep — setting GOOGLE_TTS_API_KEY without a Deepgram key is
 * all it takes to go back.
 */
export function ttsProvider(): TTSProvider | null {
  if (env.DEEPGRAM_API_KEY) return deepgramTts;
  if (env.GOOGLE_TTS_API_KEY) return googleTts;
  return null;
}

export interface VoiceCapabilities {
  /** The student can send voice notes. */
  listen: boolean;
  /** The tutor can send voice notes. */
  speak: boolean;
}

export function voiceCapabilities(): VoiceCapabilities {
  return { listen: sttProvider() !== null, speak: ttsProvider() !== null };
}
