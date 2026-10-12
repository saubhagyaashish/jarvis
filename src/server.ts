import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { withSingleFormatStream } from "./single-format-ai";
import {
  MAX_OUTPUT_TOKENS,
  MODEL,
  buildSystemPrompt,
  extractNewFacts,
  fitHistory,
  isValidTimezone,
  newId,
  textOf,
  type Fact,
  type JarvisState,
  type Memory,
  type Note,
  type Task
} from "./memory";

/**
 * One JarvisAgent (a Durable Object) per user. It owns all of that user's
 * data: chat history (persisted by AIChatAgent), small UI state in `state`,
 * and long-term memory in its own SQLite tables.
 */
export class JarvisAgent extends AIChatAgent<Env, JarvisState> {
  initialState: JarvisState = { timezone: "UTC" };
  maxPersistedMessages = 100;
  chatRecovery = true;

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, source_msg TEXT, created_at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at TEXT, done INTEGER NOT NULL DEFAULT 0)`;
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)`;
  }

  // ── Memory reads and writes ──────────────────────────────────────────

  private readMemory(): Memory {
    return {
      facts: this
        .sql<Fact>`SELECT id, text, created_at FROM facts ORDER BY created_at, rowid`,
      tasks: this.sql<Task>`SELECT id, title, due_at, done FROM tasks
        ORDER BY done, due_at IS NULL, due_at, rowid`,
      notes: this
        .sql<Note>`SELECT id, body, created_at FROM notes ORDER BY created_at, rowid`
    };
  }

  /** Tell open tabs to refetch the panel; `added` lets the UI show a toast. */
  private memoryChanged(added?: string[]) {
    this.broadcast(JSON.stringify({ type: "memory-changed", added }));
  }

  private deleteFact(id: string): boolean {
    const found = this.sql`SELECT id FROM facts WHERE id = ${id}`.length > 0;
    this.sql`DELETE FROM facts WHERE id = ${id}`;
    if (found) this.memoryChanged();
    return found;
  }

  private setTaskDone(id: string, done: boolean): boolean {
    const found = this.sql`SELECT id FROM tasks WHERE id = ${id}`.length > 0;
    this.sql`UPDATE tasks SET done = ${done ? 1 : 0} WHERE id = ${id}`;
    if (found) this.memoryChanged();
    return found;
  }

  // ── Callable methods used by the side panel ──────────────────────────

  @callable()
  getMemory(): Memory {
    return this.readMemory();
  }

  @callable()
  setTimezone(timezone: string) {
    if (typeof timezone !== "string" || !isValidTimezone(timezone)) return;
    if (timezone !== this.state.timezone)
      this.setState({ ...this.state, timezone });
  }

  @callable()
  removeFact(id: string): boolean {
    return this.deleteFact(String(id));
  }

  @callable()
  toggleTask(id: string, done: boolean): boolean {
    return this.setTaskDone(String(id), Boolean(done));
  }

  @callable()
  removeTask(id: string): boolean {
    const found =
      this.sql`SELECT id FROM tasks WHERE id = ${String(id)}`.length > 0;
    this.sql`DELETE FROM tasks WHERE id = ${String(id)}`;
    if (found) this.memoryChanged();
    return found;
  }

  @callable()
  removeNote(id: string): boolean {
    const found =
      this.sql`SELECT id FROM notes WHERE id = ${String(id)}`.length > 0;
    this.sql`DELETE FROM notes WHERE id = ${String(id)}`;
    if (found) this.memoryChanged();
    return found;
  }

  // ── Chat ─────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withSingleFormatStream(this.env.AI)
    });
    const system = buildSystemPrompt(this.readMemory(), this.state.timezone);

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system,
      // Fit the newest messages into the 24K context, then prune old tool calls
      messages: pruneMessages({
        messages: await convertToModelMessages(
          fitHistory(this.messages, system)
        ),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        forget_fact: tool({
          description:
            "Delete a fact from long-term memory when the user asks you to forget it.",
          inputSchema: z.object({
            id: z.string().describe("The fact id, e.g. f-1a2b3c4d")
          }),
          needsApproval: true,
          execute: async ({ id }) =>
            this.deleteFact(id) ? `Forgot ${id}.` : `No fact with id ${id}.`
        }),

        add_task: tool({
          description:
            "Create a task for the user, optionally with a due date-time.",
          inputSchema: z.object({
            title: z.string().min(1).max(200),
            due_at: z
              .string()
              .optional()
              .describe("Local ISO 8601 date-time, e.g. 2026-10-13T15:00")
          }),
          execute: async ({ title, due_at }) => {
            const due = due_at?.trim() || null;
            if (due && Number.isNaN(Date.parse(due))) {
              return `Invalid due_at "${due}". Use the format 2026-10-13T15:00.`;
            }
            const id = newId("t");
            this
              .sql`INSERT INTO tasks (id, title, due_at) VALUES (${id}, ${title.trim()}, ${due})`;
            this.memoryChanged();
            return { id, title, due_at: due };
          }
        }),

        complete_task: tool({
          description: "Mark a task as done.",
          inputSchema: z.object({
            id: z.string().describe("The task id, e.g. t-1a2b3c4d")
          }),
          execute: async ({ id }) =>
            this.setTaskDone(id, true)
              ? `Completed ${id}.`
              : `No task with id ${id}.`
        }),

        add_note: tool({
          description:
            "Save a note, only when the user explicitly asks to save or note something down. Never use it to store facts about the user; those are saved automatically.",
          inputSchema: z.object({ body: z.string().min(1).max(2000) }),
          execute: async ({ body }) => {
            const id = newId("n");
            this.sql`INSERT INTO notes (id, body, created_at)
              VALUES (${id}, ${body.trim()}, ${new Date().toISOString()})`;
            this.memoryChanged();
            return { id };
          }
        })
      },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Low cap so a confused model can't loop on a failing tool call
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Fact extraction (after each turn, off the reply's critical path) ──

  protected async onChatResponse(result: ChatResponseResult) {
    // Continuations (e.g. after a tool approval) reuse the same user message
    if (result.status !== "completed" || result.continuation) return;
    const lastUser = [...this.messages]
      .reverse()
      .find((m) => m.role === "user");
    const text = lastUser ? textOf(lastUser) : "";
    if (!lastUser || !text) return;
    // The built-in queue persists the job and retries it if it throws
    await this.queue("extractFacts", { messageId: lastUser.id, text });
  }

  async extractFacts(payload: { messageId: string; text: string }) {
    // Already processed (e.g. a retried job after a successful insert)
    if (
      this.sql`SELECT id FROM facts WHERE source_msg = ${payload.messageId}`
        .length > 0
    ) {
      return;
    }
    const known = this.sql<Fact>`SELECT id, text, created_at FROM facts`.map(
      (f) => f.text
    );
    const facts = await extractNewFacts(this.env.AI, payload.text, known);
    const now = new Date().toISOString();
    for (const text of facts) {
      this.sql`INSERT INTO facts (id, text, source_msg, created_at)
        VALUES (${newId("f")}, ${text}, ${payload.messageId}, ${now})`;
    }
    console.log(
      JSON.stringify({
        event: "facts_extracted",
        count: facts.length,
        known: known.length
      })
    );
    if (facts.length > 0) this.memoryChanged(facts);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
