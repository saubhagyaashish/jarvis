import { Badge, Button, Text } from "@cloudflare/kumo";
import {
  BrainIcon,
  CheckCircleIcon,
  CircleIcon,
  ListChecksIcon,
  NoteIcon,
  XIcon
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Memory } from "./memory";

type Props = {
  memory: Memory | null;
  onRemoveFact: (id: string) => void;
  onToggleTask: (id: string, done: boolean) => void;
  onRemoveTask: (id: string) => void;
  onRemoveNote: (id: string) => void;
};

/** Side panel: everything Jarvis has stored about the user, live. */
export function MemoryPanel({
  memory,
  onRemoveFact,
  onToggleTask,
  onRemoveTask,
  onRemoveNote
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

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
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

function Section({
  icon,
  title,
  count,
  empty,
  children
}: {
  icon: ReactNode;
  title: string;
  count: number;
  empty: string;
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
