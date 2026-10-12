import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessage
} from "ai";
import { z } from "zod";
import { readAiText, withSingleFormatStream } from "./single-format-ai";
import {
  fallbackModel,
  isDailyLimitError,
  nextDailyReset,
  withOllamaFallback
} from "./ai-fallback";
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
import {
  groqConfigured,
  synthesizeWithAura,
  transcribeWithGroq
} from "./speech-server";
import { toSpeechText } from "./speech-text";
import {
  callOperation,
  convertSpec,
  estimateTokens,
  parseSpec,
  type ApiTool
} from "./openapi-tools";

export { MorningBriefingWorkflow } from "./briefing-workflow";

const BRIEFING_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// A run still "running" after this long is assumed lost, so a new one may start
const BRIEFING_STALE_MS = 5 * 60_000;
const MAX_INBOX = 20;

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
// About 45 seconds of 16 kHz mono WAV, base64-encoded; the UI stops at 30 s
const MAX_AUDIO_BASE64 = 2_000_000;
const VOICE_UNAVAILABLE =
  "Voice input is unavailable until the Workers AI daily limit resets.";

// Connected APIs (from OpenAPI specs) and MCP servers. Llama 3.3 gets less
// reliable with many tools, so only a limited number are offered.
const MAX_API_SOURCES = 3;
const MAX_MCP_SERVERS = 3;
const MAX_TOOLS_PER_API = 10;
const MAX_EXTERNAL_TOOLS = 15;
const MAX_SPEC_CHARS = 1_000_000;
const MAX_TOOL_RESULT_CHARS = 4_000;

type ApiSourceRow = {
  id: string;
  name: string;
  slug: string; // tool-name prefix: api_<slug>_<operation>
  base_url: string;
  spec: string;
  spec_url: string | null;
  auth_header: string | null;
  auth_value: string | null; // never sent to the browser or the model
  created_at: string;
};
type LoadedApi = { row: ApiSourceRow; tools: ApiTool[]; skipped: number };

function requireHttps(url: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} isn't a valid URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use https.`);
}

