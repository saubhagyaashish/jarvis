// Fallback from Workers AI to Ollama Cloud when the account's free daily
// Workers AI allocation is used up. Llama 3.3 on Workers AI stays the
// primary model; Ollama only answers while the limit is in effect.
//
// It works at the AI-binding level: the request Workers AI would have
// received is sent to Ollama's OpenAI-compatible endpoint instead, and its
// response (OpenAI-format JSON or SSE) is returned as-is. workers-ai-provider
// and readAiOutput() already parse that format, so every call site (chat,
// fact extraction, briefing) gets the fallback without other changes.

const OLLAMA_URL = "https://ollama.com/v1/chat/completions";

type FallbackEnv = Env & { OLLAMA_API_KEY?: string; OLLAMA_MODEL?: string };

export type FallbackHooks = {
  /** True while the limit is known to be in effect: skip Workers AI. */
  isLimited?: () => boolean;
  /** Workers AI just reported the daily limit. */
  onLimit?: (fallbackModel: string | null) => void;
  /** Workers AI answered again (the limit has reset). */
  onPrimaryOk?: () => void;
};

/** Workers AI error 4006: the account's daily free neurons are used up. */
export function isDailyLimitError(error: unknown): boolean {
  const e = error as { message?: unknown; cause?: { message?: unknown } };
  const text = `${String(e?.message ?? error)} ${String(e?.cause?.message ?? "")}`;
  return /\b4006\b|daily free allocation/i.test(text);
}

/** The free allocation resets at 00:00 UTC. */
export function nextDailyReset(now = Date.now()): string {
  const d = new Date(now);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  ).toISOString();
}

/** The Ollama model to fall back to, or null when no API key is configured. */
export function fallbackModel(env: Env): string | null {
  const { OLLAMA_API_KEY, OLLAMA_MODEL } = env as FallbackEnv;
  return OLLAMA_API_KEY ? OLLAMA_MODEL || "gpt-oss:120b" : null;
}

/** A Workers AI `run()` input, rewritten for Ollama's chat completions API. */
export function toOllamaRequest(
  inputs: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const { messages, tools, max_tokens, temperature, stream, response_format } =
    inputs;
  return {
    model,
    messages,
    // Ollama doesn't support tool_choice, and an empty list means "no tools"
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    // Reasoning models spend output tokens thinking; leave room to answer
    max_tokens: Math.max(Number(max_tokens) || 0, 1024),
    ...(temperature !== undefined ? { temperature } : {}),
    stream: Boolean(stream),
    // Workers AI's json_schema shape differs from OpenAI's; JSON mode is
    // enough, since the prompt spells out the expected object
    ...(response_format ? { response_format: { type: "json_object" } } : {}),
    reasoning_effort: "low"
  };
}

async function runOnOllama(
  env: Env,
  model: string,
  inputs: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(env as FallbackEnv).OLLAMA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(toOllamaRequest(inputs, model))
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Ollama fallback failed (${response.status}): ${(await response.text()).slice(0, 300)}`
    );
  }
  return inputs.stream ? response.body : response.json();
}

/** Wrap the AI binding so a daily-limit error falls back to Ollama. */
export function withOllamaFallback(
  ai: Ai,
  env: Env,
  hooks: FallbackHooks = {}
): Ai {
  const model = fallbackModel(env);

  const run = async (...args: unknown[]) => {
    const inputs = (args[1] ?? {}) as Record<string, unknown>;
    if (model && hooks.isLimited?.()) return runOnOllama(env, model, inputs);
    try {
      const result: unknown = await (
        ai.run as (...a: unknown[]) => Promise<unknown>
      )(...args);
      hooks.onPrimaryOk?.();
      return result;
    } catch (error) {
      if (!isDailyLimitError(error)) throw error;
      hooks.onLimit?.(model);
      console.warn(
        JSON.stringify({ event: "workers_ai_daily_limit", fallback: model })
      );
      if (!model) throw error;
      return runOnOllama(env, model, inputs);
    }
  };

  return new Proxy(ai, {
    get(target, prop) {
      if (prop === "run") return run;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
