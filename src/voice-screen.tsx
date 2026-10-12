import {
  BrainIcon,
  ChatsCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  MicrophoneIcon,
  PlugsConnectedIcon,
  StopIcon,
  UserCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import type { UIMessage } from "ai";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AvatarView, type AvatarMood } from "./avatar/avatar-view";
import {
  CHARACTERS,
  characterById,
  type CharacterId
} from "./avatar/characters";
import { messageText, toSpeechText } from "./speech-text";
import type { VoiceCapture } from "./use-voice-capture";

export type PendingApproval = {
  approvalId: string;
  label: string;
  detail: string;
};

type Props = {
  connected: boolean;
  awake: boolean;
  onWake: () => void;
  character: CharacterId;
  onCharacterChange: (id: CharacterId) => void;
  mood: AvatarMood;
  waveKey: number;
  /** Loudness for lip-sync and the glow (0..1), polled every frame. */
  speechLevel: () => number;
  micLevel: () => number;
  capture: VoiceCapture;
  speaking: boolean;
  onStopSpeaking: () => void;
  messages: UIMessage[];
  /** Jarvis's caption until the next message: the hello, a reminder, … */
  announcement: string | null;
  isStreaming: boolean;
  pendingApproval: PendingApproval | null;
  onApproval: (approved: boolean) => void;
  banner: ReactNode;
  memoryPanel: ReactNode;
  onSwitchToChat: () => void;
  onOpenIntegrations: () => void;
};

