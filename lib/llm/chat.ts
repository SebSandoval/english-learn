import { env, requireEnv } from "@/lib/env";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  /**
   * Absolute epoch-ms deadline for the whole call, including retries.
   *
   * Needed because the LLM is not always the first thing a request does. A
   * voice turn spends seconds downloading and transcribing audio first, and
   * then still owes time for synthesis afterwards; a budget measured from
   * "now" would silently overrun the route's maxDuration and get the function
   * killed mid-reply. Callers that know when the request started pass that.
   */
  deadline?: number;
}

/**
 * Every model in the chain failed or ran out of time.
 *
 * Typed so the webhook can tell "the free models are having a bad minute,
 * retrying will probably work" apart from a real bug, and say so.
 */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

/**
 * The providers we can reach. Both speak the OpenAI chat-completions dialect,
 * which is the only reason one `request()` serves both.
 *
 * Crossing providers — not just models — is what makes the chain worth having.
 * A chain entirely inside OpenRouter shares one daily free quota, so when that
 * quota runs out every entry returns 429 at once and the fallback is worth
 * nothing. Groq's quota is counted separately.
 */
const PROVIDERS = {
  groq: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    keyVar: "GROQ_API_KEY",
    /** OpenRouter-only; Groq rejects unknown top-level fields on some models. */
    excludeReasoning: false,
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    keyVar: "OPENROUTER_API_KEY",
    // Reasoning models otherwise spend the whole token budget thinking and
    // return an empty content field.
    excludeReasoning: true,
  },
} as const satisfies Record<string, ProviderConfig>;

type ProviderName = keyof typeof PROVIDERS;

interface ProviderConfig {
  endpoint: string;
  keyVar: "GROQ_API_KEY" | "OPENROUTER_API_KEY";
  excludeReasoning: boolean;
}

interface ChainEntry {
  provider: ProviderName;
  model: string;
}

/**
 * Groq's gpt-oss models reason before answering, and that costs twice: the
 * chain of thought comes back in its own field, and it is spent from the same
 * max_tokens as the answer.
 *
 * Both bit us on 2026-08-18, on the same day and for the same reason — the
 * chain's first entry had been retired upstream, so every turn landed here.
 * The thinking leaked into the chat when no JSON followed it, and a plain
 * conversation turn hit finish_reason "length" mid-object at 900 tokens.
 * Measured on the real tutor prompt: 900 tokens and truncated at the default
 * effort, 590 tokens and complete at "low" — with a better reply, since none of
 * the budget went on deliberating about a chat message.
 *
 * Sent only to the models that accept them: Groq 400s on a parameter a model
 * does not support, and other reasoning families take different values
 * (qwen3 wants none|default, not low|medium|high).
 */
const GROQ_REASONING_MODELS = /gpt-oss/i;

function reasoningParams(entry: ChainEntry): Record<string, unknown> {
  if (entry.provider !== "groq" || !GROQ_REASONING_MODELS.test(entry.model)) return {};
  return { reasoning_format: "hidden", reasoning_effort: "low" };
}

/** Total budget for a turn. Must stay under the route's maxDuration of 60s. */
const TOTAL_BUDGET_MS = 50_000;
/** Cap for any single attempt, so one hung model can't eat the whole budget. */
const ATTEMPT_CAP_MS = 22_000;
/** Passes over the model list. Free models fail transiently; one retry is worth it. */
const ROUNDS = 2;

/**
 * Walks a chain of provider/model pairs until one answers.
 *
 * Free models fail constantly and in varied ways: 429 when the daily quota is
 * spent, 503 when the upstream is down, empty responses, invalid JSON, and
 * plain timeouts. The whole point of this function is that none of those reach
 * the student.
 */
export async function callLlm(messages: LlmMessage[], options: LlmOptions = {}): Promise<string> {
  return walk(messages, options, (content) => content);
}

/**
 * Like callLlm, but the answer has to survive `parse` to count as an answer.
 *
 * A model that thinks out loud instead of replying, or gets cut off halfway
 * through the object, has failed its attempt exactly as much as one that
 * returned 503 — so it costs the chain a step, not the student a turn. Before
 * this, unparseable output was handed to the caller as prose and went out as
 * the tutor's own words.
 */
