// Phase 1 smoke test: Jarvis remembers the user across a cleared chat.
//
//   1. Tell Jarvis some facts; the background pass saves them
//   2. Say a paraphrase of a known fact; no duplicate should be saved
//   3. Add a task and a note through chat
//   4. Ask Jarvis to forget a fact; approve the tool call
//   5. Clear the chat, then ask what Jarvis remembers
//
// Usage: node scripts/smoke-memory.mjs [baseUrl]

import { agentClient, checker, sleep } from "./agent-test-client.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:5173";
const { wsUrl, Connection, chat, rpc } = agentClient(
  baseUrl,
  `smoke-mem-${crypto.randomUUID()}`
);
const { check, finish } = checker();
const memory = () => rpc("getMemory");

/** Fact extraction runs in the background after the reply; poll for it. */
async function waitForFacts(atLeast, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let m = await memory();
  while (m.facts.length < atLeast && Date.now() < deadline) {
    await sleep(1_000);
    m = await memory();
  }
  return m;
}

const factTexts = (m) => m.facts.map((f) => f.text);
const mentionsTools = (reply) => /\b(function|tool)s?\b/i.test(reply);

console.log(`instance: ${wsUrl}\n`);

// 1. Facts are extracted in the background
console.log("1. Tell Jarvis about yourself");
const intro = await chat(
  "Hi! I'm vegetarian, I live in Bengaluru, and my sister is called Priya."
);
let m = await waitForFacts(2);
check("facts extracted", m.facts.length >= 2, JSON.stringify(factTexts(m)));
check("no notes created for facts", m.notes.length === 0);
const factCountBefore = m.facts.length;

// 2. A paraphrase of a known fact should not add a duplicate
console.log("\n2. Paraphrase a known fact");
const paraphrase = await chat("Just so you know, I don't eat meat.");
check(
  "replies don't mention tools",
  !mentionsTools(intro.reply) && !mentionsTools(paraphrase.reply)
);
await sleep(8_000);
m = await memory();
check(
  "no duplicate for paraphrase",
  m.facts.length === factCountBefore,
  m.facts.length === factCountBefore
    ? ""
    : `added ${JSON.stringify(factTexts(m).slice(factCountBefore))}`
);

// 3. Tasks and notes through tools
console.log("\n3. Add a task and a note");
const taskTurn = await chat("Add a task to call Raj tomorrow at 3pm");
m = await memory();
check(
  "add_task called and saved",
  taskTurn.tools.some((t) => t.name === "add_task") && m.tasks.length === 1,
  JSON.stringify(m.tasks)
);
const noteTurn = await chat(
  "Save a note: book ideas are Atomic Habits and Deep Work"
);
m = await memory();
check(
  "add_note called and saved",
  noteTurn.tools.some((t) => t.name === "add_note") && m.notes.length === 1,
  JSON.stringify(m.notes.map((n) => n.body))
);

// 4. forget_fact needs approval; approve it over the same connection
console.log("\n4. Forget a fact (needs approval)");
const cityFact = m.facts.find((f) => /bengaluru|bangalore/i.test(f.text));
{
  const conn = await new Connection().open();
  const turn = await conn.chat("Please forget where I live.");
  const call = turn.tools.find((t) => t.name === "forget_fact");
  check(
    "forget_fact requested approval",
    Boolean(call) && turn.approvals.length > 0,
    call
      ? `id ${call.input.id} (city fact is ${cityFact?.id})`
      : "no forget_fact call"
  );
  if (call && turn.approvals.length > 0) {
    const continuation = conn.collectTurn();
    conn.send({
      type: "cf_agent_tool_approval",
      toolCallId: call.id,
      approved: true,
      autoContinue: true
    });
    const after = await continuation.catch(() => ({ reply: "" }));
    console.log(`  < ${after.reply.trim() || "(no text)"}`);
  }
  conn.close();
}
m = await memory();
check(
  "city fact forgotten",
  !m.facts.some((f) => /bengaluru|bangalore/i.test(f.text)),
  JSON.stringify(factTexts(m))
);

// 5. Memory survives a cleared chat
console.log("\n5. Clear the chat, then ask what Jarvis remembers");
{
  const conn = await new Connection().open();
  conn.send({ type: "cf_agent_chat_clear" });
  await sleep(1_000);
  conn.close();
}
const cleared = await new Connection().open();
check(
  "chat history cleared",
  cleared.history.length === 0,
  `${cleared.history.length} messages left`
);
cleared.close();
const recall = await chat("What do you remember about me?");
check(
  "recalls facts after clear",
  /vegetarian/i.test(recall.reply) && /priya/i.test(recall.reply),
  "expects vegetarian + Priya"
);

finish();
