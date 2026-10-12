// OpenAPI 3.x → MCP-style tools. Each operation becomes a tool with a name,
// a description and a JSON Schema input, the same shape an MCP server would
// advertise. The mapping follows open-source OpenAPI→MCP converters
// (e.g. TykTechnologies/api-to-mcp): the name comes from operationId (or
// method + path), path parameters are required arguments, query and header
// parameters are optional ones, and a JSON request body becomes a `body`
// object argument. `callOperation` is the shim that makes the HTTP request.

import { parse as parseYaml } from "yaml";

type Json = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

export type ApiParam = {
  name: string;
  in: "path" | "query" | "header";
  explode: boolean; // query arrays: repeat the key (true) or join with commas
};

export type ApiTool = {
  name: string; // e.g. "findPetsByStatus"
  description: string;
  method: string; // lower case
  path: string; // "/pet/{petId}"
  inputSchema: JsonSchema;
  params: ApiParam[];
  hasBody: boolean;
  readOnly: boolean; // GET/HEAD: runs without approval
};

export type ConvertedApi = {
  title: string;
  baseUrl: string | null;
  tools: ApiTool[];
  skipped: number; // operations over the cap
};

const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;
const MAX_SCHEMA_DEPTH = 4;
const MAX_RESPONSE_CHARS = 4_000;
// Tool schemas share Llama 3.3's 24K-token context with the chat
const MAX_TOOL_TOKENS = 700;
const MAX_ENUM_VALUES = 12;
const MAX_DESCRIPTION = 160;

export const estimateTokens = (value: unknown) =>
  Math.ceil(JSON.stringify(value).length / 4);

/** JSON or YAML text → an OpenAPI 3.x document. */
export function parseSpec(text: string): Json {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = parseYaml(text);
  }
  const spec = doc as Json | null;
  if (!spec || typeof spec !== "object") {
    throw new Error("That isn't a JSON or YAML document.");
  }
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    throw new Error(
      spec.swagger
        ? "Swagger 2.0 isn't supported; use an OpenAPI 3.x spec."
        : "Not an OpenAPI 3.x spec (missing `openapi: 3.x`)."
    );
  }
  if (!spec.paths || typeof spec.paths !== "object") {
    throw new Error("The spec has no paths.");
  }
  return spec;
}

/** Turn a spec into tools, keeping at most `maxTools` operations. */
export function convertSpec(
  spec: Json,
  options: { maxTools: number; specUrl?: string }
): ConvertedApi {
  const info = (spec.info ?? {}) as Json;
  const resolve = makeResolver(spec);
  const tools: ApiTool[] = [];
  const used = new Set<string>();
  let skipped = 0;

  for (const [path, rawItem] of Object.entries(spec.paths as Json)) {
    const item = resolve(rawItem) as Json;
    const shared = (item.parameters as unknown[]) ?? [];
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      if (tools.length >= options.maxTools) {
        skipped++;
        continue;
      }
      tools.push(toTool(method, path, op, shared, resolve, used));
    }
  }

  return {
    title: typeof info.title === "string" ? info.title : "API",
    baseUrl: baseUrlOf(spec, options.specUrl),
    tools,
    skipped
  };
}

function toTool(
  method: string,
  path: string,
  op: Json,
  shared: unknown[],
  resolve: (value: unknown) => unknown,
  used: Set<string>
): ApiTool {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const params: ApiParam[] = [];

  // Operation-level parameters override path-level ones with the same name
  const byKey = new Map<string, Json>();
  for (const raw of [...shared, ...((op.parameters as unknown[]) ?? [])]) {
    const p = resolve(raw) as Json;
    if (typeof p?.name === "string") byKey.set(`${p.in}:${p.name}`, p);
  }
  for (const p of byKey.values()) {
    const location = p.in;
    if (location !== "path" && location !== "query" && location !== "header") {
      continue; // cookies aren't supported
    }
    const name = p.name as string;
    // OpenAPI defaults: query parameters use style=form, which explodes
    params.push({ name, in: location, explode: p.explode !== false });
    properties[name] = {
      ...simplify(resolve(p.schema) ?? { type: "string" }, resolve, 0),
      ...(p.description
        ? { description: clip(String(p.description), MAX_DESCRIPTION) }
        : {})
    };
    if (location === "path" || p.required) required.push(name);
  }

  const body = resolve(op.requestBody) as Json | undefined;
  const jsonBody = (body?.content as Json | undefined)?.["application/json"] as
    | Json
    | undefined;
  if (jsonBody) {
    properties.body = {
      ...simplify(resolve(jsonBody.schema) ?? { type: "object" }, resolve, 0),
      description: "JSON request body"
    };
    if (body?.required) required.push("body");
  }

  // Over budget: drop optional arguments from the end until it fits
  let trimmed = false;
  const optional = Object.keys(properties).filter((k) => !required.includes(k));
  while (estimateTokens(properties) > MAX_TOOL_TOKENS && optional.length > 0) {
    const name = optional.pop() as string;
    delete properties[name];
    const index = params.findIndex((p) => p.name === name);
    if (index >= 0) params.splice(index, 1);
    trimmed = true;
  }

  const summary = String(op.summary ?? op.description ?? "").trim();
  return {
    name: uniqueName(
      typeof op.operationId === "string" ? op.operationId : `${method}_${path}`,
      used
    ),
    description: `${clip(summary || `${method.toUpperCase()} ${path}`, 280)} (${method.toUpperCase()} ${path})${trimmed ? " Some optional parameters are omitted." : ""}`,
    method,
    path,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {})
    },
    params,
    hasBody: Boolean(jsonBody) && "body" in properties,
    readOnly: method === "get" || method === "head"
  };
}

