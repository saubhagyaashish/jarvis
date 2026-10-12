// Phase 1 smoke test: Jarvis remembers the user across a cleared chat.
//
//   1. Tell Jarvis some facts; the background pass saves them
//   2. Say a paraphrase of a known fact; no duplicate should be saved
//   3. Add a task and a note through chat
//   4. Ask Jarvis to forget a fact; approve the tool call
//   5. Clear the chat, then ask what Jarvis remembers
//
// Usage: node scripts/smoke-memory.mjs [baseUrl]

const baseUrl = process.argv[2] ?? "http://localhost:5173";
const instance = `smoke-mem-${crypto.randomUUID()}`;
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/agents/jarvis-agent/${instance}`;
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One WebSocket connection to the agent instance. */
class Connection {
  constructor() {
    this.ws = new WebSocket(wsUrl);
    this.history = null; // full chat history the server syncs on connect
    this.listeners = new Set();
    this.ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.type === "cf_agent_chat_messages") this.history = data.messages;
      for (const listener of this.listeners) listener(data);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener(
        "error",
        () => reject(new Error(`cannot connect to ${wsUrl}`)),
        {
          once: true
        }
      );
    });
    // Give the server a moment to sync the existing history
    for (let i = 0; i < 20 && this.history === null; i++) await sleep(100);
    this.history ??= [];
    return this;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  rpc(method, ...args) {
    const id = crypto.randomUUID();
    return this.waitFor(
      (data) => {
        if (data.type !== "rpc" || data.id !== id) return undefined;
        if (!data.success) throw new Error(`rpc ${method}: ${data.error}`);
        return data.result;
      },
      () => this.send({ type: "rpc", id, method, args })
    );
  }

  /** Collect one streamed turn (any request id) until it reports done. */
  collectTurn(requestId) {
    const turn = { reply: "", tools: [], approvals: [] };
    return this.waitFor(
      (data) => {
        if (data.type !== "cf_agent_use_chat_response") return undefined;
        if (requestId && data.id !== requestId) return undefined;
        if (data.error) throw new Error(`agent error: ${data.body}`);
        if (data.body) {
          const chunk = JSON.parse(data.body);
          if (chunk.type === "text-delta") turn.reply += chunk.delta;
          if (chunk.type === "tool-input-available") {
            turn.tools.push({
              name: chunk.toolName,
              input: chunk.input,
              id: chunk.toolCallId
            });
          }
          if (chunk.type === "tool-approval-request")
            turn.approvals.push(chunk.toolCallId);
        }
        return data.done ? turn : undefined;
      },
      () => {},
      90_000
    );
  }

  async chat(text) {
    const requestId = crypto.randomUUID();
    const message = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
    const turn = this.collectTurn(requestId);
    this.send({
      id: requestId,
      type: "cf_agent_use_chat_request",
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [...this.history, message],
          trigger: "submit-message"
        })
      }
    });
    const result = await turn;
    console.log(`  > ${text}`);
    for (const t of result.tools)
      console.log(`    tool: ${t.name}(${JSON.stringify(t.input)})`);
    console.log(`  < ${result.reply.trim() || "(no text)"}`);
    return result;
  }

  waitFor(match, start, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("timed out"));
      }, timeoutMs);
      const listener = (data) => {
        try {
          const value = match(data);
          if (value === undefined) return;
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(value);
        } catch (error) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          reject(error);
        }
      };
      this.listeners.add(listener);
      start();
    });
  }

  close() {
    this.ws.close();
  }
}

/** Each chat turn on a fresh connection, so it starts from the server's saved history. */
async function chat(text) {
  const conn = await new Connection().open();
  try {
    return await conn.chat(text);
  } finally {
    conn.close();
  }
}

async function memory() {
  const conn = await new Connection().open();
  try {
    return await conn.rpc("getMemory");
  } finally {
    conn.close();
  }
}

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

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`
);
process.exit(failed.length > 0 ? 1 : 0);
