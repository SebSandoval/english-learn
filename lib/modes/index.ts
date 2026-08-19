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
import { callLlm, callLlmJson, type LlmMessage } from "@/lib/llm/chat";
import { freshCorrections } from "@/lib/llm/corrections";
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
  /**
   * Absolute epoch-ms deadline for this turn's LLM work.
   *
   * Voice turns arrive here having already spent seconds on download and
   * transcription, and still owe time for synthesis. Without this the LLM
   * would start its own 50s budget from scratch and the function would be
   * killed before the student got an answer.
   */
  deadline?: number;
}

/** Below this, compressing the history is not worth delaying the reply for. */
const SUMMARY_BUDGET_MS = 9_000;

/**
 * Room for the longest turn the tutor ever writes — a LISTENING passage plus
 * three corrections and three vocabulary items — and for the thinking a
 * reasoning model spends from the same budget before it starts writing.
 *
 * The default of 900 was not enough: on 2026-08-18 an ordinary conversation
 * turn came back at finish_reason "length", cut off inside "new_vocab". Unused
 * tokens cost nothing, a truncated reply costs the turn.
 */
const TUTOR_MAX_TOKENS = 1_400;

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

  const reply = await callLlmJson(messages, parseTutorReply, {
    temperature: 0.85,
    maxTokens: TUTOR_MAX_TOKENS,
    deadline: input.deadline,
  });

  // The history the model sees carries no record of what it already corrected,
  // so it re-corrects older turns. Anything not quoting THIS message goes.
  reply.corrections = freshCorrections(reply.corrections, text);

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

  await compressIfNeeded(session, input.deadline);

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
async function compressIfNeeded(session: Session, deadline?: number): Promise<void> {
  const total = await countMessages(session.id);
  if (total < SUMMARY_THRESHOLD || total % MESSAGE_WINDOW !== 0) return;

  // This runs before the student sees their reply, so on a turn that is
  // already late we skip it. The next multiple of MESSAGE_WINDOW picks it up,
  // and a slightly longer prompt beats a turn that times out.
  if (deadline && deadline - Date.now() < SUMMARY_BUDGET_MS) {
    console.warn("[summary] skipped: not enough time left in the turn");
    return;
  }

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
      {
        temperature: 0.3,
        maxTokens: 250,
        deadline: deadline ? Math.min(deadline, Date.now() + SUMMARY_BUDGET_MS) : undefined,
      },
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

  const reply = await callLlmJson(
    [
      { role: "system", content: system },
      { role: "user", content: instruction },
    ],
    parseTutorReply,
    { temperature: 0.9, maxTokens: TUTOR_MAX_TOKENS },
  );

  // Nobody has said anything yet: any correction here is about a message that
  // does not exist.
  reply.corrections = [];

  await saveMessage(session.id, "assistant", reply.reply);
  await updateSessionContext(session.id, session.contexto);

  return reply;
}
