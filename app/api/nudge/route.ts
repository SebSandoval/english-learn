import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import type { User } from "@/lib/db/types";
import { nudgeUser, type NudgeOutcome } from "@/lib/engagement/nudge";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by the external cron every 30 minutes.
 *
 * Vercel Hobby only allows one cron run per day, which is useless for a
 * time-window reminder, so the schedule lives in GitHub Actions and this
 * endpoint stays dumb enough to be safe at any firing time: it re-derives
 * whether each user is due rather than trusting the clock that called it.
 *
 * `?dry=1` reports what it would do without sending anything.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") ?? bearer(req);

  if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun = url.searchParams.get("dry") === "1";

  const { data: users, error } = await db()
    .from("usuarios")
    .select("*")
    .eq("activo", true);

  if (error) {
    console.error("[/api/nudge] could not load users:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Array<NudgeOutcome | { userId: string; error: string }> = [];

  // Sequential on purpose: this runs for a handful of users and hammering the
  // free LLM tier in parallel is the fastest way to get rate-limited.
  for (const user of (users ?? []) as User[]) {
    try {
      results.push(dryRun ? await preview(user) : await nudgeUser(user));
    } catch (e) {
      console.error(`[/api/nudge] user ${user.id}:`, e);
      results.push({ userId: user.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    checked: results.length,
    sent: results.filter((r) => "sent" in r && r.sent).length,
    results,
  });
}

function bearer(req: Request): string | null {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

/** Same decision path as a real run, minus the LLM call and the send. */
async function preview(user: User): Promise<NudgeOutcome> {
  const { decideTone } = await import("@/lib/engagement/nudge-tone");
  const { readStreak } = await import("@/lib/engagement/streak");
  const { chooseMode } = await import("@/lib/modes/selector");
  const { localDate, localTime, localWeekday, withinWindow } = await import(
    "@/lib/engagement/time"
  );

  const now = new Date();
  const today = localDate(user.zona_horaria, now);

  if (!user.dias_activos.includes(localWeekday(user.zona_horaria, now))) {
    return { sent: false, userId: user.id, reason: "rest-day" };
  }
  if (!withinWindow(localTime(user.zona_horaria, now), user.ventana_inicio, user.ventana_fin)) {
    return { sent: false, userId: user.id, reason: "outside-window" };
  }

  const streak = await readStreak(user);
  if (streak.lastPractice === today) {
    return { sent: false, userId: user.id, reason: "practised-today" };
  }

  const choice = await chooseMode(user);
  const decision = decideTone(streak, null);

  return {
    sent: true,
    userId: user.id,
    tone: decision.tone,
    mode: choice.mode,
    daysSince: streak.daysSince,
  };
}
