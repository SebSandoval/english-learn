import "server-only";

import { NextResponse } from "next/server";

import { env } from "@/lib/env";

/**
 * Guards the endpoints that spend money without being the product.
 *
 * `/api/chat` and `/api/voice` exist to exercise the LLM and the audio
 * providers from a terminal. Left open they are a free synthesis API on
 * someone else's credit, and `/api/chat` also writes a row to `usuarios` for
 * any chat id it's handed — which the nudge cron then pays an LLM call to
 * write a message for, every half hour, forever.
 *
 * The secret travels the same three ways as the cron's, so an existing curl
 * only needs `?secret=` appended.
 */
export function denyUnauthorized(req: Request): NextResponse | null {
  const expected = env.ADMIN_SECRET ?? env.CRON_SECRET;

  if (!expected) {
    // No secret configured anywhere: refuse rather than fall open. These
    // endpoints have no legitimate anonymous use.
    return NextResponse.json(
      { error: "ADMIN_SECRET (or CRON_SECRET) is not configured; this endpoint is closed" },
      { status: 503 },
    );
  }

  const provided =
    new URL(req.url).searchParams.get("secret") ??
    req.headers.get("x-admin-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  return provided === expected
    ? null
    : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
