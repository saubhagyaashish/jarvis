// Phase 2 smoke test: Jarvis acts on its own.
//
//   1. Seed a fact and a task due today; set a 1-minute reminder
//   2. Run the morning briefing Workflow and wait for it in state and chat
//   3. Turn the daily briefing on (cron in UTC) and off through chat
//   4. Set a reminder for tomorrow, then cancel it (needs approval)
//   5. The 1-minute reminder fires into the inbox
//
// Usage: node scripts/smoke-briefing.mjs [baseUrl]

import { agentClient, checker, sleep } from "./agent-test-client.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:5173";
const { wsUrl, withConnection, history, chat, rpc, state } = agentClient(
  baseUrl,
  `smoke-brief-${crypto.randomUUID()}`
);
const { check, finish } = checker();
const memory = () => rpc("getMemory");

async function waitUntil(read, done, timeoutMs, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(intervalMs);
    value = await read();
  }
  return value;
}

console.log(`instance: ${wsUrl}\n`);
await rpc("setTimezone", "Asia/Kolkata");

// 1. Seed
console.log("1. Seed a fact, a task due today and a 1-minute reminder");
await chat("I'm vegetarian and I love cricket.");
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata"
}).format(new Date());
await chat("Add a task to submit the quarterly report, due today at 11:59pm");
let m = await memory();
check(
  "task due today saved",
  m.tasks.some((t) => /report/i.test(t.title) && t.due_at?.startsWith(today)),
  JSON.stringify(m.tasks)
);
const reminderTurn = await chat("Remind me in 1 minute to stretch");
m = await memory();
check(
  "set_reminder called once and listed",
  reminderTurn.tools.some((t) => t.name === "set_reminder") &&
    m.reminders.filter((r) => /stretch/i.test(r.text)).length === 1,
  JSON.stringify(m.reminders)
);

// 2. Briefing Workflow
console.log("\n2. Run the morning briefing Workflow");
const started = await rpc("runBriefingNow");
check("runBriefingNow started", started === "started", String(started));
const s = await waitUntil(
  state,
  (st) => st?.workflowStatus !== "running",
  120_000
);
check(
  "workflow finished",
  s?.workflowStatus === "idle" && Boolean(s?.lastBriefing?.text),
  s?.workflowStatus === "failed"
    ? `failed: ${s.briefingError}`
    : s?.workflowStatus
);
console.log(`  briefing: ${s?.lastBriefing?.text?.replace(/\n+/g, " / ")}`);
check(
  "briefing mentions the due task",
  /report/i.test(s?.lastBriefing?.text ?? "")
);
const messages = await waitUntil(
  history,
  (h) => h.some((msg) => msg.id.startsWith("briefing-")),
  30_000,
  1_000
);
check(
  "briefing posted in chat",
  messages.some(
    (msg) => msg.id.startsWith("briefing-") && msg.role === "assistant"
  )
);

// 3. Daily schedule on and off
console.log("\n3. Daily briefing on and off");
const onTurn = await chat("Brief me every morning at 8");
const schedule = await rpc("getBriefingSchedule");
check(
  "set_briefing at 08:00 IST → cron 30 2 * * *",
  onTurn.tools.some((t) => t.name === "set_briefing") &&
    schedule?.cron === "30 2 * * *",
  JSON.stringify(schedule)
);
check(
  "no unrequested tool calls",
  onTurn.tools.length === 1,
  onTurn.tools.map((t) => t.name).join(", ")
);
m = await memory();
check(
  "task and reminder untouched",
  m.tasks.some((t) => /report/i.test(t.title) && !t.done) &&
    m.reminders.some((r) => /stretch/i.test(r.text))
);
const offTurn = await chat("Turn off my morning briefing");
check(
  "set_briefing off removes the schedule",
  offTurn.tools.some((t) => t.name === "set_briefing") &&
    (await rpc("getBriefingSchedule")) === null
);

// 4. Cancel a reminder (approval)
console.log("\n4. Set and cancel a reminder");
await chat("Remind me tomorrow at 9am to buy milk");
m = await memory();
const milk = m.reminders.find((r) => /milk/i.test(r.text));
check(
  "tomorrow 9am reminder at 03:30 UTC",
  Boolean(milk) && new Date(milk.time).toISOString().slice(11, 16) === "03:30",
  milk ? new Date(milk.time).toISOString() : "not found"
);
await withConnection((c) => c.chatAndApprove("Cancel the milk reminder"));
m = await memory();
check(
  "milk reminder cancelled",
  !m.reminders.some((r) => /milk/i.test(r.text)),
  JSON.stringify(m.reminders)
);

// 5. The 1-minute reminder fires
console.log("\n5. Wait for the 1-minute reminder to fire");
const fired = await waitUntil(
  state,
  (st) => (st?.inbox ?? []).some((r) => /stretch/i.test(r.text)),
  120_000,
  3_000
);
check(
  "reminder fired into inbox",
  (fired?.inbox ?? []).some((r) => /stretch/i.test(r.text)),
  JSON.stringify(fired?.inbox)
);
m = await memory();
check(
  "fired reminder no longer upcoming",
  !m.reminders.some((r) => /stretch/i.test(r.text))
);

finish();
