/**
 * Measures latency and JSON reliability of free OpenRouter models against the
 * REAL tutor system prompt.
 *
 * Short synthetic prompts are misleading — they made gpt-oss-20b look fine at
 * 2s when it actually fails on the full prompt. Always benchmark with the real
 * thing. Free-tier quality drifts, so re-run this whenever replies degrade and
 * reorder LLM_CHAIN accordingly.
 *
 * It only covers the OpenRouter half of the chain. Before blaming quality,
 * check that every model in LLM_CHAIN still exists — see AGENTS.md, "A dead
 * entry in the chain is invisible".
 *
 *   npx tsx scripts/bench-models.mts
 */
import { readFileSync } from "node:fs";

import { buildTutorPrompt } from "../lib/llm/prompts/tutor";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("Missing OPENROUTER_API_KEY in .env.local");
  process.exit(1);
}

const system = buildTutorPrompt({
  level: "intermedio",
  mode: "free_conversation",
  name: "Seb",
});

const messages = [
  { role: "system", content: system },
  {
    role: "user",
    content:
      "Yesterday I go to a conference and I learn many things. I am agree that " +
      "indexes are important, but I dont understand why my query is slow. Can you explain me?",
  },
];

/** Add or remove candidates freely; the list is only a starting point. */
const models = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
];

console.log(`System prompt: ~${Math.round(system.length / 4)} tokens\n`);

for (const model of models) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 60_000);

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.85,
        max_tokens: 900,
        reasoning: { exclude: true },
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(to);

    const ms = Date.now() - t0;
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content?.trim();

    let verdict = `EMPTY ${JSON.stringify(json.error?.message ?? "").slice(0, 60)}`;
    if (content) {
      try {
        const parsed = JSON.parse(content);
        const patterns = (parsed.corrections ?? []).map((c: { pattern: string }) => c.pattern);
        // Patterns are the real quality signal: they must be general rules, not
        // quotes of what the student wrote. Eyeball them on every run.
        verdict = `ok · ${patterns.length} corr · ${JSON.stringify(patterns)}`;
      } catch {
        verdict = "invalid JSON";
      }
    }

    console.log(`${String(ms).padStart(6)}ms  ${model.padEnd(40)} ${res.status}  ${verdict}`);
  } catch (e) {
    console.log(
      `${String(Date.now() - t0).padStart(6)}ms  ${model.padEnd(40)} FAIL ${(e as Error).message}`,
    );
  }
}
