import "server-only";

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

export function ttsProvider(): TTSProvider | null {
  return env.GOOGLE_TTS_API_KEY ? googleTts : null;
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
