import { slugKey, type Correction } from "@/lib/llm/schemas";

/**
 * Drops corrections that don't belong to the turn being answered.
 *
 * The model sees the last MESSAGE_WINDOW turns but has no record of what it
 * already corrected — only its own `reply` text is stored, never the notes. So
 * it re-mines old student messages and the same note comes back two and three
 * messages in a row, usually reworded, which also splits one mistake into
 * several rows in `errores` and resets their SM-2 schedule.
 *
 * The prompt now says "correct only the latest message". This is the guard for
 * when it doesn't, and it doubles as an honesty check: the Telegram block
 * renders `wrong_example` as "❌ <their words>", so a quote the student didn't
 * just write has no business being there, invented or stale.
 */
export function freshCorrections(corrections: Correction[], studentText: string): Correction[] {
  const kept: Correction[] = [];
  const seen = new Set<string>();

  for (const c of corrections) {
    if (!quotesFrom(c.wrong_example, studentText)) {
      console.warn(`[tutor] dropped stale correction: ${c.pattern} — "${c.wrong_example}"`);
      continue;
    }

    // Two entries for the same rule in one turn are one entry.
    const key = slugKey(c.pattern);
    if (seen.has(key)) continue;
    seen.add(key);

    kept.push(c);
  }

  return kept;
}

/**
 * Is `quote` taken from `text`?
 *
 * Not an exact match: models normalise capitals and punctuation, and a voice
 * transcript arrives with its own. Word overlap keeps a lightly reworded quote
 * and still rejects one lifted from three turns ago, which shares nothing.
 */
export function quotesFrom(quote: string, text: string): boolean {
  const q = normalize(quote);
  const t = normalize(text);
  if (!q || !t) return false;
  if (t.includes(q)) return true;

  const words = q.split(" ");
  const bag = new Set(t.split(" "));
  const hits = words.filter((w) => bag.has(w)).length;
  return hits / words.length >= 0.6;
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
