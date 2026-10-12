import { Badge, Button, Text } from "@cloudflare/kumo";
import {
  AlarmIcon,
  BellRingingIcon,
  BrainIcon,
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  ListChecksIcon,
  NoteIcon,
  PlayIcon,
  SunHorizonIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import type { JarvisState, Memory } from "./memory";

export type BriefingSchedule = {
  time: string;
  cron: string;
  nextRun: number;
};

type Props = {
  memory: Memory | null;
  state: JarvisState | null;
  briefingSchedule: BriefingSchedule | null;
  onRemoveFact: (id: string) => void;
  onToggleTask: (id: string, done: boolean) => void;
  onRemoveTask: (id: string) => void;
  onRemoveNote: (id: string) => void;
  onRunBriefing: () => void;
  onSetBriefingTime: (time: string | null) => void;
  onRemoveReminder: (id: string) => void;
  onDismissReminder: (id: string) => void;
};

/** Side panel: the briefing, reminders and everything Jarvis has stored. */
export function MemoryPanel({
  memory,
  state,
  briefingSchedule,
  onRemoveFact,
  onToggleTask,
  onRemoveTask,
  onRemoveNote,
  onRunBriefing,
  onSetBriefingTime,
  onRemoveReminder,
  onDismissReminder
}: Props) {
  if (!memory) {
    return (
      <div className="p-5">
        <Text size="sm" variant="secondary">
          Loading memory…
        </Text>
      </div>
    );
  }

  const openTasks = memory.tasks.filter((t) => !t.done).length;
  const inbox = [...(state?.inbox ?? [])].reverse();

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
      <BriefingCard
        state={state}
        schedule={briefingSchedule}
        onRun={onRunBriefing}
        onSetTime={onSetBriefingTime}
      />

      <Section
        icon={<AlarmIcon size={16} className="text-kumo-brand" />}
        title="Reminders"
        count={memory.reminders.length}
        empty='Try "Remind me in 2 minutes to stretch".'
        action={<NotificationsButton />}
      >
        {[
          ...inbox.map((item) => (
            <Row
              key={item.id}
              label="Dismiss reminder"
              onRemove={() => onDismissReminder(item.id)}
            >
              <span className="flex items-start gap-2">
                <BellRingingIcon
                  size={16}
                  weight="fill"
                  className="mt-0.5 shrink-0 text-kumo-warning"
                />
                <span>
                  <span className="text-sm text-kumo-default">{item.text}</span>
                  <span className="block text-xs text-kumo-subtle">
                    Reminded {formatTime(Date.parse(item.firedAt))}
                  </span>
                </span>
              </span>
            </Row>
          )),
          ...memory.reminders.map((reminder) => (
            <Row
              key={reminder.id}
              label={`Cancel reminder "${reminder.text}"`}
              onRemove={() => onRemoveReminder(reminder.id)}
            >
              <span className="text-sm text-kumo-default">{reminder.text}</span>
              <span className="block text-xs text-kumo-subtle">
                {formatTime(reminder.time)}
              </span>
            </Row>
          ))
        ]}
      </Section>

      <Section
        icon={<BrainIcon size={16} className="text-kumo-brand" />}
        title="What Jarvis knows"
        count={memory.facts.length}
        empty="Tell Jarvis about yourself and it will remember."
      >
        {memory.facts.map((fact) => (
          <Row
            key={fact.id}
            label={`Forget "${fact.text}"`}
            onRemove={() => onRemoveFact(fact.id)}
          >
            <span className="text-sm text-kumo-default">{fact.text}</span>
          </Row>
        ))}
      </Section>

      <Section
        icon={<ListChecksIcon size={16} className="text-kumo-brand" />}
        title="Tasks"
        count={openTasks}
        empty='Try "Add a task to call Raj tomorrow at 3pm".'
      >
        {memory.tasks.map((task) => (
          <Row
            key={task.id}
            label={`Delete task "${task.title}"`}
            onRemove={() => onRemoveTask(task.id)}
          >
            <button
              type="button"
              onClick={() => onToggleTask(task.id, !task.done)}
              aria-label={task.done ? "Mark as not done" : "Mark as done"}
              className="flex items-start gap-2 text-left"
            >
              {task.done ? (
                <CheckCircleIcon
                  size={16}
                  weight="fill"
                  className="mt-0.5 shrink-0 text-kumo-success"
                />
              ) : (
                <CircleIcon
                  size={16}
                  className="mt-0.5 shrink-0 text-kumo-inactive"
                />
              )}
              <span>
                <span
                  className={`text-sm ${task.done ? "line-through text-kumo-inactive" : "text-kumo-default"}`}
                >
                  {task.title}
                </span>
                {task.due_at && (
                  <span className="block text-xs text-kumo-subtle">
                    Due {formatDue(task.due_at)}
                  </span>
                )}
              </span>
            </button>
          </Row>
        ))}
      </Section>

      <Section
        icon={<NoteIcon size={16} className="text-kumo-brand" />}
        title="Notes"
        count={memory.notes.length}
        empty='Try "Save a note: book ideas are Atomic Habits and Deep Work".'
      >
        {memory.notes.map((note) => (
          <Row
            key={note.id}
            label="Delete note"
            onRemove={() => onRemoveNote(note.id)}
          >
            <span className="text-sm text-kumo-default whitespace-pre-wrap">
              {note.body}
            </span>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function BriefingCard({
  state,
  schedule,
  onRun,
  onSetTime
}: {
  state: JarvisState | null;
  schedule: BriefingSchedule | null;
  onRun: () => void;
  onSetTime: (time: string | null) => void;
}) {
  const savedTime = state?.briefingTime ?? "";
  const [draft, setDraft] = useState(savedTime || "08:00");
  useEffect(() => {
    if (savedTime) setDraft(savedTime);
  }, [savedTime]);

  const running = state?.workflowStatus === "running";
  const failed = state?.workflowStatus === "failed";
  const briefing = state?.lastBriefing;

  return (
    <section className="rounded-xl border border-kumo-line p-4 space-y-3">
      <div className="flex items-center gap-2">
        <SunHorizonIcon size={16} className="text-kumo-brand" />
        <Text size="sm" bold>
          Morning briefing
        </Text>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="time"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Daily briefing time"
          className="px-2 py-1 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!draft || draft === savedTime}
          onClick={() => onSetTime(draft)}
        >
          {savedTime ? "Update" : "Turn on"}
        </Button>
        {savedTime && (
          <Button variant="ghost" size="sm" onClick={() => onSetTime(null)}>
            Off
          </Button>
        )}
      </div>
      <Text size="xs" variant="secondary">
        {schedule
          ? `Daily at ${schedule.time} · next ${formatTime(schedule.nextRun)}`
          : "Off. Jarvis can brief you every morning."}
      </Text>

      <Button
        variant="primary"
        size="sm"
        disabled={running}
        icon={
          running ? (
            <CircleNotchIcon size={14} className="animate-spin" />
          ) : (
            <PlayIcon size={14} />
          )
        }
        onClick={onRun}
      >
        {running ? "Composing briefing…" : "Run briefing now"}
      </Button>

      {failed && (
        <Text size="xs" variant="secondary">
          <span className="text-kumo-danger">
            Last run failed: {state?.briefingError ?? "unknown error"}
          </span>
        </Text>
      )}

      {briefing && (
        <div className="rounded-lg bg-kumo-control p-3">
          <p className="text-sm text-kumo-default whitespace-pre-wrap">
            {briefing.text}
          </p>
          <span className="block mt-2 text-xs text-kumo-subtle">
            {formatTime(Date.parse(briefing.createdAt))}
          </span>
        </div>
      )}
    </section>
  );
}

/** Ask for browser notifications, so reminders show up outside the tab. */
function NotificationsButton() {
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "denied"
  );
  if (!supported || permission !== "default") return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        Notification.requestPermission().then((p) => setPermission(p))
      }
    >
      Enable notifications
    </Button>
  );
}

function Section({
  icon,
  title,
  count,
  empty,
  action,
  children
}: {
  icon: ReactNode;
  title: string;
  count: number;
  empty: string;
  action?: ReactNode;
  children: ReactNode[];
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <Text size="sm" bold>
          {title}
        </Text>
        {count > 0 && <Badge variant="secondary">{count}</Badge>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children.length === 0 ? (
        <Text size="xs" variant="secondary">
          {empty}
        </Text>
      ) : (
        <ul className="space-y-1">{children}</ul>
      )}
    </section>
  );
}

function Row({
  label,
  onRemove,
  children
}: {
  label: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <li className="group flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-kumo-control">
      <div className="min-w-0 flex-1">{children}</div>
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        aria-label={label}
        icon={<XIcon size={12} />}
        onClick={onRemove}
        className="opacity-60 group-hover:opacity-100"
      />
    </li>
  );
}

/** "2026-10-13T15:00" (user-local) → "Tue 13 Oct, 15:00". */
/** Epoch ms → "Tue 13 Oct, 09:00" in the browser's timezone. */
function formatTime(epochMs: number): string {
  if (Number.isNaN(epochMs)) return "";
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDue(dueAt: string): string {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return dueAt;
  const hasTime = dueAt.includes("T");
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(hasTime ? { hour: "2-digit", minute: "2-digit" } : {})
  });
}
