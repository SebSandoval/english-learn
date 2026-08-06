import { NextResponse } from "next/server";
import { z } from "zod";

import { activeSession, getOrCreateUser, openSession, startSession } from "@/lib/db/queries";
import type { Session, User } from "@/lib/db/types";
import { openingTurn, processTurn } from "@/lib/modes";
import { openingInstruction, startReview } from "@/lib/modes/spaced-review";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  chat_id: z.number(),
  text: z.string().min(1).max(4000),
  name: z.string().optional(),
  /**
   * Opens a session in this mode when none is open. Without it the endpoint
   * defaults to free conversation, which makes the other modes unreachable
   * outside Telegram.
   */
  mode: z.enum(["free_conversation", "spaced_review"]).optional(),
  /** Abandons any open session and starts fresh. */
  restart: z.boolean().optional(),
});

/**
 * Text conversation, mode-aware.
 *
 * The Telegram webhook calls `processTurn` directly; this route exists so the
 * conversation can be exercised without Telegram, and for a future web frontend.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { chat_id, text, name, mode, restart } = parsed.data;

  try {
    const user = await getOrCreateUser(chat_id, name);
    const resolved = await resolveSession(user, mode, restart ?? false);

    if (!resolved) {
      return NextResponse.json(
        { error: "nothing due for review", mode: "spaced_review" },
        { status: 409 },
      );
    }

    const { session, opening } = resolved;

    // A session that was just created needs the tutor to speak first, exactly
    // as /review does in Telegram. Treating the caller's text as an answer to a
    // question nobody asked would grade them on nothing.
    const reply = opening
      ? await openingTurn(user, session, opening)
      : await processTurn({ user, session, text });

    return NextResponse.json({
      reply: reply.reply,
      corrections: reply.corrections,
      new_vocab: reply.new_vocab,
      review_quality: reply.review_quality ?? null,
      end_session: reply.end_session,
      session_id: session.id,
      mode: session.modo,
    });
  } catch (e) {
    console.error("[/api/chat]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "internal error" },
      { status: 500 },
    );
  }
}

interface ResolvedSession {
  session: Session;
  /** Set when the session is brand new and the tutor must open it. */
  opening?: string;
}

/** Null means the requested mode had nothing to work with. */
async function resolveSession(
  user: User,
  mode: "free_conversation" | "spaced_review" | undefined,
  restart: boolean,
): Promise<ResolvedSession | null> {
  if (!restart) {
    const open = await openSession(user.id);
    // An open session wins over the requested mode: switching mid-conversation
    // would silently discard the turn the user is in the middle of.
    if (open) return { session: open };
  }

  if (mode === "spaced_review") {
    const started = await startReview(user);
    return started
      ? { session: started.session, opening: openingInstruction(started.context) }
      : null;
  }

  if (mode) return { session: await startSession(user.id, mode) };

  return { session: await activeSession(user.id, "free_conversation") };
}
