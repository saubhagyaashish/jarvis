import { Badge, Button, Text } from "@cloudflare/kumo";
import {
  GlobeIcon,
  PlugsConnectedIcon,
  SignInIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { JarvisAgent } from "./server";

export type Integrations = ReturnType<JarvisAgent["getIntegrations"]>;

type AuthFields = { authHeader?: string; authValue?: string };
export type AddApiInput = {
  name: string;
  specUrl?: string;
  specText?: string;
  baseUrl?: string;
} & AuthFields;
export type AddMcpInput = { name: string; url: string } & AuthFields;

type Props = {
  open: boolean;
  onClose: () => void;
  integrations: Integrations | null;
  onAddApi: (input: AddApiInput) => Promise<unknown>;
  onRemoveApi: (id: string) => Promise<unknown>;
  onAddMcp: (input: AddMcpInput) => Promise<unknown>;
  onRemoveMcp: (id: string) => Promise<unknown>;
};

const inputClass =
  "w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-ring";

/** Connect APIs (from OpenAPI specs) and MCP servers for Jarvis to use. */
export function IntegrationsPanel({
  open,
  onClose,
  integrations,
  onAddApi,
  onRemoveApi,
  onAddMcp,
  onRemoveMcp
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <dialog
        open
        aria-label="Integrations"
        className="relative w-full max-w-xl my-8 rounded-xl bg-kumo-base text-kumo-default ring ring-kumo-line shadow-lg p-5 space-y-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <PlugsConnectedIcon size={18} className="text-kumo-brand" />
              <Text bold>Integrations</Text>
            </div>
            <Text size="xs" variant="secondary">
              Connect MCP servers and APIs (from an OpenAPI spec) for Jarvis to
              use. Read-only calls run directly; anything that could change data
              asks for your approval. Up to{" "}
              {integrations?.maxExternalTools ?? 15} external tools are offered.
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="Close integrations"
            icon={<XIcon size={14} />}
            onClick={onClose}
          />
        </div>

        <section className="space-y-3">
          <Text size="sm" bold>
            MCP servers
          </Text>
          {integrations?.mcp.length === 0 && (
            <Text size="xs" variant="secondary">
              None yet.
            </Text>
          )}
          {integrations?.mcp.map((server) => (
            <Item
              key={server.id}
              title={server.name}
              subtitle={server.url}
              badge={<McpStatus state={server.state} />}
              onRemove={() => onRemoveMcp(server.id)}
              tools={server.tools.map((t) => ({
                name: t.name,
                needsApproval: !t.readOnly
              }))}
            >
              {server.state === "failed" && server.error && (
                <span className="block text-xs text-kumo-danger">
                  {server.error}
                </span>
              )}
              {server.state === "authenticating" && server.authUrl && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<SignInIcon size={12} />}
                  onClick={() =>
                    window.open(
                      server.authUrl as string,
                      "oauth",
                      "width=600,height=800"
                    )
                  }
                >
                  Sign in
                </Button>
              )}
            </Item>
          ))}
          <AddMcpForm onAdd={onAddMcp} />
        </section>

        <section className="space-y-3">
          <Text size="sm" bold>
            APIs from OpenAPI specs
          </Text>
          {integrations?.apis.length === 0 && (
            <Text size="xs" variant="secondary">
              None yet.
            </Text>
          )}
          {integrations?.apis.map((api) => (
            <Item
              key={api.id}
              title={api.name}
              subtitle={api.baseUrl}
              badge={
                api.hasAuth ? (
                  <Badge variant="secondary">Key saved</Badge>
                ) : null
              }
              onRemove={() => onRemoveApi(api.id)}
              tools={api.tools.map((t) => ({
                name: `${t.method} ${t.path}`,
                needsApproval: !t.readOnly
              }))}
            >
              {api.skipped > 0 && (
                <span className="block text-xs text-kumo-subtle">
                  {api.skipped} more operations weren't loaded (limit{" "}
                  {api.tools.length} per API).
                </span>
              )}
            </Item>
          ))}
          <AddApiForm onAdd={onAddApi} />
        </section>
      </dialog>
    </div>
  );
}

