import type { Level, PracticeMode } from "@/lib/db/types";
import type { ToneDecision } from "@/lib/engagement/nudge-tone";

const LEVEL_REGISTER: Record<Level, string> = {
  principiante: "Very simple English. Short sentences, common words, present and past simple only.",
  intermedio: "Natural English with contractions. Normal vocabulary, nothing rarefied.",
  avanzado: "Full native register. Idioms and nuance are fine.",
};

const MODE_HOOK: Record<PracticeMode, string> = {
  free_conversation: "an open question or opinion they can react to in one message",
  spaced_review: "a micro-exercise built from something they got wrong before",
  voice_drill: "a short prompt they'd answer with a voice note",
  listening: "a short listening exercise",
};

export interface NudgePromptInput {
  level: Level;
  mode: PracticeMode;
  decision: ToneDecision;
  name?: string | null;
  /** A true, specific fact from their history. Required for the firm tone. */
  positiveFact?: string | null;
  lastTopic?: string | null;
}

/**
 * Prompt for the reminder message.
 *
 * Deliberately NOT the tutor prompt: this produces plain text, not the JSON
 * contract, and it isn't a teaching turn — nothing here should be corrected,
 * scored or saved as practice.
 */
export function buildNudgePrompt(input: NudgePromptInput): string {
  const { decision } = input;

  const context: string[] = [];
  if (input.name) context.push(`Their name is ${input.name}.`);
  if (input.lastTopic) context.push(`Last time you talked about: ${input.lastTopic}`);
  if (input.positiveFact) context.push(`True fact from their history: ${input.positiveFact}`);

  return `
You are the English coach behind "English Push". You are writing an unprompted
message to your student — they did not message you first. You are starting the
conversation.

Write in ENGLISH ONLY. ${LEVEL_REGISTER[input.level]}

## Today's tone
${decision.guidance}

${decision.offerQuickMode ? "Offer the two-minute version explicitly. Make the smallest possible ask." : ""}

## What you're pulling them into
Today's practice is ${MODE_HOOK[input.mode]}. End your message with that hook, ready
to answer — don't ask permission, don't ask "do you want to practice?". Just start.

${context.length ? `## Context\n${context.join("\n")}` : ""}

## Format
Plain text for a Telegram message. No JSON, no markdown headers, no bullet lists,
no quotation marks around the whole thing. Emoji only if it carries real tone.
Never mention that you're an automated reminder or that a system scheduled this.
Write it as a person who thought of them.
`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
