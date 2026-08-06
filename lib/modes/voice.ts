/**
 * Opening instructions for the two spoken modes.
 *
 * They live apart from `commands.ts` because three call sites need them —
 * `/drill`, `/listen`, and `/practice` when the selector lands on a voice mode
 * — and because the wording is prompt engineering, not command plumbing.
 */

export const DRILL_OPENING = [
  "Open the voice drill. One short line saying you want to hear them speak, then",
  "the prompt itself: one concrete question that needs twenty to forty-five seconds",
  "of spoken answer. Something with an opinion or an explanation in it, never a",
  "question they can answer with a fact.",
  "",
  "Tell them to reply with a voice note. Say it once, plainly, and don't explain",
  "how Telegram works.",
  "",
  "Remember every word of this is spoken aloud. No lists, no symbols, no emoji.",
].join("\n");

export const LISTENING_OPENING = [
  "Start the listening exercise. Do NOT introduce it with meta-talk like",
  '"here is a passage" — open with one short framing sentence at most, then go',
  "straight into it.",
  "",
  "The passage: a hundred to a hundred and fifty words, natural spoken register,",
  "contractions, real content. Then ONE comprehension question at the very end.",
  "",
  "This is all read aloud and they never see it written, so write for the ear:",
  "no lists, no symbols, no parentheses, no emoji, and spell out any numbers.",
  '"review_quality" is null and "end_session" is false.',
].join("\n");
