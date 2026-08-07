import type { NudgeTone } from "@/lib/db/types";
import type { StreakState } from "@/lib/engagement/streak";

export interface ToneDecision {
  tone: NudgeTone;
  /** Offer the 2-minute escape hatch: better a token session than a broken habit. */
  offerQuickMode: boolean;
  /** Instructions handed to the LLM to write the actual message. */
  guidance: string;
}

/**
 * Picks how hard to push, based on how long they've been away.
 *
 * The design constraint that matters: pressure is aimed at the ACTION, never at
 * the person. A reminder that reads as an accusation gets muted, and a muted
 * bot teaches nobody. Every firm message therefore carries a true positive fact
 * alongside the push.
 */
export function decideTone(streak: StreakState): ToneDecision {
  const { daysSince, milestone } = streak;

  // Never practised. There is no gap to point at and no streak to protect, so
  // none of the pressure rungs apply — scolding someone for a habit they haven't
  // started yet is the fastest way to lose them on day one.
  if (streak.lastPractice === null || daysSince === null) {
    return {
      tone: "suave",
      offerQuickMode: true,
      guidance: `This is their FIRST practice message — they have never had a session with you.
Never reference days, gaps, streaks or absence: there is no history to refer to and
inventing one would be obviously false. Introduce yourself in one line, make the
first ask tiny and concrete, and make it feel like the start of something rather
than a task. Three sentences maximum.`,
    };
  }

  // Standing on a milestone: lead with the win, not the warning.
  //
  // Only on the milestone itself. The old rule also fired on any streak of 7 or
  // more, and since a reminder only goes out on a day they haven't practised
  // yet, `daysSince <= 1` was true every single time — so past day 7 every
  // reminder forever was a celebration, and the congratulation stopped meaning
  // anything exactly when they'd invested the most in it.
  if (milestone !== null && daysSince <= 1) {
    return {
      tone: "celebracion",
      offerQuickMode: false,
      guidance: `They're on a ${streak.current}-day streak — genuinely good. Open by naming it,
specifically and without gushing. Then hand them today's practice. Two or three
sentences total. Do not warn them about anything; they've earned a clean win today.`,
    };
  }

  if (daysSince <= 1) {
    return {
      tone: "suave",
      offerQuickMode: false,
      guidance: `They practised recently — this is an invitation, not a reminder. Do NOT mention
the streak, do NOT mention days, do NOT imply they're falling behind. Just show up
with something interesting and pull them into it. Lead with the hook itself: an
opinion, an odd fact, a question. Two or three sentences.`,
    };
  }

  if (daysSince <= 3) {
    return {
      tone: "directo",
      offerQuickMode: true,
      guidance: `It's been ${daysSince} days. Be direct and say so plainly, in one clause,
without drama or disappointment. ${
        streak.current > 0
          ? `Their ${streak.current}-day streak is on the line today — name that stake once.`
          : `Don't invent a streak; they don't have one running. Frame it as restarting.`
      }
Then give them something concrete they can answer in one message. Attach the
practice to the nudge so there's nothing to decide — the ask should be one reply,
not a commitment. Three sentences maximum.`,
    };
  }

  return {
    tone: "firme",
    offerQuickMode: true,
    guidance: `It's been ${daysSince} days. Acknowledge the gap once, flatly, and then drop
it — no guilt, no lecture, no "I've been waiting". Guilt is what makes people mute
a bot instead of answering it.

Lower the bar out loud: offer a two-minute version, one question, one reply. Say
explicitly that a small session counts and beats another day of nothing.

You MUST include one true, specific positive fact from their history — it is
supplied in the context below. Use it to make the point that the work they already
did is still there waiting, not lost. Four sentences maximum.`,
  };
}