/** The main screen: talk to Jarvis's 3D character. */
export function VoiceScreen(props: Props) {
  const {
    connected,
    awake,
    onWake,
    character,
    mood,
    waveKey,
    speechLevel,
    micLevel,
    capture,
    speaking,
    messages,
    isStreaming,
    pendingApproval,
    banner
  } = props;
  const [drawer, setDrawer] = useState<"history" | "memory" | null>(null);
  const [picker, setPicker] = useState(false);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const last = messages[messages.length - 1];
  const reply = props.announcement
    ? toSpeechText(props.announcement, 320)
    : last?.role === "assistant"
      ? toSpeechText(messageText(last), 320)
      : "";
  const waitingForReply = isStreaming && !reply;

  const recording = capture.status === "recording";
  const busy =
    capture.status === "starting" || capture.status === "transcribing";
  const status = !connected
    ? "Connecting…"
    : capture.status === "starting"
      ? "Starting the mic…"
      : recording
        ? `Listening… ${formatSeconds(capture.elapsed)} · release or tap to send`
        : capture.status === "transcribing"
          ? "Got it…"
          : isStreaming
            ? "Thinking…"
            : speaking
              ? "Speaking · tap to stop"
              : "Hold Ctrl + Space, or tap the mic to talk";

  const onMainButton = () => {
    if (recording) void capture.finish();
    else if (speaking) props.onStopSpeaking();
    else void capture.start();
  };

  return (
    <div className="relative h-screen w-full overflow-hidden bg-[#06070f] text-white select-none">
      {/* Backdrop and the glow that pulses with the voice */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,#2a2f7c_0%,#12143a_45%,#06070f_100%)]" />
      <Glow
        level={recording ? micLevel : speechLevel}
        active={recording || speaking}
      />

      <div className="absolute inset-0">
        <AvatarView
          model={characterById(character).model}
          mood={mood}
          waveKey={waveKey}
          speechLevel={speechLevel}
        />
      </div>

      {/* Top bar */}
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-rose-400"}`}
          />
          <span className="text-sm font-semibold tracking-[0.35em]">
            JARVIS
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="mr-1 flex rounded-full bg-white/10 p-0.5 text-xs backdrop-blur">
            <span className="rounded-full bg-white/90 px-3 py-1 font-medium text-[#12143a]">
              Voice
            </span>
            <button
              type="button"
              onClick={props.onSwitchToChat}
              className="rounded-full px-3 py-1 text-white/80 hover:text-white"
            >
              Chat
            </button>
          </div>
          <IconButton label="History" onClick={() => setDrawer("history")}>
            <ClockCounterClockwiseIcon size={18} />
          </IconButton>
          <IconButton
            label="Memory, tasks and reminders"
            onClick={() => setDrawer("memory")}
          >
            <BrainIcon size={18} />
          </IconButton>
          <IconButton label="Integrations" onClick={props.onOpenIntegrations}>
            <PlugsConnectedIcon size={18} />
          </IconButton>
          <div className="relative">
            <IconButton
              label="Change character"
              onClick={() => setPicker(!picker)}
            >
              <UserCircleIcon size={18} />
            </IconButton>
            {picker && (
              <div className="absolute right-0 top-full mt-2 w-40 rounded-xl bg-[#12143a]/95 p-1 ring-1 ring-white/15 backdrop-blur">
                {CHARACTERS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      props.onCharacterChange(c.id);
                      setPicker(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10"
                  >
                    {c.name}
                    {c.id === character && <CheckIcon size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {banner && <div className="absolute inset-x-0 top-14 z-20">{banner}</div>}

      {/* Captions, approval and the talk button */}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-[#06070f] via-[#06070f]/85 to-transparent px-4 pb-6 pt-24">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 text-center">
          {lastUser && !props.announcement && (
            <p className="line-clamp-2 text-sm text-white/55">
              You: {toSpeechText(messageText(lastUser), 200)}
            </p>
          )}
          <p className="min-h-[3.5rem] text-lg leading-snug text-white/95 sm:text-xl">
            {waitingForReply ? <ThinkingDots /> : reply}
          </p>

          {pendingApproval && (
            <div className="w-full max-w-md rounded-2xl bg-white/10 p-4 ring-1 ring-amber-300/40 backdrop-blur">
              <p className="text-sm font-medium">
                Jarvis wants to {pendingApproval.label}
              </p>
              {pendingApproval.detail && (
                <p className="mt-1 truncate font-mono text-xs text-white/60">
                  {pendingApproval.detail}
                </p>
              )}
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => props.onApproval(true)}
                  className="rounded-full bg-emerald-400 px-4 py-1.5 text-sm font-medium text-[#06070f]"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => props.onApproval(false)}
                  className="rounded-full bg-white/15 px-4 py-1.5 text-sm"
                >
                  Reject
                </button>
              </div>
            </div>
          )}

          <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/75 backdrop-blur">
            {status}
          </span>

          {capture.supported ? (
            <button
              type="button"
              onClick={onMainButton}
              disabled={!connected || busy || (isStreaming && !recording)}
              aria-label={
                recording
                  ? "Stop and send"
                  : speaking
                    ? "Stop speaking"
                    : "Talk"
              }
              className={`relative flex h-20 w-20 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-50 ${
                recording
                  ? "bg-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.7)]"
                  : "bg-gradient-to-br from-cyan-400 to-indigo-500 shadow-[0_0_40px_rgba(56,189,248,0.45)]"
              }`}
            >
              {recording && (
                <span className="absolute inset-0 animate-ping rounded-full bg-rose-500/40" />
              )}
              {busy ? (
                <CircleNotchIcon size={30} className="animate-spin" />
              ) : recording || speaking ? (
                <StopIcon size={30} weight="fill" />
              ) : (
                <MicrophoneIcon size={30} weight="fill" />
              )}
            </button>
          ) : (
            <p className="text-sm text-white/70">
              Voice isn't available in this browser.{" "}
              <button
                type="button"
                className="underline"
                onClick={props.onSwitchToChat}
              >
                Use chat
              </button>
            </p>
          )}
        </div>
      </div>

      {/* History and memory drawers */}
      {drawer && (
        <div className="absolute inset-0 z-30 flex justify-end">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 cursor-default bg-black/40"
            onClick={() => setDrawer(null)}
          />
          <aside className="relative flex h-full w-full max-w-md flex-col bg-kumo-base text-kumo-default shadow-2xl">
            <div className="flex items-center justify-between border-b border-kumo-line px-5 py-3">
              <span className="text-sm font-semibold">
                {drawer === "history"
                  ? "Conversation"
                  : "Memory, tasks and reminders"}
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setDrawer(null)}
              >
                <XIcon size={16} />
              </button>
            </div>
            {drawer === "history" ? (
              <History messages={messages} onOpenChat={props.onSwitchToChat} />
            ) : (
              props.memoryPanel
            )}
          </aside>
        </div>
      )}

      {!awake && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-[#06070f]/60 backdrop-blur-sm">
          <span className="text-3xl font-semibold tracking-[0.5em]">
            JARVIS
          </span>
          <button
            type="button"
            data-wake
            onClick={onWake}
            className="rounded-full bg-gradient-to-br from-cyan-400 to-indigo-500 px-6 py-3 font-medium shadow-[0_0_40px_rgba(56,189,248,0.5)]"
          >
            Tap to wake me up
          </button>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/85 backdrop-blur hover:bg-white/20 hover:text-white"
    >
      {children}
    </button>
  );
}

/** A soft glow behind the character; grows with the voice level. */
function Glow({ level, active }: { level: () => number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const target = active ? levelRef.current() : 0;
      smooth += (target - smooth) * 0.2;
      if (ref.current) {
        ref.current.style.transform = `translate(-50%, -50%) scale(${1 + smooth * 0.35})`;
        ref.current.style.opacity = String(0.35 + smooth * 0.5);
      }
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-1/2 top-[42%] h-[70vmin] w-[70vmin] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.55),rgba(99,102,241,0.25)_45%,transparent_70%)] blur-2xl"
      style={{ transform: "translate(-50%, -50%)", opacity: 0.35 }}
    />
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-1.5" aria-label="Thinking">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-2 w-2 animate-bounce rounded-full bg-white/70"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function History({
  messages,
  onOpenChat
}: {
  messages: UIMessage[];
  onOpenChat: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  // Block body on purpose: newer browsers return a Promise from
  // scrollIntoView(), and React would treat it as the effect's cleanup
  useEffect(() => {
    end.current?.scrollIntoView();
  }, []);
  const lines = messages
    .map((m) => ({ id: m.id, role: m.role, text: messageText(m) }))
    .filter((m) => m.text);
  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-3">
      {lines.length === 0 && (
        <p className="text-sm text-kumo-subtle">Nothing yet. Say hello!</p>
      )}
      {lines.map((m) => (
        <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
          <span
            className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
              m.role === "user"
                ? "bg-kumo-contrast text-kumo-inverse"
                : "bg-kumo-control text-kumo-default"
            }`}
          >
            {toSpeechText(m.text, 2000)}
          </span>
        </div>
      ))}
      <button
        type="button"
        onClick={onOpenChat}
        className="flex items-center gap-1.5 text-xs text-kumo-brand"
      >
        <ChatsCircleIcon size={14} /> Open in chat mode
      </button>
      <div ref={end} />
    </div>
  );
}

function formatSeconds(total: number) {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