export async function callLlmJson<T>(
  messages: LlmMessage[],
  parse: (content: string) => T | null,
  options: LlmOptions = {},
): Promise<T> {
  return walk(messages, { ...options, json: true }, parse);
}

async function walk<T>(
  messages: LlmMessage[],
  options: LlmOptions,
  parse: (content: string) => T | null,
): Promise<T> {
  const chain = modelChain();
  const deadline = options.deadline ?? Date.now() + TOTAL_BUDGET_MS;

  let lastError: Error | null = null;

  for (let round = 0; round < ROUNDS; round++) {
    for (const entry of chain) {
      const remaining = deadline - Date.now();
      if (remaining < 3_000) {
        throw new LlmUnavailableError(
          `Out of time after ${lastError ? lastError.message : "no attempts"}`,
        );
      }

      try {
        const content = await request(
          entry,
          messages,
          options,
          Math.min(remaining, ATTEMPT_CAP_MS),
        );

        const parsed = parse(content);
        if (parsed === null) throw new Error(`unusable response: ${preview(content)}`);

        return parsed;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(
          `[llm] ${entry.provider}:${entry.model} (round ${round + 1}) failed: ${lastError.message}`,
        );
      }
    }
  }

  throw new LlmUnavailableError(`All models failed. Last error: ${lastError?.message}`);
}

/** Enough of a rejected response to tell prose, thinking and truncation apart in the logs. */
function preview(content: string): string {
  return JSON.stringify(content.replace(/\s+/g, " ").slice(0, 140));
}

/**
 * Parses the comma-separated chain, so it can be reordered without a deploy.
 *
 * Entries look like `groq:llama-3.3-70b-versatile`. The prefix is only treated
 * as a provider when it actually names one — model ids contain colons of their
 * own (`nvidia/nemotron-3-super-120b-a12b:free`), and splitting those would
 * produce a provider called "nvidia/nemotron-3-super-120b-a12b".
 *
 * Entries whose provider has no key configured are dropped rather than tried:
 * a guaranteed failure is not a fallback, it just burns budget.
 */
function modelChain(): ChainEntry[] {
  const raw = [env.LLM_CHAIN, env.OPENROUTER_MODEL, env.OPENROUTER_MODEL_FALLBACK]
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const chain: ChainEntry[] = [];

  for (const item of [...new Set(raw)]) {
    const colon = item.indexOf(":");
    const head = colon > 0 ? item.slice(0, colon) : "";
    const provider = (head in PROVIDERS ? head : "openrouter") as ProviderName;
    const model = head in PROVIDERS ? item.slice(colon + 1) : item;

    const key = `${provider}:${model}`;
    if (!model || seen.has(key)) continue;
    if (!env[PROVIDERS[provider].keyVar]) continue;

    seen.add(key);
    chain.push({ provider, model });
  }

  if (!chain.length) {
    throw new LlmUnavailableError(
      "No usable models: LLM_CHAIN is empty or no provider key is configured.",
    );
  }

  return chain;
}

/** Exposed for /api/health, so a deploy can show which chain it will actually use. */
export function describeChain(): string {
  try {
    return modelChain()
      .map((e) => `${e.provider}:${e.model}`)
      .join(", ");
  } catch {
    return "none";
  }
}

async function request(
  entry: ChainEntry,
  messages: LlmMessage[],
  options: LlmOptions,
  timeoutMs: number,
): Promise<string> {
  const config = PROVIDERS[entry.provider];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${requireEnv(config.keyVar)}`,
        "Content-Type": "application/json",
        "X-Title": "English Push",
      },
      body: JSON.stringify({
        model: entry.model,
        messages,
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 900,
        ...(config.excludeReasoning ? { reasoning: { exclude: true } } : {}),
        ...reasoningParams(entry),
        // Free models don't always honour response_format; parseTutorReply()
        // and the rejection above it are the real safety net.
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning?: string };
        finish_reason?: string;
      }>;
      error?: { message?: string };
    };

    if (data.error) throw new Error(data.error.message ?? "unknown error");

    const choice = data.choices?.[0];
    // Some reasoning models leave `content` empty and put everything in
    // `reasoning`. The answer is in there; take it rather than fail the turn.
    const content = choice?.message?.content?.trim() || choice?.message?.reasoning?.trim();

    if (!content) {
      throw new Error(`empty response (finish_reason: ${choice?.finish_reason ?? "none"})`);
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}
