// Turning a chat reply into something worth hearing. Shared by the server
// (Aura-2) and the browser fallback (speechSynthesis).

import type { UIMessage } from "ai";

/** Spoken replies are capped: text-to-speech is billed per character. */
export const MAX_SPOKEN_CHARS = 600;

/** The plain text of a message's text parts (tool calls are skipped). */
export function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

/**
 * Markdown → plain sentences: no asterisks, link URLs or code read aloud.
 * Long replies are cut at the last full sentence before `maxChars`.
 */
export function toSpeechText(
  markdown: string,
  maxChars = MAX_SPOKEN_CHARS
): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullets
    .replace(/^\s*\d+[.)]\s+/gm, "") // numbered lists
    .replace(/\|/g, " ") // table pipes
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, "$2") // bold, italic, strike
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/([:;,.!?])\.(\s|$)/g, "$1$2") // no "." after existing punctuation
    .replace(/\s{2,}/g, " ")
    .trim();

  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const lastSentence = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? ")
  );
  if (lastSentence > maxChars * 0.4) return cut.slice(0, lastSentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}
