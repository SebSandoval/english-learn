/**
 * Prepares a tutor reply to be read aloud.
 *
 * The prompt already tells the model to write for the ear in spoken modes, but
 * it slips — a stray emoji or a markdown asterisk gets pronounced, and one
 * "asterisk asterisk" in the middle of a listening passage ruins the exercise.
 * This is the guard, not the mechanism.
 */
export function speakable(text: string): string {
  return (
    text
      // Our own HTML formatting, if any leaked in.
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "and")
      .replace(/&lt;/g, "")
      .replace(/&gt;/g, "")
      // Markdown emphasis and code fences: the marks are noise when spoken.
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_`#]/g, "")
      // Dashes read as pauses only if they're punctuation the engine knows.
      .replace(/\s*[—–]\s*/g, ", ")
      // Bullets at the start of a line.
      .replace(/^\s*[-•]\s+/gm, "")
      // Emoji and other pictographs.
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, "")
      .replace(/[ \t]+/g, " ")
      // Blank lines become sentence breaks, so the voice actually pauses — but
      // only where there isn't already punctuation to pause on. Stripping a
      // code block leaves a gap right after a colon, and ":." is pronounced.
      .replace(/([^\s.,;:!?])[ \t]*\n{2,}/g, "$1. ")
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim()
  );
}
