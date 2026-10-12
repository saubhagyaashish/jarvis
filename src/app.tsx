import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { JarvisAgent } from "./server";
import type { JarvisState, Memory } from "./memory";
import { MemoryPanel, type BriefingSchedule } from "./memory-panel";
import { MicButton, type MicMode } from "./mic-button";
import { browserRecognitionSupported, isServerVoiceFailure } from "./voice";
import {
  playMp3,
  speakWithBrowser,
  stopSpeaking,
  unlockAudio
} from "./speech-output";
import { messageText, toSpeechText } from "./speech-text";
import { IntegrationsPanel, type Integrations } from "./integrations-panel";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
  WarningIcon,
  PlugsConnectedIcon,
  XIcon
} from "@phosphor-icons/react";

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Tool rendering ────────────────────────────────────────────────────

function ToolIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {text}
      </pre>
    </div>
  );
}

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  // Completed
  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <ToolIO label="Input" value={part.input} />
          <ToolIO label="Output" value={part.output} />
        </Surface>
      </div>
    );
  }

  // Needs approval
  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  // Rejected / denied
  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  // Errored
  if (part.state === "output-error") {
    const errorText = part.errorText;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger">
          <div className="flex items-center gap-2 mb-1">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {errorText || "Tool call failed"}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  // Executing
  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              Running {toolName}...
            </Text>
          </div>
          <ToolIO label="Input" value={part.input} />
        </Surface>
      </div>
    );
  }

  return null;
}

// ── Per-browser agent instance ────────────────────────────────────────

// Each browser gets its own JarvisAgent; the unguessable ID is the only
// thing that separates one visitor's memory from another's.
function getInstanceId(): string {
  const key = "jarvis-instance-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    // Storage blocked (e.g. private mode): fall back to a per-tab instance
    return crypto.randomUUID();
  }
}

const instanceId = getInstanceId();

const SUGGESTIONS = [
  "I'm vegetarian and I live in Bengaluru",
  "Add a task to call Raj tomorrow at 3pm",
  "Remind me in 2 minutes to stretch",
  "Brief me every morning at 8",
  "What do you remember about me?"
];

/** Shown while Workers AI's free daily limit is used up. */
function DailyLimitBanner({
  limit
}: {
  limit: NonNullable<JarvisState["aiLimit"]>;
}) {
  const resetsAt = new Date(limit.until).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });
  return (
    <output className="flex items-start gap-2 px-4 sm:px-5 py-2.5 bg-kumo-warning/10 border-b border-kumo-line">
      <WarningIcon size={16} className="mt-0.5 shrink-0 text-kumo-warning" />
      <Text size="sm">
        {limit.fallbackModel
          ? `Cloudflare Workers AI's free daily limit is used up. Jarvis is answering with a backup model (Ollama · ${limit.fallbackModel}) until it resets at ${resetsAt}.`
          : `Cloudflare Workers AI's free daily limit is used up, so Jarvis can't reply until it resets at ${resetsAt}.`}
      </Text>
    </output>
  );
}

const SPEAK_REPLIES_KEY = "jarvis-speak-replies";
// After a server transcription failure, the browser listens for this long
const BROWSER_VOICE_MS = 10 * 60_000;

function readSpeakSetting(): boolean {
  try {
    return localStorage.getItem(SPEAK_REPLIES_KEY) === "1";
  } catch {
    return false;
  }
}

