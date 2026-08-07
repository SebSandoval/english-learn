/**
 * Tests for the reminder's tone, and for the milestone rule in particular.
 *
 *   npx tsx --test lib/engagement/nudge-tone.test.mts
 *
 * The bug these pin down was silent for months: MILESTONES was computed and
 * never passed, so celebration fired on a bare `current >= 7`. Since a reminder
 * only goes out on a day with no practice yet, that condition was true every
 * time — every reminder past day 7 was a celebration, and the milestones
 * themselves never landed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideTone } from "./nudge-tone";
import type { StreakState } from "./streak";

const MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365];

function streak(over: Partial<StreakState> = {}): StreakState {
  const current = over.current ?? 1;
  return {
    current,
    best: current,
    lastPractice: "2026-08-06",
    daysSince: 1,
    totalSessions: current,
    broken: false,
    milestone: MILESTONES.includes(current) ? current : null,
    ...over,
  };
}

describe("decideTone", () => {
  it("celebrates on a milestone day", () => {
    assert.equal(decideTone(streak({ current: 7 })).tone, "celebracion");
    assert.equal(decideTone(streak({ current: 30 })).tone, "celebracion");
  });

  it("does NOT celebrate on the days between milestones", () => {
    for (const current of [8, 12, 13, 29]) {
      assert.equal(
        decideTone(streak({ current })).tone,
        "suave",
        `a ${current}-day streak should be an invitation, not a party`,
      );
    }
  });

  it("never celebrates a streak that is already broken", () => {
    const dropped = streak({ current: 0, daysSince: 4, broken: true, milestone: null });
    assert.equal(decideTone(dropped).tone, "firme");
  });

  it("escalates with the gap, and always offers the escape hatch when firm", () => {
    assert.equal(decideTone(streak({ current: 2, daysSince: 2 })).tone, "directo");

    const firm = decideTone(streak({ current: 0, daysSince: 9, broken: true, milestone: null }));
    assert.equal(firm.tone, "firme");
    assert.equal(firm.offerQuickMode, true);
  });

  it("treats a first-ever nudge as its own case, with no gap to name", () => {
    const fresh = decideTone(
      streak({ current: 0, lastPractice: null, daysSince: null, totalSessions: 0, milestone: null }),
    );
    assert.equal(fresh.tone, "suave");
    assert.equal(fresh.offerQuickMode, true);
    assert.match(fresh.guidance, /FIRST practice message/);
  });
});
