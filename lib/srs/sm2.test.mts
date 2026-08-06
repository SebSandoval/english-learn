/**
 * Tests for the scheduler.
 *
 *   npx tsx --test lib/srs/sm2.test.mts
 *
 * Worth testing directly because the consequences play out over weeks: a bug
 * here surfaces as "why did it ask me that again tomorrow?" a month later,
 * which is impossible to debug from the chat.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialState, schedule } from "./sm2";

const TODAY = "2026-08-06";

describe("schedule", () => {
  it("walks a perfect run up the ladder", () => {
    let state = initialState();
    const intervals: number[] = [];

    for (let i = 0; i < 6; i++) {
      const result = schedule(state, 5, TODAY);
      intervals.push(result.interval);
      state = result;
    }

    // Base ladder is 1/3/7/15/30/60, stretched by a rising ease factor.
    assert.deepEqual(intervals, [1, 3, 8, 17, 34, 67]);
  });

  it("reaches mastery after six passes and stops being active", () => {
    let state = initialState();
    let result = schedule(state, 4, TODAY);

    for (let i = 0; i < 5; i++) {
      assert.equal(result.state, "activo", `still active at rep ${i + 1}`);
      state = result;
      result = schedule(state, 4, TODAY);
    }

    assert.equal(result.repetitions, 6);
    assert.equal(result.state, "dominado");
    assert.equal(result.mastery, 5, "mastery caps at 5");
  });

  it("sends a failed item back to tomorrow", () => {
    const advanced = { ease: 2.6, interval: 30, repetitions: 4, mastery: 4 };
    const result = schedule(advanced, 1, TODAY);

    assert.equal(result.interval, 1);
    assert.equal(result.repetitions, 0);
    assert.equal(result.nextReview, "2026-08-07");
    assert.equal(result.lapsed, true);
    assert.equal(result.mastery, 3, "mastery drops by one, not to zero");
  });

  it("remembers difficulty across a lapse", () => {
    // The point of keeping ease low after a failure: relearning an item you
    // have failed before must not get the same generous intervals as an item
    // you have always known.
    const struggled = schedule(schedule(initialState(), 0, TODAY), 0, TODAY);
    assert.ok(struggled.ease < 2.5, "ease decays with each failure");

    const relearned = schedule(struggled, 5, TODAY);
    const fresh = schedule(initialState(), 5, TODAY);
    assert.ok(
      relearned.ease < fresh.ease,
      "a previously failed item stays harder than a fresh one",
    );
  });

  it("keeps ease inside its bounds under extremes", () => {
    let worst = initialState();
    for (let i = 0; i < 20; i++) worst = schedule(worst, 0, TODAY);
    assert.ok(worst.ease >= 1.3, `ease floor held: ${worst.ease}`);

    let best = initialState();
    for (let i = 0; i < 20; i++) best = schedule(best, 5, TODAY);
    assert.ok(best.ease <= 2.8, `ease ceiling held: ${best.ease}`);
  });

  it("never schedules anything in the past or today", () => {
    for (let grade = 0; grade <= 5; grade++) {
      const result = schedule(initialState(), grade, TODAY);
      assert.ok(result.interval >= 1, `grade ${grade} gave interval ${result.interval}`);
      assert.ok(result.nextReview > TODAY, `grade ${grade} scheduled ${result.nextReview}`);
    }
  });

  it("treats the pass boundary at 3", () => {
    assert.equal(schedule(initialState(), 2, TODAY).lapsed, true);
    assert.equal(schedule(initialState(), 3, TODAY).lapsed, false);
  });

  it("clamps out-of-range grades instead of producing nonsense", () => {
    assert.equal(schedule(initialState(), 99, TODAY).lapsed, false);
    assert.equal(schedule(initialState(), -5, TODAY).lapsed, true);
  });

  it("crosses month boundaries correctly", () => {
    const state = { ease: 2.5, interval: 15, repetitions: 4, mastery: 4 };
    const result = schedule(state, 4, "2026-08-25");
    assert.equal(result.interval, 30);
    assert.equal(result.nextReview, "2026-09-24");
  });
});