function notify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [memory, setMemory] = useState<Memory | null>(null);
  // Bumped whenever the agent says memory changed; triggers a refetch
  const [memoryVersion, setMemoryVersion] = useState(0);
  // Synced agent state: briefing status, latest briefing, fired reminders
  const [agentState, setAgentState] = useState<JarvisState | null>(null);
  const [briefingSchedule, setBriefingSchedule] =
    useState<BriefingSchedule | null>(null);
  // Connected APIs and MCP servers; refetched when the agent reports a change
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [integrationsVersion, setIntegrationsVersion] = useState(0);
  // Voice: which server backups exist, and spoken replies
  const [voiceSetup, setVoiceSetup] = useState<{ groq: boolean } | null>(null);
  const [speakReplies, setSpeakReplies] = useState(readSpeakSetting);
  const [speaking, setSpeaking] = useState(false);
  const voiceTurn = useRef(false); // the text in the input came from the mic
  const speakNext = useRef(false); // speak the reply to the message just sent
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent<JarvisAgent, JarvisState>({
    agent: "JarvisAgent",
    name: instanceId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: JarvisState) => setAgentState(state),
      []
    ),
    // MCP connection status changes (connecting → ready, failed, …)
    onMcpUpdate: useCallback(() => setIntegrationsVersion((v) => v + 1), []),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "reminder") {
            toasts.add({ title: "Reminder", description: data.text });
            notify("Jarvis reminder", data.text);
          }
          if (data.type === "integrations-changed") {
            setIntegrationsVersion((v) => v + 1);
          }
          if (data.type === "memory-changed") {
            setMemoryVersion((v) => v + 1);
            if (Array.isArray(data.added) && data.added.length > 0) {
              toasts.add({
                title: "Jarvis will remember",
                description: data.added.join(" · ")
              });
            }
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [toasts]
    )
  });

  // Read the agent through a ref so effects re-run only on real changes
  const agentRef = useRef(agent);
  agentRef.current = agent;

  // Tell the agent our timezone so "today" and due dates mean local time
  useEffect(() => {
    if (!connected) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    agentRef.current.stub
      .setTimezone(timezone)
      .catch((e: unknown) => console.error("Failed to set timezone:", e));
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    agentRef.current.stub
      .getMemory()
      .then(setMemory)
      .catch((e: unknown) => console.error("Failed to load memory:", e));
  }, [connected, memoryVersion]);

  useEffect(() => {
    if (!connected) return;
    agentRef.current.stub
      .getIntegrations()
      .then(setIntegrations)
      .catch((e: unknown) => console.error("Failed to load integrations:", e));
  }, [connected, integrationsVersion]);

  const briefingScheduleId = agentState?.briefingScheduleId;
  useEffect(() => {
    if (!connected) return;
    agentRef.current.stub
      .getBriefingSchedule()
      .then(setBriefingSchedule)
      .catch((e: unknown) => console.error("Failed to load briefing:", e));
  }, [connected, briefingScheduleId]);

  // Notify when a new briefing lands (createdAt changes), not on first load
  const lastBriefingAt = agentState?.lastBriefing?.createdAt;
  const seenBriefingAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!lastBriefingAt) return;
    if (seenBriefingAt.current && seenBriefingAt.current !== lastBriefingAt) {
      toasts.add({ title: "Your morning briefing is ready" });
      notify("Jarvis", "Your morning briefing is ready");
    }
    seenBriefingAt.current = lastBriefingAt;
  }, [lastBriefingAt, toasts]);

  const closeIntegrations = useCallback(() => setShowIntegrations(false), []);

  const callAgent = useCallback(
    (action: (stub: typeof agent.stub) => Promise<unknown>) => {
      action(agentRef.current.stub).catch((e: unknown) =>
        console.error("Memory update failed:", e)
      );
    },
    []
  );

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Re-focus the input after streaming ends
  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  useEffect(() => {
    if (!connected) return;
    agentRef.current.stub
      .getVoiceSetup()
      .then(setVoiceSetup)
      .catch((e: unknown) => console.error("Failed to load voice setup:", e));
  }, [connected]);

  const sendText = useCallback(
    (text: string, fromVoice = false) => {
      if (!text.trim() || isStreaming) return;
      // Spoken messages get spoken replies; otherwise follow the toggle
      speakNext.current = speakReplies || fromVoice;
      stopSpeaking();
      sendMessage({
        role: "user",
        parts: [{ type: "text", text: text.trim() }]
      });
    },
    [isStreaming, sendMessage, speakReplies]
  );

  // Aura-2 on Workers AI, or the browser's voice while the limit is in effect
  const aiLimitUntil = agentState?.aiLimit?.until;
  const speakReply = useCallback(
    async (text: string) => {
      const spoken = toSpeechText(text);
      if (!spoken) return;
      const limited = Boolean(
        aiLimitUntil && Date.parse(aiLimitUntil) > Date.now()
      );
      setSpeaking(true);
      try {
        const result = limited
          ? ({ fallback: "browser" } as const)
          : await agentRef.current.stub.speak(text);
        if ("audio" in result) await playMp3(result.audio);
        else await speakWithBrowser(spoken);
      } catch {
        await speakWithBrowser(spoken).catch(() => {});
      } finally {
        setSpeaking(false);
      }
    },
    [aiLimitUntil]
  );

  // When a reply finishes streaming, speak it if that was asked for
  const previousStatus = useRef(status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;
    if (status !== "ready" || (was !== "streaming" && was !== "submitted")) {
      return;
    }
    if (!speakNext.current) return;
    speakNext.current = false;
    const last = messages[messages.length - 1];
    const text = last?.role === "assistant" ? messageText(last) : "";
    if (text) void speakReply(text);
  }, [status, messages, speakReply]);

  const toggleSpeakReplies = useCallback(() => {
    unlockAudio();
    const next = !speakReplies;
    setSpeakReplies(next);
    if (!next) stopSpeaking();
    try {
      localStorage.setItem(SPEAK_REPLIES_KEY, next ? "1" : "0");
    } catch {
      // Not saved; the toggle still works for this visit
    }
  }, [speakReplies]);

  const startListening = useCallback(() => {
    stopSpeaking();
    unlockAudio();
  }, []);

  // Voice: the transcript goes into the input box to check before sending
  // If the server can't transcribe (Groq or Workers AI down), switch the mic
  // to the browser's own recognition for a while. The clip can't be reused:
  // the browser only recognizes live audio, so the user says it again.
  const [browserVoiceUntil, setBrowserVoiceUntil] = useState(0);
  useEffect(() => {
    if (!browserVoiceUntil) return;
    const timer = setTimeout(
      () => setBrowserVoiceUntil(0),
      Math.max(0, browserVoiceUntil - Date.now())
    );
    return () => clearTimeout(timer);
  }, [browserVoiceUntil]);

  const transcribe = useCallback(async (audioBase64: string) => {
    try {
      return await agentRef.current.stub.transcribe(audioBase64);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isServerVoiceFailure(message) && browserRecognitionSupported()) {
        setBrowserVoiceUntil(Date.now() + BROWSER_VOICE_MS);
        console.warn(
          "Server transcription failed; using the browser:",
          message
        );
        throw new Error(
          "Couldn't transcribe on the server, so the mic switched to your browser's speech recognition. Press the mic and say it again."
        );
      }
      throw error;
    }
  }, []);
  const insertTranscript = useCallback((text: string) => {
    voiceTurn.current = true;
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      el.focus();
    });
  }, []);
  const voiceError = useCallback(
    (message: string) =>
      toasts.add({ title: "Voice input", description: message }),
    [toasts]
  );

  const send = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    sendText(input, voiceTurn.current);
    voiceTurn.current = false;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendText]);

  const factCount = memory?.facts.length ?? 0;
  const limit = agentState?.aiLimit;
  const dailyLimit =
    limit && Date.parse(limit.until) > Date.now() ? limit : null;
  // While Workers AI is limited and there's no Groq key, the browser listens
  const micMode: MicMode =
    browserVoiceUntil > Date.now() ||
    (dailyLimit && voiceSetup && !voiceSetup.groq)
      ? "browser"
      : "server";

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-4 sm:px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">Jarvis</h1>
            <Badge variant="secondary" className="hidden sm:inline-flex">
              <BrainIcon size={12} weight="bold" className="mr-1" />
              Personal assistant
            </Badge>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                <span className="hidden sm:inline">
                  {connected ? "Connected" : "Disconnected"}
                </span>
              </Text>
            </div>
            <div className="hidden sm:flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            {speaking ? (
              <Button
                variant="secondary"
                icon={<StopIcon size={16} />}
                onClick={() => {
                  stopSpeaking();
                  setSpeaking(false);
                }}
                aria-label="Stop speaking"
                title="Stop speaking"
              />
            ) : (
              <Button
                variant={speakReplies ? "primary" : "secondary"}
                icon={
                  speakReplies ? (
                    <SpeakerHighIcon size={16} />
                  ) : (
                    <SpeakerSlashIcon size={16} />
                  )
                }
                onClick={toggleSpeakReplies}
                aria-label={
                  speakReplies
                    ? "Turn off spoken replies"
                    : "Turn on spoken replies"
                }
                title={
                  speakReplies ? "Spoken replies: on" : "Spoken replies: off"
                }
              />
            )}
            <Button
              variant="secondary"
              icon={<PlugsConnectedIcon size={16} />}
              onClick={() => setShowIntegrations(true)}
              aria-label="Integrations"
            >
              <span className="hidden sm:inline">Integrations</span>
              {integrations &&
                integrations.apis.length + integrations.mcp.length > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    {integrations.apis.length + integrations.mcp.length}
                  </Badge>
                )}
            </Button>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<BrainIcon size={16} />}
              onClick={() => setShowMemory(!showMemory)}
              aria-label="Show memory"
              className="md:hidden"
            >
              {factCount > 0 ? factCount : null}
            </Button>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
              aria-label="Clear chat"
            >
              <span className="hidden sm:inline">Clear chat</span>
            </Button>
          </div>
        </div>
      </header>

      {dailyLimit && <DailyLimitBanner limit={dailyLimit} />}

      <div className="relative flex flex-1 min-h-0">
        {/* Chat column */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <Empty
                  icon={<ChatCircleDotsIcon size={32} />}
                  title="Hi, I'm Jarvis"
                  description="Tell me about yourself, and I'll remember it. I can also keep your tasks and notes."
                  contents={
                    <div className="flex flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((prompt) => (
                        <Button
                          key={prompt}
                          variant="outline"
                          size="sm"
                          disabled={isStreaming || !connected}
                          onClick={() => sendText(prompt)}
                        >
                          {prompt}
                        </Button>
                      ))}
                    </div>
                  }
                />
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {showDebug && (
                      <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                        {JSON.stringify(message, null, 2)}
                      </pre>
                    )}

                    {/* Render parts in chronological (array) order */}
                    {message.parts.map((part, i) => {
                      const key = `${message.id}-${i}`;

                      if (isToolUIPart(part)) {
                        return (
                          <ToolPartView
                            key={key}
                            part={part}
                            addToolApprovalResponse={addToolApprovalResponse}
                          />
                        );
                      }

                      if (part.type === "reasoning") {
                        if (!part.text.trim()) return null;
                        const isDone = part.state === "done" || !isStreaming;
                        return (
                          <div key={key} className="flex justify-start">
                            <details
                              className="max-w-[85%] w-full"
                              open={!isDone}
                            >
                              <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                                <BrainIcon
                                  size={14}
                                  className="text-purple-400"
                                />
                                <span className="font-medium text-kumo-default">
                                  Reasoning
                                </span>
                                {isDone ? (
                                  <span className="text-xs text-kumo-success">
                                    Complete
                                  </span>
                                ) : (
                                  <span className="text-xs text-kumo-brand">
                                    Thinking...
                                  </span>
                                )}
                                <CaretDownIcon
                                  size={14}
                                  className="ml-auto text-kumo-inactive"
                                />
                              </summary>
                              <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                                {part.text}
                              </pre>
                            </details>
                          </div>
                        );
                      }

                      if (part.type === "text") {
                        if (!part.text) return null;

                        if (isUser) {
                          return (
                            <div key={key} className="flex justify-end">
                              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                                {part.text}
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div key={key} className="flex justify-start">
                            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                              <Streamdown
                                className="sd-theme rounded-2xl rounded-bl-md p-3"
                                plugins={{ code }}
                                controls={false}
                                isAnimating={isLastAssistant && isStreaming}
                              >
                                {part.text}
                              </Streamdown>
                            </div>
                          </div>
                        );
                      }

                      return null;
                    })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="max-w-3xl mx-auto px-4 sm:px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <MicButton
                  mode={micMode}
                  disabledReason={
                    !connected
                      ? "Not connected"
                      : isStreaming
                        ? "Wait for Jarvis to finish replying"
                        : null
                  }
                  transcribe={transcribe}
                  onTranscript={insertTranscript}
                  onError={voiceError}
                  onStart={startListening}
                />
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder="Message Jarvis..."
                  disabled={!connected || isStreaming}
                  rows={1}
                  className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop generation"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
            <div className="flex justify-center pb-3">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          </div>
        </div>

        {/* Memory panel: sidebar on desktop, full-height overlay on mobile */}
        <aside
          className={`${showMemory ? "flex" : "hidden"} md:flex absolute inset-0 z-40 md:static md:z-auto w-full md:w-80 shrink-0 flex-col bg-kumo-base md:border-l border-kumo-line`}
        >
          <div className="flex items-center justify-between px-5 pt-4 md:hidden">
            <Text size="sm" bold>
              Jarvis
            </Text>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Close panel"
              icon={<XIcon size={14} />}
              onClick={() => setShowMemory(false)}
            />
          </div>
          <MemoryPanel
            memory={memory}
            state={agentState}
            briefingSchedule={briefingSchedule}
            onRemoveFact={(id) => callAgent((s) => s.removeFact(id))}
            onToggleTask={(id, done) =>
              callAgent((s) => s.toggleTask(id, done))
            }
            onRemoveTask={(id) => callAgent((s) => s.removeTask(id))}
            onRemoveNote={(id) => callAgent((s) => s.removeNote(id))}
            onRunBriefing={() => callAgent((s) => s.runBriefingNow())}
            onSetBriefingTime={(time) =>
              callAgent((s) => s.setBriefingTime(time))
            }
            onRemoveReminder={(id) => callAgent((s) => s.removeReminder(id))}
            onDismissReminder={(id) => callAgent((s) => s.dismissReminder(id))}
          />
        </aside>
      </div>

      <IntegrationsPanel
        open={showIntegrations}
        onClose={closeIntegrations}
        integrations={integrations}
        onAddApi={(input) => agentRef.current.stub.addApi(input)}
        onRemoveApi={(id) => agentRef.current.stub.removeApi(id)}
        onAddMcp={(input) => agentRef.current.stub.addMcp(input)}
        onRemoveMcp={(id) => agentRef.current.stub.removeMcp(id)}
      />
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
