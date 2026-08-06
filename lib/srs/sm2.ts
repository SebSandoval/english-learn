/**
 * Spaced repetition scheduling.
 *
 * This is SM-2's ease-factor mechanic wrapped around a fixed interval ladder,
 * rather than SM-2's own `interval × ease` recurrence.
 *
 * Why: plain SM-2 produces 1, 6, 15, 38, 98… — the gaps blow past two months
 * within five successful reviews, which is right for flashcards you'll keep for
 * years and wrong for a habit you're still forming. The ladder keeps the early
 * reviews close enough to feel connected to the conversation they came from,
 * and the ease factor still does its job on top: items you find easy stretch
 * out to 1.12× the base, items you keep fumbling compress to 0.52×.
 */

/** Base interval in days, indexed by successful repetitions. */
const LADDER = [1, 3, 7, 15, 30, 60];

const EASE_MIN = 1.3;
const EASE_MAX = 2.8;
const EASE_DEFAULT = 2.5;

/** Below this grade the answer counts as a failure and the ladder resets. */
const PASS_GRADE = 3;

/** Repetitions needed before an item is considered learned for good. */
const MASTERY_REPETITIONS = 6;

export interface SrsState {
  ease: number;
  interval: number;
  repetitions: number;
  mastery: number;
}

export interface SrsResult extends SrsState {
  /** YYYY-MM-DD in the user's local calendar. */
  nextReview: string;
  state: "activo" | "dominado";
  /** True when the item was failed and sent back to the start of the ladder. */
  lapsed: boolean;
}

/**
 * Applies one grade (SM-2's `q`, 0–5) to an item's schedule.
 *
 * Pure and total: no clock, no database, no I/O. Everything that decides when
 * the user next sees an item is in this function, which is what makes the
 * behaviour testable and easy to reason about later.
 */
export function schedule(current: SrsState, grade: number, today: string): SrsResult {
  const q = clamp(Math.round(grade), 0, 5);

  if (q < PASS_GRADE) {
    // A failure costs ease and sends the item back to tomorrow. It does NOT
    // reset ease to default: the history of finding this item hard is exactly
    // what should keep its future intervals short.
    const ease = clamp(current.ease - 0.2, EASE_MIN, EASE_MAX);
    return {
      ease,
      interval: 1,
      repetitions: 0,
      mastery: Math.max(0, current.mastery - 1),
      nextReview: addDays(today, 1),
      state: "activo",
      lapsed: true,
    };
  }

  // Standard SM-2 ease adjustment: a perfect answer nudges ease up, a laboured
  // one nudges it down, and q=4 leaves it essentially unchanged.
  const ease = clamp(
    current.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
    EASE_MIN,
    EASE_MAX,
  );

  const repetitions = current.repetitions + 1;
  const base = LADDER[Math.min(repetitions - 1, LADDER.length - 1)];
  const interval = Math.max(1, Math.round(base * (ease / EASE_DEFAULT)));
  const mastery = clamp(repetitions, 0, 5);

  return {
    ease,
    interval,
    repetitions,
    mastery,
    nextReview: addDays(today, interval),
    state: repetitions >= MASTERY_REPETITIONS ? "dominado" : "activo",
    lapsed: false,
  };
}

/** Starting state for a newly captured mistake or vocabulary item. */
export function initialState(): SrsState {
  return { ease: EASE_DEFAULT, interval: 1, repetitions: 0, mastery: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
