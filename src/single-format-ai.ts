// Adapters between workers-ai-provider and Workers AI's Llama 3.3 output.

/**
 * The result of a non-streaming `AI.run()`, in either format: the native
 * `response` field or OpenAI-style `choices[0].message.content`. In JSON
 * mode this may already be a parsed object.
 */
export function readAiOutput(output: unknown): unknown {
  const o = output as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  } | null;
  return o?.response ?? o?.choices?.[0]?.message?.content;
}

/** The text of a non-streaming `AI.run()` result ("" if there is none). */
export function readAiText(output: unknown): string {
  const value = readAiOutput(output);
  return typeof value === "string" ? value : "";
}

/**
 * Wraps the AI binding to smooth over two Workers AI quirks:
 *
 * 1. Llama 3.3 streams each chunk in two formats at once: the native
 *    `response` / `tool_calls` fields and OpenAI-style `choices[0].delta`.
 *    workers-ai-provider (3.3.1) reads both, so every token and tool-call
 *    argument arrives twice. The wrapper drops the native fields from any
 *    chunk that also carries `choices[0].delta`.
 * 2. Workers AI rejects `tools: []` ("omit the field entirely"), which the
 *    provider sends when a step disables all tools. The wrapper omits it.
 *
 * Remove once workers-ai-provider handles both.
 */
export function withSingleFormatStream(ai: Ai): Ai {
  const run = async (...args: unknown[]) => {
    const inputs = args[1] as Record<string, unknown> | undefined;
    if (Array.isArray(inputs?.tools) && inputs.tools.length === 0) {
      const { tools: _tools, tool_choice: _toolChoice, ...rest } = inputs;
      args = [args[0], rest, ...args.slice(2)];
    }
    const result: unknown = await (
      ai.run as (...a: unknown[]) => Promise<unknown>
    )(...args);
    if (result instanceof ReadableStream) {
      return result.pipeThrough(dropNativeDuplicates());
    }
    if (result instanceof Response && result.body) {
      return new Response(
        result.body.pipeThrough(dropNativeDuplicates()),
        result
      );
    }
    return result;
  };

  return new Proxy(ai, {
    get(target, prop) {
      if (prop === "run") return run;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function dropNativeDuplicates(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const fixLine = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    try {
      const chunk = JSON.parse(payload);
      if (chunk.choices?.[0]?.delta) {
        delete chunk.response;
        delete chunk.tool_calls;
        return `data: ${JSON.stringify(chunk)}`;
      }
    } catch {
      // Not JSON: pass through untouched
    }
    return line;
  };

  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${fixLine(line)}\n`));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(fixLine(buffer)));
    }
  });
}
