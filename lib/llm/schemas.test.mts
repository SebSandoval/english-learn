/**
 * Tests for the tutor's JSON parser.
 *
 *   npx tsx --test lib/llm/schemas.test.mts
 *
 * The two long fixtures below are verbatim from the chat on 2026-08-18, where
 * they went out as the tutor's own words: a reasoning model's scratchpad, and
 * an object cut off by the token limit. Everything here exists so that neither
 * is ever a reply again — either we recover a real one, or we return null and
 * the caller tries the next model.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTutorReply } from "./schemas";

/** What the student saw the first time: gpt-oss thinking, no JSON anywhere. */
const CHAIN_OF_THOUGHT = `We need to respond in English only, with corrections and new vocab as needed. The user's last message: "Oh great! Answering your question, I'd getaway to the paramo de santurban". Need to correct any errors. Let's analyze.

Errors: "I'd getaway" should be "I'd go on a getaway" or "I'd get away". Also "full of wild" maybe "full of wildlife".

Now new vocab: maybe teach "getaway", "wildlife". We'll add a couple.

new_vocab items:

1. term:`;

/** The second time: valid JSON, stopped mid-word when max_tokens ran out. */
const TRUNCATED = `{
  "reply": "The frailejon is iconic - those silver rosettes catch the mist. Have you seen them up close?",
  "corrections": [
    {
      "type": "gramatica",
      "pattern": "uses singular demonstrative 'that' with plural noun",
      "wrong_example": "All that things together",
      "correction": "All those things together",
      "explanation": "'Those' is the plural form of 'that' and must agree with 'things'."
    }
  ],
  "new_vocab": [
    {
      "term": "frailejon",
      "type": "palabra",
      "example_en": "The frailejon is a high-altitude plant with fuzzy leaves."
    },
    {
      "term":`;

describe("parseTutorReply", () => {
  it("reads a clean object", () => {
    const reply = parseTutorReply('{"reply":"Hi there!","corrections":[],"new_vocab":[]}');
    assert.equal(reply?.reply, "Hi there!");
    assert.deepEqual(reply?.corrections, []);
    assert.equal(reply?.end_session, false);
  });

  it("unwraps a markdown fence", () => {
    const reply = parseTutorReply('```json\n{"reply":"Fenced."}\n```');
    assert.equal(reply?.reply, "Fenced.");
  });

  it("ignores prose after the object", () => {
    const reply = parseTutorReply('{"reply":"Done."}\n\nLet me know if you want more detail!');
    assert.equal(reply?.reply, "Done.");
  });

  it("drops a <think> block", () => {
    const reply = parseTutorReply('<think>They wrote "I am agree" again.</think>{"reply":"Sure."}');
    assert.equal(reply?.reply, "Sure.");
  });

  it("is not fooled by braces and quotes inside strings", () => {
    const reply = parseTutorReply('{"reply":"Use {} for a block, and \\"quote\\" like this."}');
    assert.equal(reply?.reply, 'Use {} for a block, and "quote" like this.');
  });

  it("refuses thinking that never became an answer", () => {
    assert.equal(parseTutorReply(CHAIN_OF_THOUGHT), null);
  });

  it("refuses an object with no reply in it", () => {
    assert.equal(parseTutorReply('{"corrections":[],"new_vocab":[]}'), null);
    assert.equal(parseTutorReply('{"reply":"   "}'), null);
  });

  it("saves the reply and the whole fields of a truncated object", () => {
    const reply = parseTutorReply(TRUNCATED);
    assert.match(reply!.reply, /^The frailejon is iconic/);
    assert.equal(reply!.corrections.length, 1);
    assert.equal(reply!.corrections[0].pattern, "uses singular demonstrative 'that' with plural noun");
    // The complete vocabulary item survives; the one cut in half does not.
    assert.equal(reply!.new_vocab.length, 1);
    assert.equal(reply!.new_vocab[0].term, "frailejon");
  });

  it("refuses a reply that was itself cut in half", () => {
    assert.equal(parseTutorReply('{"reply":"Sounds great, and the thing about that is'), null);
  });

  it("keeps the reply when an item inside it is malformed", () => {
    const reply = parseTutorReply(
      '{"reply":"Noted.","corrections":[{"type":"gramatica"},{"type":"nonsense","pattern":"omits the article","wrong_example":"I went to shop","correction":"I went to the shop"}]}',
    );
    assert.equal(reply?.reply, "Noted.");
    assert.equal(reply?.corrections.length, 1);
    // An unknown correction type is mapped back, not discarded.
    assert.equal(reply?.corrections[0].type, "uso");
  });

  it("keeps a grade only when it is a usable one", () => {
    assert.equal(parseTutorReply('{"reply":"Right!","review_quality":4}')?.review_quality, 4);
    assert.equal(parseTutorReply('{"reply":"Right!","review_quality":"good"}')?.review_quality, null);
    assert.equal(parseTutorReply('{"reply":"Right!","review_quality":9}')?.review_quality, null);
  });
});
