import "server-only";

import {
  MESSAGE_WINDOW,
  SUMMARY_THRESHOLD,
  closeOpenSessions,
  countMessages,
  latestSummary,
  recentHistory,
  recordCorrections,
  recordVocabulary,
  saveMessage,
  saveSummary,
  updateSessionContext,
} from "@/lib/db/queries";
import type { Session, User } from "@/lib/db/types";
import { markNudgeAnswered, registerPractice } from "@/lib/engagement/streak";
import { callLlm, type LlmMessage } from "@/lib/llm/openrouter";
import { buildTutorPrompt } from "@/lib/llm/prompts/tutor";
import { parseTutorReply, type TutorReply } from "@/lib/llm/schemas";
import {
  advance as advanceReview,
  describeContext as describeReview,
  readContext as readReviewContext,
} from "@/lib/modes/spaced-review";

export interface TurnInput {
  user: User;
  session: Session;
  text: string;
  wasAudio?: boolean;
  audioPath?: string;
  /** Current streak, so the tutor can acknowledge it when relevant. */
  streak?: number;
}

/**
 * One full conversation turn, shared by every mode.
 *
 * The mode changes the system prompt and the context, not the flow: save input →
 * build bounded context → call the LLM → persist extractions → return.
 */
export async function processTurn(input: TurnInput): Promise<TutorReply> {
  const { user, session, text } = input;

  await saveMessage(session.id, "user", text, {
    wasAudio: input.wasAudio,
    audioPath: input.audioPath,
  });

  // Any user turn counts as practice, in any mode. Idempotent within the day.
  const [streak, history, previousSummary] = await Promise.all([
    registerPractice(user),
    recentHistory(session.id, MESSAGE_WINDOW),
    session.resumen ? Promise.resolve(session.resumen) : latestSummary(user.id),
  ]);

  // Closes the loop on the reminder that produced this session, so we can tell
  // which tones actually get answered.
  if (session.contexto?.from_nudge) {
    await markNudgeAnswered(session.id).catch(() => {});
  }

  const system = buildTutorPrompt({
    level: user.nivel,
    mode: session.modo,
    name: user.nombre,
    streak: input.streak ?? streak.current,
    previousSummary,
    context: serializeModeContext(session),
  });

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    ...history.map((m) => ({
      role: m.rol as "user" | "assistant",
      content: m.contenido,
    })),
  ];

  const raw = await callLlm(messages, { json: true, temperature: 0.85 });
  const reply = parseTutorReply(raw);

  await saveMessage(session.id, "assistant", reply.reply);

  // Extraction must never take down the turn: if it fails, the user already has
  // their answer and we only lose this exchange's SRS material.
  await Promise.all([
    recordCorrections(user.id, reply.corrections).catch((e) =>
      console.error("[srs] corrections:", e),
    ),
    recordVocabulary(user.id, session.id, reply.new_vocab).catch((e) =>
      console.error("[srs] vocabulary:", e),
    ),
  ]);

  await compressIfNeeded(session);

  // Review scheduling happens after the reply is built, so a grading failure
  // can never cost the student their answer.
  const queueExhausted = await gradeIfReviewing(user, session, reply);

  if (reply.end_session || queueExhausted) {
    await closeOpenSessions(user.id);
  }

  return reply;
}

/** Returns true when the review queue just ran out and the session should close. */
async function gradeIfReviewing(
  user: User,
  session: Session,
  reply: TutorReply,
): Promise<boolean> {
  if (session.modo !== "spaced_review") return false;

  const context = readReviewContext(session);
  if (!context) return false;

  try {
    const next = await advanceReview(
      user,
      session,
      context,
      reply.review_quality,
      reply.review_item_id,
    );
    return next === null;
  } catch (e) {
    console.error("[srs] grading failed:", e);
    return false;
  }
}

/**
 * Serializes the mode's context for the prompt.
 *
 * Spaced review gets a hand-written rendering rather than raw JSON: the model
 * must see the current item and the next one, and must NOT see the rest of the
 * queue, or it leaks upcoming answers into the current question.
 */
function serializeModeContext(session: Session): string | undefined {
  if (session.modo === "spaced_review") {
    const review = readReviewContext(session);
    return review ? describeReview(review) : undefined;
  }

  const ctx = session.contexto;
  if (!ctx || Object.keys(ctx).length === 0) return undefined;
  return `## Mode context\n${JSON.stringify(ctx, null, 2)}`;
}

/**
 * Once a session gets long, compress the older turns into a summary.
 *
 * Without this the context would grow without bound. With it, the LLM always
 * receives "last 12 turns + summary of everything before", which is constant cost.
 */
async function compressIfNeeded(session: Session): Promise<void> {
  const total = await countMessages(session.id);
  if (total < SUMMARY_THRESHOLD || total % MESSAGE_WINDOW !== 0) return;

  try {
    const history = await recentHistory(session.id, SUMMARY_THRESHOLD);
    const transcript = history
      .map((m) => `${m.rol === "user" ? "Student" : "Coach"}: ${m.contenido}`)
      .join("\n");

    const summary = await callLlm(
      [
        {
          role: "system",
          content:
            "Summarize this English tutoring conversation in under 120 words. " +
            "Keep: topics discussed, what the student struggled with, and any " +
            "personal facts they shared (job, interests, plans) that would make " +
            "a later conversation feel continuous. Plain prose, no JSON.",
        },
        { role: "user", content: transcript },
      ],
      { temperature: 0.3, maxTokens: 250 },
    );

    await saveSummary(session.id, summary.trim());
  } catch (e) {
    console.error("[summary] compression failed:", e);
  }
}

/** Kicks off a mode: the tutor speaks first, with no prior user turn. */
export async function openingTurn(
  user: User,
  session: Session,
  instruction: string,
  streak?: number,
): Promise<TutorReply> {
  const system = buildTutorPrompt({
    level: user.nivel,
    mode: session.modo,
    name: user.nombre,
    streak,
    previousSummary: await latestSummary(user.id),
    context: serializeModeContext(session),
  });

  const raw = await callLlm(
    [
      { role: "system", content: system },
      { role: "user", content: instruction },
    ],
    { json: true, temperature: 0.9 },
  );

  const reply = parseTutorReply(raw);
  await saveMessage(session.id, "assistant", reply.reply);
  await updateSessionContext(session.id, session.contexto);

  return reply;
}
