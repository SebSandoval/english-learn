/**
 * The provider boundary for voice.
 *
 * Everything above this file talks about "transcribe this" and "say this"; only
 * `groq.ts` and `google-tts.ts` know which vendor is answering. Both vendors
 * were picked for their permanent free tiers, which is exactly the kind of
 * decision that gets revisited — so it has to be one file to swap, not a grep.
 */

/** Raw audio and enough metadata for the next hop to accept it. */
export interface AudioClip {
  data: ArrayBuffer;
  /** e.g. "audio/ogg". Both Telegram and Groq route on this. */
  mimeType: string;
  /**
   * Filename hint for multipart uploads. Groq validates the *extension*, not
   * the bytes, so this is load-bearing — see normaliseFilename in groq.ts.
   */
  filename?: string;
}

export interface Transcript {
  /** Empty string is a valid result: silence, or a note with no speech in it. */
  text: string;
  /** Seconds of audio, when the provider reports it. */
  duration?: number;
}

export interface TranscribeOptions {
  /**
   * ISO-639-1. Pinning "en" stops Whisper from deciding that heavily
   * Spanish-accented English is Spanish and translating it for us.
   */
  language?: string;
  /** Vocabulary hint: names and terms the student is likely to have said. */
  prompt?: string;
}

export interface STTProvider {
  readonly name: string;
  transcribe(clip: AudioClip, opts?: TranscribeOptions): Promise<Transcript>;
}

export interface SynthesizeOptions {
  /** 1 is the voice's natural pace. Slower for beginners. */
  rate?: number;
}

export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, opts?: SynthesizeOptions): Promise<AudioClip>;
}