/**
 * Keep the parts of a schema a small model can follow: types, descriptions,
 * enums, nested properties (depth-limited). allOf is merged; oneOf/anyOf
 * take the first option.
 */
function simplify(
  raw: unknown,
  resolve: (value: unknown) => unknown,
  depth: number
): JsonSchema {
  const schema = resolve(raw) as Json | undefined;
  if (!schema || typeof schema !== "object") return {};
  if (Array.isArray(schema.allOf)) {
    const merged: Json = { type: "object", properties: {} };
    for (const part of schema.allOf) {
      const s = simplify(part, resolve, depth);
      Object.assign(merged.properties as Json, s.properties ?? {});
    }
    return merged;
  }
  const choice = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined;
  if (Array.isArray(choice) && choice.length > 0) {
    return simplify(choice[0], resolve, depth);
  }

  const out: JsonSchema = {};
  for (const key of ["type", "format", "default"] as const) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  let description = schema.description ? String(schema.description) : "";
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length <= MAX_ENUM_VALUES) out.enum = schema.enum;
    // Long enums become examples in the description instead
    else
      description =
        `${description} e.g. ${schema.enum.slice(0, 6).join(", ")}`.trim();
  }
  if (description) out.description = clip(description, MAX_DESCRIPTION);
  if (depth >= MAX_SCHEMA_DEPTH) return out;
  if (schema.properties && typeof schema.properties === "object") {
    out.type ??= "object";
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Json).map(([k, v]) => [
        k,
        simplify(v, resolve, depth + 1)
      ])
    );
    if (Array.isArray(schema.required)) out.required = schema.required;
  }
  if (schema.items) out.items = simplify(schema.items, resolve, depth + 1);
  return out;
}

/** Resolves local `$ref`s ("#/components/..."); cycles resolve to `{}`. */
function makeResolver(spec: Json) {
  return function resolve(value: unknown, seen = new Set<string>()): unknown {
    const ref = (value as Json | null)?.$ref;
    if (typeof ref !== "string") return value;
    if (!ref.startsWith("#/") || seen.has(ref)) return {};
    seen.add(ref);
    let target: unknown = spec;
    for (const raw of ref.slice(2).split("/")) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      target = (target as Json | undefined)?.[key];
    }
    return resolve(target, seen);
  };
}

function baseUrlOf(spec: Json, specUrl?: string): string | null {
  const server = ((spec.servers as Json[] | undefined) ?? [])[0];
  if (!server || typeof server.url !== "string") return null;
  // Fill server variables with their defaults: https://{region}.api.com
  let url = server.url.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const variable = (server.variables as Json | undefined)?.[name] as
      | Json
      | undefined;
    return String(variable?.default ?? "");
  });
  if (specUrl && !/^https?:\/\//.test(url)) url = new URL(url, specUrl).href;
  return url.replace(/\/+$/, "");
}

function uniqueName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[{}]/g, "")
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "operation";
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
  used.add(name);
  return name;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The HTTP shim: run one operation with the model's arguments. */
export async function callOperation(
  tool: ApiTool,
  args: Record<string, unknown>,
  connection: { baseUrl: string; headers: Record<string, string> }
): Promise<string> {
  let path = tool.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { ...connection.headers };

  for (const param of tool.params) {
    const value = args[param.name];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const items = Array.isArray(value) ? value.map(String) : null;
    const text =
      items?.join(",") ??
      (typeof value === "object" ? JSON.stringify(value) : String(value));
    if (param.in === "path") {
      path = path.replace(`{${param.name}}`, encodeURIComponent(text));
    } else if (param.in === "query") {
      // Arrays per OpenAPI: ?k=a&k=b when exploded, ?k=a,b when not
      if (items && param.explode) {
        for (const item of items) query.append(param.name, item);
      } else {
        query.set(param.name, text);
      }
    } else {
      headers[param.name] = text;
    }
  }
  if (/\{[^}]+\}/.test(path)) {
    return `Missing path parameter for ${tool.path}.`;
  }

  const url = `${connection.baseUrl}${path}${query.size ? `?${query}` : ""}`;
  const init: RequestInit = {
    method: tool.method.toUpperCase(),
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15_000)
  };
  if (tool.hasBody && args.body !== undefined) {
    init.body = JSON.stringify(args.body);
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
  }

  const response = await fetch(url, init);
  const text = await response.text();
  return `HTTP ${response.status}\n${clip(text, MAX_RESPONSE_CHARS)}`;
}
