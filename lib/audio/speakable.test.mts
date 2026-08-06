/**
 * Tests for the text-to-speech sanitiser.
 *
 *   npx tsx --test lib/audio/speakable.test.mts
 *
 * Worth testing because the failure is invisible from the code: everything
 * looks fine in the logs, and the only symptom is the student hearing
 * "asterisk asterisk" in the middle of a listening passage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { speakable } from "./speakable";

describe("speakable", () => {
  it("drops markdown emphasis without eating the words", () => {
    assert.equal(speakable("That's **really** not how *native* speakers say it."), "That's really not how native speakers say it.");
  });

  it("strips HTML that leaked in from the Telegram formatter", () => {
    assert.equal(speakable("<b>Nice</b> one &amp; keep going"), "Nice one and keep going");
  });

  it("removes emoji", () => {
    assert.equal(speakable("Good catch 🎯 keep going 🔥"), "Good catch keep going");
  });

  it("turns em dashes into a spoken pause", () => {
    assert.equal(speakable("It works — barely"), "It works, barely");
  });

  it("flattens bullets into sentences", () => {
    assert.equal(speakable("Pick one:\n- Postgres\n- Mongo"), "Pick one: Postgres Mongo");
  });

  it("makes a paragraph break audible as a full stop", () => {
    assert.equal(speakable("First thought.\n\nSecond thought."), "First thought. Second thought.");
  });

  it("drops code fences entirely rather than spelling them out", () => {
    assert.equal(speakable("Try this:\n```\nSELECT 1;\n```\nMake sense?"), "Try this: Make sense?");
  });

  it("leaves clean prose untouched", () => {
    const clean = "So, what's the worst bug you shipped this year?";
    assert.equal(speakable(clean), clean);
  });
});
