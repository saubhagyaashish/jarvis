// Minimal WebSocket client for a JarvisAgent, speaking the same protocol as
// the React UI (chat requests, RPC calls, state sync). Used by smoke tests.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PASS/FAIL bookkeeping; `finish()` prints a summary and exits. */
export function checker() {
  const results = [];
  return {
    check(name, ok, detail = "") {
      results.push({ name, ok });
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
      );
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(
        `\n${results.length - failed.length}/${results.length} checks passed`
      );
      process.exit(failed.length > 0 ? 1 : 0);
    }
  };
}

export function agentClient(baseUrl, instance) {
  const httpUrl = `${baseUrl}/agents/jarvis-agent/${instance}`;
  const wsUrl = httpUrl.replace(/^http/, "ws");

  /** Saved chat history; like the React client, read over HTTP on connect. */
  async function fetchHistory() {
    const response = await fetch(`${httpUrl}/get-messages`);
    if (!response.ok) throw new Error(`get-messages: ${response.status}`);
    return response.json();
  }

  /** One WebSocket connection to the agent instance. */
  class Connection {
    constructor() {
      this.ws = new WebSocket(wsUrl);
      this.history = []; // full chat history, loaded in open()
      this.state = null; // agent state, kept current by state broadcasts
      this.listeners = new Set();
      this.ws.addEventListener("message", (event) => {
        let data;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === "cf_agent_chat_messages")
          this.history = data.messages;
        if (data.type === "cf_agent_state") this.state = data.state;
        for (const listener of this.listeners) listener(data);
      });
    }

    async open() {
      await new Promise((resolve, reject) => {
        this.ws.addEventListener("open", resolve, { once: true });
        this.ws.addEventListener(
          "error",
          () => reject(new Error(`cannot connect to ${wsUrl}`)),
          { once: true }
        );
      });
      this.history = await fetchHistory();
      // The server pushes state right after connecting
      for (let i = 0; i < 20 && this.state === null; i++) await sleep(100);
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
          return data.result ?? null;
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
      // The server treats the sent list as the whole history, so send it all
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

    /** Send a chat message, and approve the tool call it asks approval for. */
    async chatAndApprove(text) {
      const turn = await this.chat(text);
      const approvalId = turn.approvals[0];
      if (approvalId) {
        const continuation = this.collectTurn();
        this.send({
          type: "cf_agent_tool_approval",
          toolCallId: approvalId,
          approved: true,
          autoContinue: true
        });
        await continuation.catch(() => null);
      }
      return turn;
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

  /** Run `fn` on a fresh connection, so it starts from the server's saved history. */
  async function withConnection(fn) {
    const conn = await new Connection().open();
    try {
      return await fn(conn);
    } finally {
      conn.close();
    }
  }

  return {
    wsUrl,
    Connection,
    withConnection,
    history: fetchHistory,
    chat: (text) => withConnection((c) => c.chat(text)),
    rpc: (method, ...args) => withConnection((c) => c.rpc(method, ...args)),
    state: () => withConnection(async (c) => c.state)
  };
}
