import type {
  ModelMessage,
  StreamTextTransform,
  TextStreamPart,
  ToolSet
} from "ai";

/** "I don't need to call any function for this prompt." and the like. */
export function isToolTalk(sentence: string): boolean {
  const aboutCalls =
    /\bfunctions?\b|\b(function|tool) ?calls?\b|\bcall (a |any |the )?tools?\b/i;
  const negatedOrMeta =
    /\b(no|not|none)\b|n't|\bthis (prompt|request|question|message)\b/i;
  return aboutCalls.test(sentence) && negatedOrMeta.test(sentence);
}

/**
 * Some Workers AI backends for Llama 3.3 use a tool-calling template that
 * tells the model to point out when no function applies, so it sometimes
 * replies "I don't need to call any function for this prompt." instead of
 * answering. Prompting alone doesn't stop it.
 *
 * This transform holds back the first sentence of each text block and drops
 * it if it talks about tools. If nothing else was said, `fallback()` writes a
 * plain reply (with no tools offered) in its place, so the user never sees
 * the remark.
 */
export function dropToolTalk<TOOLS extends ToolSet>(
  fallback: () => Promise<string>
): StreamTextTransform<TOOLS> {
  return () => {
    type Block = {
      buffer: string;
      decided: boolean;
      dropped: boolean;
      said: boolean;
    };
    const blocks = new Map<string, Block>();

    const emit = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      id: string,
      block: Block,
      text: string
    ) => {
      if (!text) return;
      block.said ||= text.trim().length > 0;
      controller.enqueue({ type: "text-delta", id, text });
    };

    // Decide on the first sentence; `end` is its last index, or -1 for all
    const decide = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      id: string,
      block: Block,
      end: number
    ) => {
      const first = end >= 0 ? block.buffer.slice(0, end + 1) : block.buffer;
      const rest = block.buffer.slice(first.length);
      block.decided = true;
      block.buffer = "";
      if (isToolTalk(first)) {
        block.dropped = true;
        emit(controller, id, block, rest.trimStart());
      } else {
        emit(controller, id, block, first + rest);
      }
    };

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      async transform(part, controller) {
        if (part.type === "text-start") {
          blocks.set(part.id, {
            buffer: "",
            decided: false,
            dropped: false,
            said: false
          });
          controller.enqueue(part);
          return;
        }
        if (part.type === "text-delta") {
          const block = blocks.get(part.id);
          if (!block || block.decided) {
            if (block?.dropped && !block.said) {
              // Don't start the reply with the space after a dropped sentence
              emit(controller, part.id, block, part.text.trimStart());
              return;
            }
            if (block) block.said ||= part.text.trim().length > 0;
            controller.enqueue(part);
            return;
          }
          block.buffer += part.text;
          const end = block.buffer.search(/[.!?](?=\s|$)|\n/);
          // Wait for the whole first sentence (or give up after 300 chars)
          if (end === -1 && block.buffer.length < 300) return;
          decide(controller, part.id, block, end);
          return;
        }
        if (part.type === "text-end") {
          const block = blocks.get(part.id);
          if (block && !block.decided) decide(controller, part.id, block, -1);
          if (block?.dropped && !block.said) {
            const text = await fallback().catch(() => "");
            emit(controller, part.id, block, text);
          }
          controller.enqueue(part);
          return;
        }
        controller.enqueue(part);
      }
    });
  };
}

/** User and assistant text only, for a plain reply with no tools offered. */
export function toPlainChat(
  messages: ModelMessage[]
): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
    if (content.trim()) out.push({ role: message.role, content });
  }
  return out;
}