/** MCP tool results → plain text, clipped so one result can't fill the context. */
function clipToolResult(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    ?.content;
  const text = Array.isArray(content)
    ? content
        .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
        .join("\n")
    : JSON.stringify(result);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…`
    : text;
}

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
  // Reconnect saved MCP servers after hibernation before answering
  waitForMcpConnections = true;
  // Converted OpenAPI specs, kept while this instance is in memory
  private apiCache = new Map<string, LoadedApi>();

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, source_msg TEXT, created_at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at TEXT, done INTEGER NOT NULL DEFAULT 0)`;
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS api_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      base_url TEXT NOT NULL, spec TEXT NOT NULL, spec_url TEXT,
      auth_header TEXT, auth_value TEXT, created_at TEXT NOT NULL)`;

    // MCP servers that use OAuth finish sign-in in a popup; close it after
    this.mcp.configureOAuthCallback({
      customHandler: (result) =>
        result.authSuccess
          ? new Response("<script>window.close();</script>", {
              headers: { "content-type": "text/html" }
            })
          : new Response(
              `Authentication failed: ${result.authError || "unknown error"}`,
              { status: 400, headers: { "content-type": "text/plain" } }
            )
    });
  }

  // ── Model access ─────────────────────────────────────────────────────

  /**
   * The AI binding, falling back to Ollama while Workers AI's free daily
   * limit is used up. The limit is recorded in state, which drives the UI
   * banner and lets later calls skip Workers AI until it resets.
   */
  private ai(): Ai {
    return withOllamaFallback(this.env.AI, this.env, {
      isLimited: () => this.dailyLimitActive(),
      onLimit: (fallbackModel) => this.recordDailyLimit(fallbackModel),
      onPrimaryOk: () => {
        if (this.state.aiLimit) this.setState({ ...this.state, aiLimit: null });
      }
    });
  }

  private dailyLimitActive(): boolean {
    const limit = this.state.aiLimit;
    return Boolean(limit && Date.parse(limit.until) > Date.now());
  }

  /** Remember the limit until the 00:00 UTC reset (drives the UI banner). */
  private recordDailyLimit(fallbackModel: string | null) {
    if (this.dailyLimitActive()) return;
    this.setState({
      ...this.state,
      aiLimit: { until: nextDailyReset(), fallbackModel }
    });
  }

  // ── Voice ────────────────────────────────────────────────────────────

  /**
   * Speech-to-text for the mic button. Calls Workers AI directly, without
   * the Ollama fallback: Ollama has no speech-to-text model.
   */
  @callable()
  async transcribe(audioBase64: string): Promise<string> {
    if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
      throw new Error("No audio received.");
    }
    if (audioBase64.length > MAX_AUDIO_BASE64) {
      throw new Error("That recording is too long. Keep it under 30 seconds.");
    }
    // Whisper on Workers AI first; Groq's Whisper while the daily limit is
    // in effect (or if Workers AI fails). The browser has its own fallback.
    const groq = groqConfigured(this.env);
    if (this.dailyLimitActive()) {
      if (!groq) throw new Error(VOICE_UNAVAILABLE);
      return this.logTranscript(
        "groq",
        await transcribeWithGroq(this.env, audioBase64)
      );
    }
    let output: { text?: string };
    try {
      output = await this.env.AI.run(WHISPER_MODEL, {
        audio: audioBase64,
        task: "transcribe",
        vad_filter: true
      });
    } catch (error) {
      if (isDailyLimitError(error))
        this.recordDailyLimit(fallbackModel(this.env));
      if (!groq) {
        if (isDailyLimitError(error)) throw new Error(VOICE_UNAVAILABLE);
        throw error;
      }
      return this.logTranscript(
        "groq",
        await transcribeWithGroq(this.env, audioBase64)
      );
    }
    return this.logTranscript("workers-ai", (output.text ?? "").trim());
  }

  private logTranscript(provider: string, text: string): string {
    console.log(
      JSON.stringify({ event: "transcribed", provider, chars: text.length })
    );
    return text;
  }

  /**
   * A reply as speech: Aura-2 on Workers AI → base64 MP3. While the daily
   * limit is in effect, it tells the browser to use its own voice instead.
   */
  @callable()
  async speak(
    text: string
  ): Promise<{ audio: string } | { fallback: "browser" }> {
    const spoken = toSpeechText(String(text ?? ""));
    if (!spoken) return { fallback: "browser" };
    if (this.dailyLimitActive()) return { fallback: "browser" };
    try {
      return { audio: await synthesizeWithAura(this.env.AI, spoken) };
    } catch (error) {
      if (isDailyLimitError(error)) {
        this.recordDailyLimit(fallbackModel(this.env));
      } else {
        console.error(
          JSON.stringify({ event: "tts_failed", error: String(error) })
        );
      }
      return { fallback: "browser" };
    }
  }

  /** Which voice backups the server has, so the mic can pick its mode. */
  @callable()
  getVoiceSetup(): { groq: boolean } {
    return { groq: groqConfigured(this.env) };
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

  // ── Integrations: APIs from OpenAPI specs, and MCP servers ───────────

  private integrationsChanged() {
    this.broadcast(JSON.stringify({ type: "integrations-changed" }));
  }

  private loadApis(): LoadedApi[] {
    const rows = this
      .sql<ApiSourceRow>`SELECT * FROM api_sources ORDER BY created_at, rowid`;
    const loaded: LoadedApi[] = [];
    for (const row of rows) {
      let api = this.apiCache.get(row.id);
      if (!api) {
        try {
          const converted = convertSpec(parseSpec(row.spec), {
            maxTools: MAX_TOOLS_PER_API,
            specUrl: row.spec_url ?? undefined
          });
          api = { row, tools: converted.tools, skipped: converted.skipped };
          this.apiCache.set(row.id, api);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "api_spec_unreadable",
              id: row.id,
              error: String(error)
            })
          );
          continue;
        }
      }
      loaded.push(api);
    }
    return loaded;
  }

  /** Short, unique tool-name prefix from the API's name: "Open Meteo" → "open_meteo". */
  private uniqueSlug(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 16) || "api";
    const taken = new Set(
      this.sql<{ slug: string }>`SELECT slug FROM api_sources`.map(
        (r) => r.slug
      )
    );
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}${i}`;
    return slug;
  }

  /** Convert an OpenAPI 3.x spec (pasted, or fetched from a URL) into tools. */
  @callable()
  async addApi(input: {
    name: string;
    specUrl?: string;
    specText?: string;
    baseUrl?: string;
    authHeader?: string;
    authValue?: string;
  }) {
    const name = String(input?.name ?? "").trim();
    if (!name || name.length > 40) {
      throw new Error("Give the API a short name (up to 40 characters).");
    }
    if (this.sql`SELECT id FROM api_sources`.length >= MAX_API_SOURCES) {
      throw new Error(
        `You can connect up to ${MAX_API_SOURCES} APIs. Remove one first.`
      );
    }

    const specUrl = input.specUrl?.trim() || null;
    let specText = String(input.specText ?? "").trim();
    if (!specText) {
      if (!specUrl) throw new Error("Paste a spec, or give the URL of one.");
      requireHttps(specUrl, "The spec URL");
      const response = await fetch(specUrl, {
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        throw new Error(
          `Couldn't download the spec (HTTP ${response.status}).`
        );
      }
      specText = await response.text();
    }
    if (specText.length > MAX_SPEC_CHARS) {
      throw new Error("That spec is too large (over 1 MB).");
    }

    const converted = convertSpec(parseSpec(specText), {
      maxTools: MAX_TOOLS_PER_API,
      specUrl: specUrl ?? undefined
    });
    if (converted.tools.length === 0) {
      throw new Error("The spec has no operations Jarvis can call.");
    }
    const baseUrl = (input.baseUrl?.trim() || converted.baseUrl || "").replace(
      /\/+$/,
      ""
    );
    if (!baseUrl) {
      throw new Error(
        "This spec doesn't list a server URL. Enter the API's base URL."
      );
    }
    requireHttps(baseUrl, "The base URL");

    const authHeader = input.authHeader?.trim() || null;
    const authValue = input.authValue?.trim() || null;
    if (authHeader && !/^[A-Za-z0-9-]+$/.test(authHeader)) {
      throw new Error(
        "The auth header name can only use letters, digits and dashes."
      );
    }

    const id = newId("a");
    this.sql`INSERT INTO api_sources
      (id, name, slug, base_url, spec, spec_url, auth_header, auth_value, created_at)
      VALUES (${id}, ${name}, ${this.uniqueSlug(name)}, ${baseUrl}, ${specText},
        ${specUrl}, ${authHeader}, ${authValue}, ${new Date().toISOString()})`;
    this.integrationsChanged();
    return {
      id,
      name,
      baseUrl,
      toolCount: converted.tools.length,
      skipped: converted.skipped
    };
  }

  @callable()
  removeApi(id: string): boolean {
    const found =
      this.sql`SELECT id FROM api_sources WHERE id = ${String(id)}`.length > 0;
    this.sql`DELETE FROM api_sources WHERE id = ${String(id)}`;
    this.apiCache.delete(String(id));
    if (found) this.integrationsChanged();
    return found;
  }

  /** Connect an MCP server; the SDK saves it and reconnects after restarts. */
  @callable()
  async addMcp(input: {
    name: string;
    url: string;
    authHeader?: string;
    authValue?: string;
  }) {
    const name = String(input?.name ?? "").trim();
    const url = String(input?.url ?? "").trim();
    if (!name || name.length > 40) {
      throw new Error("Give the server a short name (up to 40 characters).");
    }
    requireHttps(url, "The server URL");
    if (Object.keys(this.getMcpServers().servers).length >= MAX_MCP_SERVERS) {
      throw new Error(
        `You can connect up to ${MAX_MCP_SERVERS} MCP servers. Remove one first.`
      );
    }
    const authHeader = input.authHeader?.trim();
    const authValue = input.authValue?.trim();
    if (authHeader && !/^[A-Za-z0-9-]+$/.test(authHeader)) {
      throw new Error(
        "The auth header name can only use letters, digits and dashes."
      );
    }
    const result = await this.addMcpServer(
      name,
      url,
      authHeader && authValue
        ? { transport: { headers: { [authHeader]: authValue } } }
        : undefined
    );
    this.integrationsChanged();
    return result;
  }

  @callable()
  async removeMcp(id: string): Promise<boolean> {
    await this.removeMcpServer(String(id));
    this.integrationsChanged();
    return true;
  }

  /** What's connected, for the Integrations panel. No secrets. */
  @callable()
  getIntegrations() {
    const apis = this.loadApis().map(({ row, tools, skipped }) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      hasAuth: Boolean(row.auth_value),
      skipped,
      tools: tools.map((t) => ({
        name: `api_${row.slug}_${t.name}`,
        method: t.method.toUpperCase(),
        path: t.path,
        readOnly: t.readOnly
      }))
    }));
    const mcpState = this.getMcpServers();
    const mcp = Object.entries(mcpState.servers).map(([id, server]) => ({
      id,
      name: server.name,
      url: server.server_url,
      state: server.state,
      error: server.error ?? null,
      authUrl: server.auth_url ?? null,
      tools: mcpState.tools
        .filter((t) => t.serverId === id)
        .map((t) => ({
          name: t.name,
          readOnly: t.annotations?.readOnlyHint === true
        }))
    }));
    return { apis, mcp, maxExternalTools: MAX_EXTERNAL_TOOLS };
  }

  /**
   * Tools from connected APIs and MCP servers. Read-only calls (GET, or MCP
   * tools annotated readOnlyHint) run directly; anything that might change
   * data asks the user to approve first.
   */
  private externalTools(): { tools: ToolSet; tokens: number } {
    const tools: ToolSet = {};
    let tokens = 0;
    const offer = (name: string, value: ToolSet[string], size: number) => {
      if (Object.keys(tools).length >= MAX_EXTERNAL_TOOLS) return;
      tools[name] = value;
      tokens += size;
    };

    for (const { row, tools: apiTools } of this.loadApis()) {
      const headers: Record<string, string> =
        row.auth_header && row.auth_value
          ? { [row.auth_header]: row.auth_value }
          : {};
      for (const op of apiTools) {
        offer(
          `api_${row.slug}_${op.name}`,
          tool({
            description: `${row.name}: ${op.description}`,
            inputSchema: jsonSchema<Record<string, unknown>>(op.inputSchema),
            needsApproval: !op.readOnly,
            execute: async (args) =>
              callOperation(op, args, { baseUrl: row.base_url, headers })
          }),
          estimateTokens({ d: op.description, s: op.inputSchema })
        );
      }
    }

    const catalog = new Map(
      this.mcp
        .listTools()
        .map((t) => [`tool_${t.serverId.replace(/-/g, "")}_${t.name}`, t])
    );
    for (const [name, mcpTool] of Object.entries(this.mcp.getAITools())) {
      const raw = catalog.get(name);
      const execute = mcpTool.execute;
      offer(
        name,
        {
          ...mcpTool,
          needsApproval: raw?.annotations?.readOnlyHint !== true,
          execute: execute
            ? async (args, options) =>
                clipToolResult(await execute(args, options))
            : undefined
        },
        estimateTokens({ d: raw?.description, s: raw?.inputSchema })
      );
    }
    return { tools, tokens };
  }

  // ── Chat ─────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withSingleFormatStream(this.ai())
    });
    const currentPrompt = async () =>
      buildSystemPrompt(await this.loadMemory(), this.state);
    const system = await currentPrompt();
    const external = this.externalTools();
    // Fit the newest messages into the 24K context (after the connected
    // tools' schemas), without earlier turns' tool calls (see withoutOldToolCalls)
    const messages = await convertToModelMessages(
      withoutOldToolCalls(fitHistory(this.messages, system, external.tokens))
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
        ...external.tools,
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
