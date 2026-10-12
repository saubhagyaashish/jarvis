/**
 * Workers AI streams Llama 3.3 chunks in two formats at once: the native
 * `response` / `tool_calls` fields and the OpenAI-style `choices[0].delta`.
 * workers-ai-provider (3.3.1) reads both, so every token and every tool-call
 * argument arrives twice — doubled text, and tool arguments that fail to parse.
 *
 * This wraps the AI binding and drops the native fields from any streamed
 * chunk that also carries `choices[0].delta`, so the provider sees each delta
 * once. Remove it once workers-ai-provider handles dual-format chunks.
 */
export function withSingleFormatStream(ai: Ai): Ai {
  const run = async (...args: unknown[]) => {
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
