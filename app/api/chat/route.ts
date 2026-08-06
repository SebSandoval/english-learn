import { NextResponse } from "next/server";
import { z } from "zod";

import { activeSession, getOrCreateUser } from "@/lib/db/queries";
import { processTurn } from "@/lib/modes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  chat_id: z.number(),
  text: z.string().min(1).max(4000),
  name: z.string().optional(),
});

/**
 * FREE CONVERSATION mode over text.
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

  const { chat_id, text, name } = parsed.data;

  try {
    const user = await getOrCreateUser(chat_id, name);
    const session = await activeSession(user.id, "free_conversation");
    const reply = await processTurn({ user, session, text });

    return NextResponse.json({
      reply: reply.reply,
      corrections: reply.corrections,
      new_vocab: reply.new_vocab,
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
