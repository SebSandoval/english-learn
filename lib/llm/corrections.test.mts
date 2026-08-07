/**
 * Tests for the stale-correction filter.
 *
 *   npx tsx --test lib/llm/corrections.test.mts
 *
 * The real case is transcribed from a session where the same two notes arrived
 * on three consecutive messages: the model re-mined turns it had already
 * corrected, because its own notes are never part of the history it sees.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { freshCorrections, quotesFrom } from "./corrections";
import type { Correction } from "./schemas";

function correction(over: Partial<Correction> = {}): Correction {
  return {
    type: "gramatica",
    pattern: "false friend: uses 'justo' instead of 'just'",
    wrong_example: "justo vibe coding",
    correction: "just vibe coding",
    ...over,
  };
}

describe("quotesFrom", () => {
  it("matches ignoring case and punctuation", () => {
    assert.equal(quotesFrom("just vibe coding", "I'm Just vibe-coding, honestly!"), true);
  });

  it("survives a lightly reworded quote", () => {
    assert.equal(quotesFrom("I not am reviewing changes", "I not am reviewing the changes"), true);
  });

  it("rejects a quote from an earlier turn", () => {
    assert.equal(
      quotesFrom("justo vibe coding", "What I said, is I'm not reviewing, just approving! haha"),
      false,
    );
  });

  it("rejects an invented quote", () => {
    assert.equal(quotesFrom("I have 25 years", "Sounds good to me"), false);
  });

  it("rejects everything when there is no student message", () => {
    assert.equal(quotesFrom("just vibe coding", ""), false);
  });
});

describe("freshCorrections", () => {
  it("keeps what the student actually just wrote", () => {
    const kept = freshCorrections([correction()], "yesterday I was justo vibe coding all day");
    assert.equal(kept.length, 1);
  });

  it("drops the note that already went out on a previous turn", () => {
    const kept = freshCorrections(
      [correction(), correction({ pattern: "approve", wrong_example: "approve all changes" })],
      "What I said, is I'm not reviewing, just approving! haha",
    );
    assert.deepEqual(kept, []);
  });

  it("collapses two entries for the same rule into one", () => {
    const text = "justo vibe coding and justo approving";
    const kept = freshCorrections(
      [correction(), correction({ wrong_example: "justo approving" })],
      text,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.wrong_example, "justo vibe coding");
  });
});