function McpStatus({ state }: { state: string }) {
  if (state === "ready") return <Badge variant="primary">Connected</Badge>;
  if (state === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (state === "authenticating")
    return <Badge variant="secondary">Needs sign-in</Badge>;
  return <Badge variant="secondary">Connecting…</Badge>;
}

function Item({
  title,
  subtitle,
  badge,
  tools,
  onRemove,
  children
}: {
  title: string;
  subtitle: string;
  badge: ReactNode;
  tools: { name: string; needsApproval: boolean }[];
  onRemove: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <div className="rounded-lg border border-kumo-line p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-kumo-default">
              {title}
            </span>
            {badge}
          </div>
          <span className="block truncate font-mono text-xs text-kumo-subtle">
            {subtitle}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label={`Remove ${title}`}
          disabled={removing}
          icon={<TrashIcon size={14} />}
          onClick={() => {
            setRemoving(true);
            onRemove().finally(() => setRemoving(false));
          }}
        />
      </div>
      {children}
      {tools.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-kumo-subtle select-none">
            {tools.length} tool{tools.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {tools.map((t) => (
              <li key={t.name} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-kumo-default truncate">
                  {t.name}
                </span>
                <span className="text-kumo-subtle shrink-0">
                  {t.needsApproval ? "asks first" : "read-only"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Shared submit handling: busy state, inline error, reset on success. */
function useSubmit(action: () => Promise<unknown>, reset: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
      reset();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^rpc \w+: /, "")
          : String(err)
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function AuthFieldsInput({
  value,
  onChange
}: {
  value: AuthFields;
  onChange: (value: AuthFields) => void;
}) {
  return (
    <details>
      <summary className="cursor-pointer text-xs text-kumo-subtle select-none">
        Authentication (optional)
      </summary>
      <div className="mt-2 flex gap-2">
        <input
          className={`${inputClass} w-2/5`}
          aria-label="Auth header name"
          placeholder="Authorization"
          value={value.authHeader ?? ""}
          onChange={(e) => onChange({ ...value, authHeader: e.target.value })}
        />
        <input
          className={inputClass}
          type="password"
          aria-label="Auth header value"
          placeholder="Bearer …"
          autoComplete="off"
          value={value.authValue ?? ""}
          onChange={(e) => onChange({ ...value, authValue: e.target.value })}
        />
      </div>
    </details>
  );
}

function AddMcpForm({
  onAdd
}: {
  onAdd: (input: AddMcpInput) => Promise<unknown>;
}) {
  const empty: AddMcpInput = { name: "", url: "" };
  const [form, setForm] = useState(empty);
  const { busy, error, submit } = useSubmit(
    () => onAdd(form),
    () => setForm(empty)
  );
  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-lg bg-kumo-control p-3"
    >
      <div className="flex items-center justify-between">
        <Text size="xs" bold>
          Add an MCP server
        </Text>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            setForm({
              name: "Cloudflare docs",
              url: "https://docs.mcp.cloudflare.com/mcp"
            })
          }
        >
          Example: Cloudflare docs
        </Button>
      </div>
      <input
        className={inputClass}
        aria-label="Server name"
        placeholder="Name, e.g. GitHub"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <input
        className={`${inputClass} font-mono`}
        aria-label="Server URL"
        placeholder="https://example.com/mcp"
        value={form.url}
        onChange={(e) => setForm({ ...form, url: e.target.value })}
      />
      <AuthFieldsInput
        value={form}
        onChange={(auth) => setForm({ ...form, ...auth })}
      />
      {error && <span className="block text-xs text-kumo-danger">{error}</span>}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        icon={<PlugsConnectedIcon size={14} />}
        disabled={busy || !form.name.trim() || !form.url.trim()}
      >
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

function AddApiForm({
  onAdd
}: {
  onAdd: (input: AddApiInput) => Promise<unknown>;
}) {
  const empty: AddApiInput = {
    name: "",
    specUrl: "",
    specText: "",
    baseUrl: ""
  };
  const [form, setForm] = useState(empty);
  const [paste, setPaste] = useState(false);
  const { busy, error, submit } = useSubmit(
    () =>
      onAdd({
        ...form,
        specUrl: paste ? undefined : form.specUrl,
        specText: paste ? form.specText : undefined
      }),
    () => setForm(empty)
  );
  const hasSpec = paste
    ? Boolean(form.specText?.trim())
    : Boolean(form.specUrl?.trim());
  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-lg bg-kumo-control p-3"
    >
      <div className="flex items-center justify-between">
        <Text size="xs" bold>
          Add an API from its OpenAPI spec
        </Text>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setPaste(false);
            setForm({
              name: "Weather",
              specUrl:
                "https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi/forecast.yml",
              baseUrl: "https://api.open-meteo.com"
            });
          }}
        >
          Example: Open-Meteo weather
        </Button>
      </div>
      <input
        className={inputClass}
        aria-label="API name"
        placeholder="Name, e.g. Weather"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      {paste ? (
        <textarea
          className={`${inputClass} font-mono h-28`}
          aria-label="OpenAPI spec"
          placeholder="Paste an OpenAPI 3.x spec (JSON or YAML)"
          value={form.specText}
          onChange={(e) => setForm({ ...form, specText: e.target.value })}
        />
      ) : (
        <input
          className={`${inputClass} font-mono`}
          aria-label="Spec URL"
          placeholder="https://example.com/openapi.json"
          value={form.specUrl}
          onChange={(e) => setForm({ ...form, specUrl: e.target.value })}
        />
      )}
      <button
        type="button"
        className="text-xs text-kumo-brand"
        onClick={() => setPaste(!paste)}
      >
        {paste ? "Use a spec URL instead" : "Paste the spec instead"}
      </button>
      <div className="flex items-center gap-2">
        <GlobeIcon size={14} className="shrink-0 text-kumo-inactive" />
        <input
          className={`${inputClass} font-mono`}
          aria-label="Base URL"
          placeholder="Base URL (only if the spec doesn't list a server)"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        />
      </div>
      <AuthFieldsInput
        value={form}
        onChange={(auth) => setForm({ ...form, ...auth })}
      />
      {error && <span className="block text-xs text-kumo-danger">{error}</span>}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        icon={<PlugsConnectedIcon size={14} />}
        disabled={busy || !form.name.trim() || !hasSpec}
      >
        {busy ? "Converting…" : "Convert and connect"}
      </Button>
    </form>
  );
}
