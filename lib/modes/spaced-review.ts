import "server-only";

import { startSession, updateSessionContext } from "@/lib/db/queries";
import type { Session, SrsItemType, User } from "@/lib/db/types";
import { applyGrade, buildQueue, type ReviewItem } from "@/lib/srs/queue";

/**
 * After this many turns without a usable grade we move on anyway.
 *
 * Without it, a model that keeps omitting `review_quality` traps the user on
 * the same item forever — a stalled session is a worse failure than one
 * ungraded answer.
 */
const MAX_UNGRADED_TURNS = 2;

export interface ReviewContext {
  items: ReviewItem[];
  index: number;
  ungraded: number;
}

export function readContext(session: Session): ReviewContext | null {
  const raw = (session.contexto as { review?: unknown }).review;
  if (!raw || typeof raw !== "object") return null;

  const ctx = raw as Partial<ReviewContext>;
  if (!Array.isArray(ctx.items)) return null;

  return { items: ctx.items, index: ctx.index ?? 0, ungraded: ctx.ungraded ?? 0 };
}

/** Opens a review session, or returns null when nothing is due. */
export async function startReview(user: User): Promise<{ session: Session; context: ReviewContext } | null> {
  const items = await buildQueue(user);
  if (!items.length) return null;

  const context: ReviewContext = { items, index: 0, ungraded: 0 };
  const session = await startSession(user.id, "spaced_review", { review: context });

  return { session, context };
}

/**
 * Applies the tutor's grade to the current item and moves the queue forward.
 *
 * Returns the updated context, or null once the queue is exhausted — the
 * caller closes the session on null.
 */
export async function advance(
  user: User,
  session: Session,
  context: ReviewContext,
  grade: number | null | undefined,
  gradedItemId?: string | null,
): Promise<ReviewContext | null> {
  const current = context.items[context.index];
  if (!current) return null;

  if (typeof grade === "number") {
    // Trust the id the tutor reported over our own index — it knows what it
    // actually asked. Only fall back to the index when no id came back.
    const target = gradedItemId
      ? context.items.find((i) => i.id === gradedItemId)
      : current;

    if (!target) {
      // An id we don't recognise means the tutor invented one. Grading the
      // current item anyway would be a guess, and a wrong guess here is worse
      // than a missed review.
      console.warn(`[srs] tutor reported unknown item ${gradedItemId}; skipping grade`);
    } else {
      await applyGrade(user, { id: target.id, type: target.type as SrsItemType }, grade, session.id);
      if (target.id !== current.id) {
        console.warn(`[srs] tutor graded ${target.id} while queue pointed at ${current.id}`);
      }
    }
  } else {
    const ungraded = context.ungraded + 1;
    if (ungraded < MAX_UNGRADED_TURNS) {
      // Stay on this item: the student may simply not have answered it yet.
      const held = { ...context, ungraded };
      await updateSessionContext(session.id, { ...session.contexto, review: held });
      return held;
    }
    console.warn(`[srs] advancing past ${current.id} without a grade`);
  }

  const next: ReviewContext = { items: context.items, index: context.index + 1, ungraded: 0 };
  if (next.index >= next.items.length) return null;

  await updateSessionContext(session.id, { ...session.contexto, review: next });
  return next;
}

/**
 * Renders the review state for the system prompt.
 *
 * Only the current and next items are exposed. Handing the model the whole
 * queue invites it to leak later answers into the current question.
 */
export function describeContext(context: ReviewContext): string {
  const current = context.items[context.index];
  const next = context.items[context.index + 1];
  const position = `${context.index + 1} of ${context.items.length}`;

  const lines = [
    "## Review queue",
    `You are on item ${position}. These come from this student's own history.`,
    "",
    "### The item you are testing RIGHT NOW",
    describe(current),
    "",
    "The student's last message is their attempt at this item. Grade it in",
    '"review_quality" (0-5), give brief feedback in "reply", then immediately ask',
    "the next item below. One message, no waiting.",
  ];

  if (next) {
    lines.push("", "### Ask this next", describe(next));
  } else {
    lines.push(
      "",
      "### This is the last item",
      "After your feedback, close the session: one line on how they did overall,",
      'nothing else. Set "end_session" to true.',
    );
  }

  return lines.join("\n");
}

/** The prompt for the very first exercise, before the student has said anything. */
export function openingInstruction(context: ReviewContext): string {
  const current = context.items[context.index];
  return [
    `Start the review. ${context.items.length} item${context.items.length === 1 ? "" : "s"} today.`,
    "Say in one short line that this is review of things they've got wrong before,",
    "then go straight into the first exercise. Don't list what's coming.",
    "",
    "### First item",
    describe(current),
    "",
    'Set "review_quality" to null — you are asking, not grading.',
  ].join("\n");
}

function describe(item: ReviewItem): string {
  const parts = [
    `id: ${item.id}   <- copy this into "review_item_id" when you grade this item`,
    item.type === "error"
      ? `Type: mistake pattern — ${item.label}`
      : `Type: vocabulary — "${item.label}"`,
    `Target answer (do NOT show this): ${item.correct}`,
  ];

  if (item.wrongExample) parts.push(`They originally wrote: "${item.wrongExample}"`);
  if (item.explanation) parts.push(`Note: ${item.explanation}`);

  parts.push(
    `Mastery ${item.mastery}/5${item.timesSeen > 1 ? `, missed ${item.timesSeen} times` : ""}.`,
  );

  return parts.join("\n");
}
