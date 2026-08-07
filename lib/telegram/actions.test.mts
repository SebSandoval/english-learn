/**
 * Tests for the reminder buttons.
 *
 *   npx tsx --test lib/telegram/actions.test.mts
 *
 * `callback_data` is echoed back by Telegram from whoever pressed the button,
 * so `isAction` is a trust boundary: it decides what the webhook is willing to
 * act on. The rest checks that the offer a student sees matches the mode the
 * reminder actually opened for them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACTIONS, isAction, nudgeKeyboard } from "./actions";

const labels = (kb: ReturnType<typeof nudgeKeyboard>) => kb.flat().map((b) => b.text);
const data = (kb: ReturnType<typeof nudgeKeyboard>) => kb.flat().map((b) => b.callback_data);

describe("isAction", () => {
  it("accepts exactly the three known tokens", () => {
    assert.deepEqual(Object.values(ACTIONS).map(isAction), [true, true, true]);
  });

  it("rejects anything else that arrives on the wire", () => {
    for (const bad of ["", "GO", "go ", "start:free_conversation", "../go", undefined]) {
      assert.equal(isAction(bad), false, `${JSON.stringify(bad)} must not be actionable`);
    }
  });
});

describe("nudgeKeyboard", () => {
  it("names the mode the reminder opened", () => {
    assert.match(labels(nudgeKeyboard("listening", false))[0], /Listen/);
    assert.match(labels(nudgeKeyboard("spaced_review", false))[0], /Review/);
    assert.match(labels(nudgeKeyboard("voice_drill", false))[0], /Speak/);
  });

  it("puts the two-minute option beside the real ask, not under it", () => {
    const kb = nudgeKeyboard("free_conversation", true);
    assert.equal(kb[0].length, 2, "the escape hatch shares the row with the yes");
    assert.deepEqual(data(kb), [ACTIONS.go, ACTIONS.quick, ACTIONS.snooze]);
  });

  it("omits it when the tone doesn't offer it", () => {
    const kb = nudgeKeyboard("free_conversation", false);
    assert.deepEqual(data(kb), [ACTIONS.go, ACTIONS.snooze]);
  });

  it("keeps every payload inside Telegram's 64-byte limit", () => {
    for (const d of data(nudgeKeyboard("free_conversation", true))) {
      assert.ok(Buffer.byteLength(d) <= 64, `${d} is too long for callback_data`);
    }
  });
});
