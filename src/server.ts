import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage
} from "ai";
import { z } from "zod";
import { readAiText, withSingleFormatStream } from "./single-format-ai";
import { nextDailyReset, withOllamaFallback } from "./ai-fallback";
import { dropToolTalk, isToolTalk, toPlainChat } from "./tool-talk-filter";
import {
  MAX_OUTPUT_TOKENS,
  MODEL,
  buildSystemPrompt,
  extractNewFacts,
  fitHistory,
  newId,
  textOf,
  withoutOldToolCalls,
  type Briefing,
  type Fact,
  type JarvisState,
  type Memory,
  type Note,
  type Reminder,
  type Task
} from "./memory";
import {
  dailyCronUtc,
  formatLocal,
  isValidTimezone,
  localDate,
  localNow,
  localToUtc
} from "./time";
import type { BriefingContext } from "./briefing-workflow";

export { MorningBriefingWorkflow } from "./briefing-workflow";

const BRIEFING_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// A run still "running" after this long is assumed lost, so a new one may start
const BRIEFING_STALE_MS = 5 * 60_000;
const MAX_INBOX = 20;

/** Llama sometimes copies an id with its brackets: "[t-1a2b]" → "t-1a2b". */
function cleanId(id: string): string {
  return id.trim().replace(/^\[|\]$/g, "");
}

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

  // ── Model access ─────────────────────────────────────────────────────

  /**
   * The AI binding, falling back to Ollama while Workers AI's free daily
   * limit is used up. The limit is recorded in state, which drives the UI
   * banner and lets later calls skip Workers AI until it resets.
   */
  private ai(): Ai {
    return withOllamaFallback(this.env.AI, this.env, {
      isLimited: () => {
        const limit = this.state.aiLimit;
        return Boolean(limit && Date.parse(limit.until) > Date.now());
      },
      onLimit: (fallbackModel) => {
        const limit = this.state.aiLimit;
        if (limit && Date.parse(limit.until) > Date.now()) return;
        this.setState({
          ...this.state,
          aiLimit: { until: nextDailyReset(), fallbackModel }
        });
      },
      onPrimaryOk: () => {
        if (this.state.aiLimit) this.setState({ ...this.state, aiLimit: null });
      }
    });
  }

  // ── Memory reads and writes ──────────────────────────────────────────

  private async loadMemory(): Promise<Memory> {
    return {
      facts: this
        .sql<Fact>`SELECT id, text, created_at FROM facts ORDER BY created_at, rowid`,
      tasks: this.sql<Task>`SELECT id, title, due_at, done FROM tasks
        ORDER BY done, due_at IS NULL, due_at, rowid`,
      notes: this
        .sql<Note>`SELECT id, body, created_at FROM notes ORDER BY created_at, rowid`,
      reminders: await this.upcomingReminders()
    };
  }

  /** Reminders are one-off schedules that call `fireReminder`. */
  private async upcomingReminders(): Promise<Reminder[]> {
    const now = Date.now();
    const schedules = await this.listSchedules({ type: "scheduled" });
    return schedules
      .filter((s) => s.callback === "fireReminder" && s.time * 1000 > now)
      .map((s) => ({
        id: s.id,
        text: (s.payload as { text: string }).text,
        time: s.time * 1000
      }))
      .sort((a, b) => a.time - b.time);
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
  async getMemory(): Promise<Memory> {
    return this.loadMemory();
  }

  @callable()
  async setTimezone(timezone: string) {
    if (typeof timezone !== "string" || !isValidTimezone(timezone)) return;
    if (timezone === this.state.timezone) return;
    this.setState({ ...this.state, timezone });
    // The briefing's UTC cron depends on the timezone
    if (this.state.briefingTime)
      await this.configureBriefing(this.state.briefingTime);
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

  @callable()
  async runBriefingNow() {
    return this.startBriefing("manual");
  }

  @callable()
  async setBriefingTime(time: string | null) {
    if (time !== null && !BRIEFING_TIME.test(String(time))) {
      throw new Error("Time must be HH:MM in 24-hour format");
    }
    await this.configureBriefing(time);
    return this.getBriefingSchedule();
  }

  @callable()
  async getBriefingSchedule() {
    const { briefingScheduleId, briefingTime } = this.state;
    if (!briefingScheduleId || !briefingTime) return null;
    const schedule = await this.getScheduleById(briefingScheduleId);
    if (!schedule || schedule.type !== "cron") return null;
    return {
      time: briefingTime,
      cron: schedule.cron,
      nextRun: schedule.time * 1000
    };
  }

  @callable()
  async removeReminder(id: string): Promise<boolean> {
    return this.cancelReminder(String(id));
  }

  @callable()
  dismissReminder(id: string) {
    const inbox = (this.state.inbox ?? []).filter((r) => r.id !== String(id));
    this.setState({ ...this.state, inbox });
  }

  // ── Morning briefing ─────────────────────────────────────────────────

  /** Replace the daily briefing schedule; `null` turns it off. */
  private async configureBriefing(time: string | null) {
    if (this.state.briefingScheduleId) {
      await this.cancelSchedule(this.state.briefingScheduleId);
    }
    if (!time) {
      this.setState({
        ...this.state,
        briefingTime: undefined,
        briefingScheduleId: undefined
      });
      return;
    }
    // Cron schedules run in UTC, so convert the user's local time first
    const cron = dailyCronUtc(time, this.state.timezone);
    const schedule = await this.schedule(cron, "runScheduledBriefing");
    this.setState({
      ...this.state,
      briefingTime: time,
      briefingScheduleId: schedule.id
    });
  }

  async runScheduledBriefing() {
    await this.startBriefing("scheduled");
  }

  private async startBriefing(
    trigger: "scheduled" | "manual"
  ): Promise<"started" | "already-running"> {
    const startedAt = Date.parse(this.state.briefingStartedAt ?? "") || 0;
    if (
      this.state.workflowStatus === "running" &&
      Date.now() - startedAt < BRIEFING_STALE_MS
    ) {
      return "already-running";
    }
    this.setState({
      ...this.state,
      workflowStatus: "running",
      briefingStartedAt: new Date().toISOString(),
      briefingError: null
    });
    try {
      await this.runWorkflow("BRIEFING_WORKFLOW", { trigger });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({
        ...this.state,
        workflowStatus: "failed",
        briefingError: message
      });
      throw error;
    }
    return "started";
  }

  /** Called by MorningBriefingWorkflow's load-context step (DO RPC). */
  async getBriefingContext(): Promise<BriefingContext> {
    const timezone = this.state.timezone;
    const memory = await this.loadMemory();
    const today = localDate(timezone);
    const open = memory.tasks.filter((t) => !t.done);
    const due = open.filter((t) => t.due_at && t.due_at.slice(0, 10) <= today);
    const endOfToday = localToUtc(`${today}T23:59`, timezone) ?? Date.now();
    return {
      timezone,
      localNow: localNow(timezone),
      facts: memory.facts.map((f) => f.text),
      dueTasks: due.map((t) => ({
        title: t.title,
        due_at: t.due_at ?? "",
        overdue: (t.due_at ?? "").slice(0, 10) < today
      })),
      otherTasks: open
        .filter((t) => !due.includes(t))
        .slice(0, 5)
        .map((t) => t.title),
      reminders: memory.reminders
        .filter((r) => r.time <= endOfToday)
        .map((r) => ({ text: r.text, at: formatLocal(r.time, timezone) })),
      notes: memory.notes.slice(-5).map((n) => n.body)
    };
  }

  /** The Workflow reported completion: also post the briefing into the chat. */
  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
    const briefing = result as Briefing | undefined;
    console.log(
      JSON.stringify({
        event: "briefing_complete",
        workflowId,
        hasText: Boolean(briefing?.text)
      })
    );
    if (!briefing?.text) return;
    const id = `briefing-${workflowId}`;
    try {
      // Don't write history in the middle of a streaming turn or approval
      if (!(await this.waitUntilStable({ timeout: 30_000 }))) {
        console.warn(
          JSON.stringify({ event: "briefing_chat_skipped", workflowId })
        );
        return;
      }
      if (this.messages.some((m) => m.id === id)) return;
      const message: UIMessage = {
        id,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: `**Your morning briefing**\n\n${briefing.text}`
          }
        ]
      };
      await this.persistMessages([...this.messages, message]);
      console.log(JSON.stringify({ event: "briefing_posted", workflowId }));
    } catch (error) {
      // The briefing is already in state; a failed chat post shouldn't fail the run
      console.error(
        JSON.stringify({
          event: "briefing_post_failed",
          workflowId,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    console.error(
      JSON.stringify({ event: "briefing_failed", workflowId, error })
    );
    this.setState({
      ...this.state,
      workflowStatus: "failed",
      briefingError: error
    });
  }

  // ── Reminders ────────────────────────────────────────────────────────

  private async cancelReminder(id: string): Promise<boolean> {
    // Only cancel reminders, never the briefing's cron schedule
    const schedule = await this.getScheduleById(id);
    if (!schedule || schedule.callback !== "fireReminder") return false;
    const cancelled = await this.cancelSchedule(id);
    if (cancelled) this.memoryChanged();
    return cancelled;
  }

  async fireReminder(payload: { text: string }) {
    const item = {
      id: newId("r"),
      text: payload.text,
      firedAt: new Date().toISOString()
    };
    const inbox = [...(this.state.inbox ?? []), item].slice(-MAX_INBOX);
    this.setState({ ...this.state, inbox });
    this.broadcast(JSON.stringify({ type: "reminder", text: payload.text }));
    this.memoryChanged();
  }

  // ── Chat ─────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withSingleFormatStream(this.ai())
    });
    const currentPrompt = async () =>
      buildSystemPrompt(await this.loadMemory(), this.state);
    const system = await currentPrompt();
    // Fit the newest messages into the 24K context, without earlier turns'
    // tool calls (see withoutOldToolCalls)
    const messages = await convertToModelMessages(
      withoutOldToolCalls(fitHistory(this.messages, system))
    );

    // Used when the model's whole reply was talk about tools (see dropToolTalk)
    const plainReply = async () => {
      const output = await this.ai().run(MODEL, {
        messages: [
          { role: "system", content: system },
          ...toPlainChat(messages)
        ],
        max_tokens: MAX_OUTPUT_TOKENS
      });
      const text = readAiText(output).trim();
      return isToolTalk(text) ? "" : text;
    };

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system,
      messages,
      experimental_transform: dropToolTalk(plainReply),
      prepareStep: async ({ stepNumber, steps }) => {
        if (stepNumber === 0) return {};
        const last = steps[steps.length - 1];
        const toolsSucceeded =
          last.toolResults.length > 0 &&
          last.content.every((part) => part.type !== "tool-error");
        return {
          // Rebuild the prompt so memory reflects what the tools just did;
          // a stale "Open tasks: (none)" makes Llama add the task again.
          system: await currentPrompt(),
          // After a successful tool step, answer in text instead of calling
          // more tools. A failed call (e.g. invalid input) may be retried.
          ...(toolsSucceeded
            ? { activeTools: [], toolChoice: "none" as const }
            : {})
        };
      },
      tools: {
        forget_fact: tool({
          description:
            "Delete a fact from long-term memory when the user asks you to forget it.",
          inputSchema: z.object({
            id: z.string().describe("The fact id, e.g. f-1a2b3c4d")
          }),
          needsApproval: true,
          execute: async ({ id }) =>
            this.deleteFact(cleanId(id))
              ? `Forgot ${cleanId(id)}.`
              : `No fact with id ${id}.`
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
            return `Added task ${id}: ${title.trim()}${due ? ` (due ${due})` : ""}.`;
          }
        }),

        complete_task: tool({
          description: "Mark a task as done.",
          inputSchema: z.object({
            id: z.string().describe("The task id, e.g. t-1a2b3c4d")
          }),
          execute: async ({ id }) =>
            this.setTaskDone(cleanId(id), true)
              ? `Marked task ${cleanId(id)} as done.`
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
            return `Saved note ${id}.`;
          }
        }),

        set_reminder: tool({
          description:
            "Schedule a one-off reminder. Use in_minutes for a time relative to now, or at for a clock time.",
          inputSchema: z.object({
            text: z
              .string()
              .min(1)
              .max(200)
              .describe("What to remind the user about"),
            in_minutes: z
              .number()
              .int()
              .positive()
              .max(525_600)
              .optional()
              .describe("Minutes from now, e.g. 10"),
            at: z
              .string()
              .optional()
              .describe("Local date-time, e.g. 2026-10-13T09:00")
          }),
          execute: async ({ text, in_minutes, at }) => {
            const timezone = this.state.timezone;
            const when = in_minutes
              ? Date.now() + in_minutes * 60_000
              : at
                ? localToUtc(at, timezone)
                : null;
            if (when === null) {
              return "Give in_minutes, or at as a local date-time like 2026-10-13T09:00.";
            }
            if (when <= Date.now()) {
              return "That time has already passed. Ask the user for a time in the future.";
            }
            const schedule = await this.schedule(
              new Date(when),
              "fireReminder",
              {
                text: text.trim()
              }
            );
            this.memoryChanged();
            return `Reminder ${schedule.id} set for ${formatLocal(when, timezone)}: ${text.trim()}.`;
          }
        }),

        cancel_reminder: tool({
          description: "Cancel an upcoming reminder by its id.",
          inputSchema: z.object({
            id: z.string().describe("The reminder id from Upcoming reminders")
          }),
          needsApproval: true,
          execute: async ({ id }) =>
            (await this.cancelReminder(cleanId(id)))
              ? `Cancelled reminder ${id}.`
              : `No upcoming reminder with id ${id}.`
        }),

        set_briefing: tool({
          description:
            "Turn the daily morning briefing on at a local time, change its time, or turn it off.",
          inputSchema: z.object({
            time: z
              .string()
              .describe('24-hour local time like "08:00", or "off"')
          }),
          execute: async ({ time }) => {
            const value = time.trim().toLowerCase();
            if (value === "off") {
              await this.configureBriefing(null);
              return "The daily briefing is off.";
            }
            const padded = value.replace(/^(\d):/, "0$1:");
            if (!BRIEFING_TIME.test(padded)) {
              return 'Use a 24-hour time like "08:00", or "off".';
            }
            await this.configureBriefing(padded);
            return `The daily briefing is set for ${padded} (${this.state.timezone}).`;
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
    const facts = await extractNewFacts(this.ai(), payload.text, known);
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
