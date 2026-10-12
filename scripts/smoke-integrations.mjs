// Integrations smoke test: OpenAPI specs → tools, and MCP servers.
//
//   1. Reject unsupported specs; convert Open-Meteo's spec into a tool
//   2. Jarvis calls the read-only weather tool without asking
//   3. A POST operation asks for approval instead of running
//   4. Connect the Cloudflare docs MCP server; Jarvis uses its tool
//   5. Remove both; nothing is left
//
// Usage: node scripts/smoke-integrations.mjs [baseUrl]

import { agentClient, checker, sleep } from "./agent-test-client.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:5173";
const { wsUrl, withConnection, chat, rpc } = agentClient(
  baseUrl,
  `smoke-int-${crypto.randomUUID()}`
);
const { check, finish } = checker();

async function rejection(promise) {
  try {
    await promise;
    return "";
  } catch (error) {
    return error.message;
  }
}

const echoSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Echo", version: "1" },
  servers: [{ url: "https://postman-echo.com" }],
  paths: {
    "/post": {
      post: {
        operationId: "echoMessage",
        summary: "Send a message to the echo service",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"]
              }
            }
          }
        },
        responses: { 200: { description: "Echoed" } }
      }
    }
  }
});

console.log(`instance: ${wsUrl}\n`);
await rpc("setTimezone", "Asia/Kolkata");

// 1. Specs
console.log("1. Convert specs");
check(
  "rejects Swagger 2.0",
  /swagger 2\.0/i.test(
    await rejection(
      rpc("addApi", { name: "Old", specText: 'swagger: "2.0"\npaths: {}' })
    )
  )
);
check(
  "asks for a base URL when the spec has none",
  /base url/i.test(
    await rejection(
      rpc("addApi", {
        name: "No server",
        specText:
          '{"openapi":"3.0.0","info":{"title":"x","version":"1"},"paths":{"/a":{"get":{"responses":{}}}}}'
      })
    )
  )
);
const weather = await rpc("addApi", {
  name: "Weather",
  specUrl:
    "https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi/forecast.yml",
  baseUrl: "https://api.open-meteo.com"
});
check(
  "Open-Meteo spec converted",
  weather.toolCount === 1,
  JSON.stringify(weather)
);
let integrations = await rpc("getIntegrations");
check(
  "weather tool listed",
  integrations.apis[0]?.tools[0]?.name === "api_weather_get_v1_forecast",
  integrations.apis[0]?.tools[0]?.name
);

// 2. Read-only call runs without approval
console.log("\n2. Read-only API call");
const weatherTurn = await chat(
  "What's the current temperature in Bengaluru (latitude 12.97, longitude 77.59)? Use the weather API."
);
check(
  "weather tool called without approval",
  weatherTurn.tools.some((t) => t.name === "api_weather_get_v1_forecast") &&
    weatherTurn.approvals.length === 0
);
check(
  "reply has a temperature",
  /\d/.test(weatherTurn.reply),
  weatherTurn.reply
);

// 3. A write operation asks first
console.log("\n3. Write operation needs approval");
await rpc("addApi", { name: "Echo", specText: echoSpec });
const echoTurn = await chat("Use the echo API to send the message hello");
check(
  "POST tool asks for approval",
  echoTurn.tools.some((t) => t.name === "api_echo_echoMessage") &&
    echoTurn.approvals.length > 0
);

// 4. MCP server
console.log("\n4. MCP server");
const added = await rpc("addMcp", {
  name: "Cloudflare docs",
  url: "https://docs.mcp.cloudflare.com/mcp"
});
console.log(`  addMcp → ${JSON.stringify(added)}`);
for (let i = 0; i < 15; i++) {
  integrations = await rpc("getIntegrations");
  const server = integrations.mcp[0];
  if (server?.state === "ready" && server.tools.length > 0) break;
  await sleep(2_000);
}
const server = integrations.mcp[0];
check(
  "MCP server ready with tools",
  server?.state === "ready" && server.tools.length > 0,
  `${server?.state} · ${server?.tools.map((t) => t.name).join(", ")}`
);
const docsTurn = await withConnection((c) =>
  c.chatAndApprove(
    "Search the Cloudflare docs: what are Durable Object alarms? One sentence."
  )
);
check(
  "MCP tool called",
  docsTurn.tools.some((t) => t.name.startsWith("tool_")),
  docsTurn.tools.map((t) => t.name).join(", ")
);

// 5. Remove
console.log("\n5. Remove integrations");
for (const api of (await rpc("getIntegrations")).apis)
  await rpc("removeApi", api.id);
await rpc("removeMcp", server.id);
integrations = await rpc("getIntegrations");
check(
  "everything removed",
  integrations.apis.length === 0 && integrations.mcp.length === 0
);

finish();
