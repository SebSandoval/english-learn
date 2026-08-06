import "server-only";

import { ttsProvider } from "@/lib/audio";
import { speakable } from "@/lib/audio/speakable";
import type { PracticeMode } from "@/lib/db/types";
import type { TutorReply } from "@/lib/llm/schemas";
import { sendChatAction, sendMessage, sendVoice } from "@/lib/telegram/client";
import { formatExtras, formatTutorReply } from "@/lib/telegram/format";

/** Modes whose reply is meant to be heard rather than read. */
const SPOKEN_MODES: PracticeMode[] = ["voice_drill", "listening"];

/**
 * Modes where showing the text alongside the audio destroys the exercise.
 *
 * In LISTENING the whole task is decoding speech; a transcript underneath means
 * the student reads it and learns nothing. In VOICE DRILL the text is only a
 * prompt to answer, so duplicating it is harmless and helps when the audio
 * arrives somewhere noisy.
 */
const AUDIO_ONLY: PracticeMode[] = ["listening"];

/**
 * Sends a tutor turn to Telegram in whatever shape the mode calls for.
 *
 * Every path degrades to text. A missing TTS key, a Google outage or a
 * rejected upload must cost the student the audio, never the turn.
 */
export async function deliver(chatId: number, mode: PracticeMode, reply: TutorReply): Promise<void> {
  const tts = SPOKEN_MODES.includes(mode) ? ttsProvider() : null;

  if (!tts) {
    await sendMessage(chatId, formatTutorReply(reply));
    return;
  }

  const spoken = speakable(reply.reply);

  try {
    await sendChatAction(chatId, "record_voice");
    // No rate override: Deepgram has no speaking-rate parameter, so asking for
    // one would be a silent no-op rather than a setting.
    const clip = await tts.synthesize(spoken);
    await sendVoice(chatId, clip);
  } catch (e) {
    console.error("[voice] synthesis failed:", e);
    // Falling back to text in LISTENING spoils that one exercise. Saying
    // nothing spoils the session, so the transcript wins.
    await sendMessage(chatId, formatTutorReply(reply));
    return;
  }

  if (!AUDIO_ONLY.includes(mode)) {
    // The prompt text repeated in writing, so a drill can be answered from a
    // train platform without replaying the note.
    await sendMessage(chatId, formatTutorReply(reply));
    return;
  }

  const extras = formatExtras(reply);
  if (extras) await sendMessage(chatId, extras);
}
