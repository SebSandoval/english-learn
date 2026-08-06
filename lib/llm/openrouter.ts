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

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Total budget for a turn. Must stay under the route's maxDuration of 60s. */
const TOTAL_BUDGET_MS = 50_000;
/** Cap for any single attempt, so one hung model can't eat the whole budget. */
const ATTEMPT_CAP_MS = 22_000;
/** Passes over the model list. Free models fail transiently; one retry is worth it. */
const ROUNDS = 2;

/**
 * Calls OpenRouter, walking a list of models until one answers.
 *
 * Free models fail constantly and in varied ways: 429 when saturated, 503 when
 * the upstream is down, empty responses, and plain timeouts. The whole point of
 * this function is that none of those reach the user.
 */
export async function callLlm(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<string> {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const models = modelChain();
  const deadline = options.deadline ?? Date.now() + TOTAL_BUDGET_MS;

  let lastError: Error | null = null;

  for (let round = 0; round < ROUNDS; round++) {
    for (const model of models) {
      const remaining = deadline - Date.now();
      if (remaining < 3_000) {
        throw new LlmUnavailableError(
          `Out of time after ${lastError ? lastError.message : "no attempts"}`,
        );
      }

      try {
        return await request(apiKey, model, messages, options, Math.min(remaining, ATTEMPT_CAP_MS));
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`[openrouter] ${model} (round ${round + 1}) failed: ${lastError.message}`);
      }
    }
  }

  throw new LlmUnavailableError(`All models failed. Last error: ${lastError?.message}`);
}

/**
 * Both env vars accept a comma-separated list, so the chain can be extended
 * without a code change when a given free model starts misbehaving.
 */
function modelChain(): string[] {
  const raw = [env.OPENROUTER_MODEL, env.OPENROUTER_MODEL_FALLBACK]
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  return [...new Set(raw)];
}

async function request(
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  options: LlmOptions,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "English Push",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 900,
        // Reasoning models (gpt-oss et al.) otherwise spend the whole token
        // budget thinking and return an empty content field.
        reasoning: { exclude: true },
        // Free models don't always honour response_format; the defensive
        // parsing in parseTutorReply() is the real safety net.
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
