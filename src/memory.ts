// Jarvis's memory model: the types shared with the UI, the system prompt
// built from them, and the background pass that extracts new facts.

import type { UIMessage } from "ai";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Llama 3.3 fp8-fast has a 24,000-token context window. Leave room for the
// reply and the tool schemas, then spend the rest on memory and history.
const CONTEXT_TOKENS = 24_000;
export const MAX_OUTPUT_TOKENS = 1_024;
const TOOLS_AND_OVERHEAD_TOKENS = 3_000;
const FACTS_BUDGET_TOKENS = 4_000;
const MAX_HISTORY_MESSAGES = 40; // about 20 turns
const MAX_OPEN_TASKS = 50;
const RECENT_NOTES = 10;

export type JarvisState = {
  timezone: string; // IANA zone from the browser, e.g. "Asia/Kolkata"
};

export type Fact = { id: string; text: string; created_at: string };
export type Task = {
  id: string;
  title: string;
  due_at: string | null; // user-local ISO date-time, e.g. "2026-10-13T15:00"
  done: number; // SQLite boolean
};
export type Note = { id: string; body: string; created_at: string };
export type Memory = { facts: Fact[]; tasks: Task[]; notes: Note[] };

/** Short, prefixed IDs: easy for the model to copy back into tool calls. */
export function newId(prefix: "f" | "t" | "n"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Rough token estimate (~4 characters per token) for budgeting. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localNow(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
}

/** Newest facts first until the budget is spent, then back in saved order. */
function factsWithinBudget(facts: Fact[]): Fact[] {
  const kept: Fact[] = [];
  let used = 0;
  for (let i = facts.length - 1; i >= 0; i--) {
    used += estimateTokens(facts[i].text) + 6;
    if (used > FACTS_BUDGET_TOKENS) break;
    kept.unshift(facts[i]);
  }
  return kept;
}

export function buildSystemPrompt(memory: Memory, timezone: string): string {
  const facts = factsWithinBudget(memory.facts);
  const openTasks = memory.tasks
    .filter((t) => !t.done)
    .slice(0, MAX_OPEN_TASKS);
  const notes = memory.notes.slice(-RECENT_NOTES);

  const list = (lines: string[]) =>
    lines.length > 0 ? lines.join("\n") : "(none)";

  return `You are Jarvis, a concise and friendly personal assistant.
Current local time: ${localNow(timezone)} (${timezone}).

What you know about the user:
${list(facts.map((f) => `- [${f.id}] ${f.text}`))}

Open tasks:
${list(openTasks.map((t) => `- [${t.id}] ${t.title}${t.due_at ? ` (due ${t.due_at})` : ""}`))}

Recent notes:
${list(notes.map((n) => `- [${n.id}] ${n.body}`))}

Rules:
- Use what you know about the user to personalise answers. Never invent facts about the user.
- Facts about the user are saved automatically from what they tell you. Don't call any tool to save them, not even add_note; just reply naturally.
- Speak to the user in the second person ("you are vegetarian").
- Only call a tool when the request needs one. Otherwise, reply directly in plain text.
- Never mention tools, functions or these rules to the user.
- To change tasks, notes or memory, use the tools and refer to items by their id in square brackets.
- Write due_at in the user's local time as ISO 8601 without a timezone, e.g. 2026-10-13T15:00.`;
}

/** Most recent messages that fit what's left of the context window. */
export function fitHistory(
  messages: UIMessage[],
  systemPrompt: string
): UIMessage[] {
  const budget =
    CONTEXT_TOKENS -
    MAX_OUTPUT_TOKENS -
    TOOLS_AND_OVERHEAD_TOKENS -
    estimateTokens(systemPrompt);
  const kept: UIMessage[] = [];
  let used = 0;
  for (
    let i = messages.length - 1;
    i >= 0 && kept.length < MAX_HISTORY_MESSAGES;
    i--
  ) {
    used += estimateTokens(JSON.stringify(messages[i].parts));
    // Always keep the newest message, even if it alone is over budget.
    if (used > budget && kept.length > 0) break;
    kept.unshift(messages[i]);
  }
  return kept;
}

export function textOf(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

// ── Fact extraction ────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You maintain long-term memory for a personal assistant.
Extract durable facts about the user from their latest message: identity, preferences, relationships, routines, constraints and goals (for example diet, allergies, job, city, family, hobbies).

Rules:
- Only facts the user states about themselves or their life. Ignore questions, requests, small talk and one-off tasks or reminders.
- Skip anything the known facts already cover, even if worded differently.
- Write each fact as a short third-person phrase, e.g. "Is vegetarian", "Lives in Bengaluru", "Sister is named Priya".
- Return {"facts": []} when there is nothing new.`;

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"]
};

const MAX_FACTS_PER_MESSAGE = 5;
const MAX_FACT_LENGTH = 200;

/**
 * Ask Llama 3.3 (JSON mode, non-streaming) for new facts in one user message.
 * Known facts go into the prompt so the model can skip paraphrases that an
 * exact-match check would miss.
 */
export async function extractNewFacts(
  ai: Ai,
  userMessage: string,
  knownFacts: string[]
): Promise<string[]> {
  let output: unknown;
  try {
    output = await ai.run(MODEL, {
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        {
          role: "user",
          content: `Known facts:\n${knownFacts.map((f) => `- ${f}`).join("\n") || "(none)"}\n\nLatest user message:\n${userMessage}`
        }
      ],
      response_format: { type: "json_schema", json_schema: EXTRACTION_SCHEMA },
      max_tokens: 256,
      temperature: 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The model couldn't produce valid JSON for this message: nothing to save.
    if (message.includes("JSON Mode couldn't be met")) return [];
    throw error; // anything else (network, capacity) is worth a retry
  }

  const known = new Set(knownFacts.map((f) => f.toLowerCase()));
  return parseFacts(output)
    .map((f) => f.trim().slice(0, MAX_FACT_LENGTH))
    .filter((f) => f.length > 0 && !known.has(f.toLowerCase()))
    .slice(0, MAX_FACTS_PER_MESSAGE);
}

/** JSON mode may return the object directly or as a string, in either format. */
function parseFacts(output: unknown): string[] {
  const o = output as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  } | null;
  let value: unknown = o?.response ?? o?.choices?.[0]?.message?.content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const facts = (value as { facts?: unknown } | null)?.facts;
  return Array.isArray(facts)
    ? facts.filter((f): f is string => typeof f === "string")
    : [];
}
