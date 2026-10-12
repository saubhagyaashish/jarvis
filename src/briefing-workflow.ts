import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
  type DefaultProgress
} from "agents/workflows";
import type { JarvisAgent } from "./server";
import { MODEL, type Briefing } from "./memory";
import { readAiText } from "./single-format-ai";
import { withOllamaFallback } from "./ai-fallback";

export type BriefingParams = { trigger: "scheduled" | "manual" };

/** Everything the briefing needs, read from the agent in one RPC call. */
export type BriefingContext = {
  timezone: string;
  localNow: string;
  facts: string[];
  dueTasks: { title: string; due_at: string; overdue: boolean }[];
  otherTasks: string[];
  reminders: { text: string; at: string }[];
  notes: string[];
};

const BRIEFING_PROMPT = `You are Jarvis, a concise and warm personal assistant. Write the user's morning briefing.
- Under 120 words. Plain text; you may use "- " bullets for tasks.
- Open with a short greeting and today's date.
- List tasks due today and anything overdue first, then today's reminders.
- If nothing is due, say so briefly and mention up to two open tasks.
- End with one short personal touch based on what you know about the user. Never invent anything.`;

function describe(context: BriefingContext): string {
  const list = (lines: string[]) =>
    lines.length > 0 ? lines.map((l) => `- ${l}`).join("\n") : "(none)";
  return `Now: ${context.localNow} (${context.timezone})

Due today or overdue:
${list(context.dueTasks.map((t) => `${t.title} (due ${t.due_at}${t.overdue ? ", overdue" : ""})`))}

Other open tasks:
${list(context.otherTasks)}

Today's reminders:
${list(context.reminders.map((r) => `${r.text} at ${r.at}`))}

Recent notes:
${list(context.notes)}

What you know about the user:
${list(context.facts)}`;
}

/**
 * The morning briefing as a durable Workflow. Each step's result is saved,
 * so a failure (e.g. Workers AI out of capacity) retries that step instead
 * of starting over, and the dashboard shows exactly where a run got to.
 */
export class MorningBriefingWorkflow extends AgentWorkflow<
  JarvisAgent,
  BriefingParams,
  DefaultProgress,
  Env
> {
  async run(
    _event: AgentWorkflowEvent<BriefingParams>,
    step: AgentWorkflowStep
  ) {
    const context = await step.do("load-context", async () => {
      const result: BriefingContext = await this.agent.getBriefingContext();
      return result;
    });

    const briefing = await step.do(
      "compose",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "1 minute"
      },
      async () => {
        // Falls back to Ollama if Workers AI's daily limit is used up
        const output = await withOllamaFallback(this.env.AI, this.env).run(
          MODEL,
          {
            messages: [
              { role: "system", content: BRIEFING_PROMPT },
              { role: "user", content: describe(context) }
            ],
            max_tokens: 400,
            temperature: 0.6
          }
        );
        const text = readAiText(output).trim();
        if (!text) throw new Error("The model returned an empty briefing");
        // Timestamp inside the step so a replay reuses the saved value
        const result: Briefing = { text, createdAt: new Date().toISOString() };
        return result;
      }
    );

    // Durable helpers: each runs once, even if the Workflow is retried
    await step.mergeAgentState({
      lastBriefing: briefing,
      workflowStatus: "idle",
      briefingError: null
    });
    await step.reportComplete(briefing);
    return briefing;
  }
}
