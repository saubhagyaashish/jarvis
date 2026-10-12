// Smoke test: send one chat message to a JarvisAgent over its WebSocket,
// print the streamed reply and any tool calls, then exit.
//
// Usage: node scripts/smoke-chat.mjs [baseUrl] [message]
//   node scripts/smoke-chat.mjs http://localhost:5173 "What's 2+2?"

const baseUrl = process.argv[2] ?? "http://localhost:5173";
const text =
  process.argv[3] ?? "Hi Jarvis, introduce yourself in one sentence.";
const instance = `smoke-${crypto.randomUUID()}`;
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/agents/jarvis-agent/${instance}`;

const requestId = crypto.randomUUID();
const message = {
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }]
};

const ws = new WebSocket(wsUrl);
const timeout = setTimeout(() => fail("timed out after 60s"), 60_000);
let reply = "";
const tools = [];

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

ws.addEventListener("open", () => {
  console.log(`connected: ${wsUrl}`);
  console.log(`> ${text}`);
  ws.send(
    JSON.stringify({
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [message], trigger: "submit-message" })
      },
      type: "cf_agent_use_chat_request"
    })
  );
});

ws.addEventListener("message", (event) => {
  let data;
  try {
    data = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (data.type !== "cf_agent_use_chat_response" || data.id !== requestId)
    return;
  if (data.error) fail(`agent error: ${data.body}`);

  if (data.body) {
    const chunk = JSON.parse(data.body);
    if (chunk.type === "text-delta") reply += chunk.delta;
    if (chunk.type === "tool-input-available")
      tools.push(`${chunk.toolName}(${JSON.stringify(chunk.input)})`);
    if (chunk.type === "tool-output-available")
      tools.push(`  -> ${JSON.stringify(chunk.output)}`);
    if (chunk.type === "error") fail(`stream error: ${chunk.errorText}`);
  }

  if (data.done) {
    clearTimeout(timeout);
    for (const t of tools) console.log(`tool: ${t}`);
    console.log(`< ${reply.trim() || "(no text)"}`);
    ws.close();
    process.exit(reply.trim() || tools.length ? 0 : 1);
  }
});

ws.addEventListener("error", () => fail(`could not connect to ${wsUrl}`));
