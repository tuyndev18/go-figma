// MCP panel: every coding agent GoApp Figma knows, whether it is connected right
// now, and adding or removing the goapp-figma server in its MCP config. The
// server is registered per user (machine-wide), not per project. The hub
// process does the file work (mcp/agents.ts); the plugin iframe has no file access.
import { useCallback, useEffect, useState } from "react";
import type { AgentConfigStatus, AgentId, AgentSession, HubState } from "../shared/bridge";
import type { Bridge, BridgeStatus } from "./bridge";
import { CopyButton } from "./common";
import { ChevronIcon, CloseIcon, CopyIcon, PlugIcon, RefreshIcon } from "./icons";

interface Props {
  bridge: Bridge | null;
  status: BridgeStatus;
  hub: HubState | null;
  /** Server script a hub reported before, to show how to start it. */
  serverPath: string | null;
  onClose(): void;
}

/** hub-state follows the connection right away; a hub that never sends one predates the panel. */
const LEGACY_HUB_MS = 2000;

/** MCP clientInfo names → agents; unknown clients are listed under their own name. */
const CLIENTS: [RegExp, AgentId | null, string][] = [
  [/^claude-code/i, "claude-code", "Claude Code"],
  [/^claude-ai/i, "claude-desktop", "Claude Desktop"],
  [/codex/i, "codex", "Codex"],
  [/cursor/i, "cursor", "Cursor"],
  [/windsurf/i, "windsurf", "Windsurf"],
  [/gemini/i, "gemini", "Gemini CLI"],
  [/visual studio code|vscode/i, "vscode", "VS Code"],
];

/** Decorative icon tiles, one sticker color per agent. */
const TILE: Record<AgentId, { mark: string; tone: string }> = {
  "claude-code": { mark: "CC", tone: "orange" },
  "claude-desktop": { mark: "C", tone: "brown" },
  codex: { mark: "Cx", tone: "teal" },
  cursor: { mark: "Cu", tone: "purple" },
  vscode: { mark: "VS", tone: "sky" },
  windsurf: { mark: "W", tone: "green" },
  gemini: { mark: "G", tone: "pink" },
};

function clientAgent(session: AgentSession): { id: AgentId | null; label: string } {
  const name = session.client?.name;
  if (!name) return { id: null, label: "Agent (starting)" };
  const match = CLIENTS.find(([pattern]) => pattern.test(name));
  return match ? { id: match[1], label: match[2] } : { id: null, label: name };
}

export function McpPanel({ bridge, status, hub, serverPath, onClose }: Props) {
  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    setLegacy(false);
    if (status !== "connected" || hub) return;
    const timer = setTimeout(() => setLegacy(true), LEGACY_HUB_MS);
    return () => clearTimeout(timer);
  }, [status, hub]);
  // Opening the panel shouldn't wait for the next background retry.
  useEffect(() => {
    if (status === "disconnected") bridge?.reconnect();
  }, [bridge, status]);

  return (
    <main className="content mcp">
      <div className="mcp-head">
        <div>
          <h2>AI agents</h2>
          <p>One GoApp Figma MCP server, shared by every agent and project on this machine.</p>
        </div>
        <button className="btn-icon" title="Back to code" aria-label="Back to code" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <ServerCard status={status} hub={hub} legacy={legacy} serverPath={serverPath} onConnect={() => bridge?.reconnect()} />
      {hub && bridge && <Agents bridge={bridge} hub={hub} />}
    </main>
  );
}

function ServerCard({
  status,
  hub,
  legacy,
  serverPath,
  onConnect,
}: {
  status: BridgeStatus;
  hub: HubState | null;
  legacy: boolean;
  serverPath: string | null;
  onConnect(): void;
}) {
  const command = serverPath ? `node ${quote(serverPath)} --hub` : "npm run hub";
  const state = status === "disconnected" ? "off" : hub ? "on" : legacy ? "warn" : "idle";
  const title = { off: "Server not running", on: "Server running", warn: "Older server running", idle: "Connecting…" }[state];
  return (
    <section className="card server-card">
      <div className="server-row">
        <span className={`status-tile ${state}`}>
          <PlugIcon />
        </span>
        <div className="grow">
          <div className="row-title">{title}</div>
          <div className="row-caption" title={hub?.serverPath}>
            {hub
              ? `v${hub.version} · pid ${hub.pid}${hub.standalone ? " · started with --hub" : ""}`
              : state === "off"
                ? "Agents start it when they first use goapp-figma."
                : state === "warn"
                  ? "Built before agent management; it can't list agents."
                  : "Waiting for the server to report in."}
          </div>
        </div>
        {state === "off" && (
          <button className="btn-utility" onClick={onConnect}>
            Connect
          </button>
        )}
      </div>
      {state === "off" && (
        <div className="server-note">
          <p>To set agents up before any of them runs, start the server in a terminal{serverPath ? "" : " in the go-figma folder"}:</p>
          <div className="command">
            <code>{command}</code>
            <CopyButton text={command} title="Copy command" className="btn-icon">
              <CopyIcon />
            </CopyButton>
          </div>
        </div>
      )}
      {state === "warn" && (
        <div className="server-note">
          <p>
            Restart the agents using goapp-figma so they load the new build: in Claude Code run <code>/mcp</code>, pick goapp-figma and
            Reconnect. Newer builds take over the port by themselves.
          </p>
        </div>
      )}
    </section>
  );
}

const STATE_LABEL: Record<AgentConfigStatus["state"], string> = {
  missing: "Not set up",
  configured: "Set up",
  outdated: "Points to another build",
  error: "Can't read config",
};

function Agents({ bridge, hub }: { bridge: Bridge; hub: HubState }) {
  const [agents, setAgents] = useState<AgentConfigStatus[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<AgentId | null>(null);
  const [rowErrors, setRowErrors] = useState<Partial<Record<AgentId, string>>>({});
  /** Agents whose config changed here and need a restart to load it. */
  const [changed, setChanged] = useState<ReadonlySet<AgentId>>(new Set());
  const now = useNow(10_000);

  const load = useCallback(() => {
    setError("");
    bridge.call("list_agents", {}).then(
      (result) => setAgents(result.agents),
      (e: Error) => setError(e.message),
    );
  }, [bridge]);
  // A different hub process (after a takeover) may see other config locations.
  useEffect(load, [load, hub.pid]);

  const act = async (id: AgentId, method: "add_agent" | "remove_agent") => {
    setBusy(id);
    setRowErrors((errors) => ({ ...errors, [id]: undefined }));
    try {
      const updated = await bridge.call(method, { agent: id });
      setAgents((list) => list?.map((a) => (a.id === id ? updated : a)) ?? null);
      setChanged((set) => new Set(set).add(id));
    } catch (e) {
      setRowErrors((errors) => ({ ...errors, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const sessionsOf = new Map<AgentId, AgentSession[]>();
  const others: { label: string; session: AgentSession }[] = [];
  for (const session of hub.sessions) {
    const { id, label } = clientAgent(session);
    if (id) sessionsOf.set(id, [...(sessionsOf.get(id) ?? []), session]);
    else others.push({ label, session });
  }

  const row = (a: AgentConfigStatus) => (
    <AgentRow
      key={a.id}
      agent={a}
      sessions={sessionsOf.get(a.id) ?? []}
      now={now}
      busy={busy}
      error={rowErrors[a.id]}
      changed={changed.has(a.id)}
      onAdd={() => act(a.id, "add_agent")}
      onRemove={() => act(a.id, "remove_agent")}
    />
  );
  // Connected agents first, then the ones set up, then the rest found on this machine.
  const rank = (a: AgentConfigStatus) => (sessionsOf.has(a.id) ? 0 : a.state === "configured" || a.state === "outdated" ? 1 : 2);
  const found = (agents ?? []).filter((a) => a.detected || sessionsOf.has(a.id)).sort((a, b) => rank(a) - rank(b));
  const missing = (agents ?? []).filter((a) => !a.detected && !sessionsOf.has(a.id));
  const connected = hub.sessions.length;

  return (
    <section className="agents">
      <div className="section-head">
        <span className="eyebrow">
          On this machine · {connected} session{connected === 1 ? "" : "s"} connected
        </span>
        <button className="btn-icon" title="Refresh" aria-label="Refresh" onClick={load} disabled={busy !== null}>
          <RefreshIcon />
        </button>
      </div>
      {error && <p className="note danger">{error}</p>}
      {!agents && !error && <p className="note">Reading agent configs…</p>}
      {(found.length > 0 || others.length > 0) && (
        <ul className="card list">
          {found.map(row)}
          {others.map(({ label, session }) => (
            <li key={session.id} className="agent">
              <div className="agent-row static">
                <span className="agent-tile gray">{label.slice(0, 2)}</span>
                <div className="grow">
                  <div className="row-title">
                    {label} <span className="chip on">Connected</span>
                  </div>
                  <div className="row-caption">{sessionSummary([session], now)}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {agents && found.length === 0 && others.length === 0 && <p className="note">No supported agent found on this machine.</p>}
      {missing.length > 0 && (
        <details className="more">
          <summary>
            <ChevronIcon />
            Not found on this machine ({missing.length})
          </summary>
          <ul className="card list">{missing.map(row)}</ul>
        </details>
      )}
      <p className="note">
        Set up writes goapp-figma into the agent's user-level MCP config, so it works in every project. The previous file is kept as
        .goapp-figma.bak.
      </p>
    </section>
  );
}

interface AgentRowProps {
  agent: AgentConfigStatus;
  sessions: AgentSession[];
  now: number;
  busy: AgentId | null;
  error?: string;
  changed: boolean;
  onAdd(): void;
  onRemove(): void;
}

function AgentRow({ agent: a, sessions, now, busy, error, changed, onAdd, onRemove }: AgentRowProps) {
  const [open, setOpen] = useState(false);
  const disabled = busy !== null;
  const setUp = a.state === "configured" || a.state === "outdated";
  const live = sessions.length > 0;
  // A newer hub may list agents this build doesn't know.
  const tile = TILE[a.id] ?? { mark: a.label.slice(0, 2), tone: "gray" };
  const caption = busy === a.id
    ? "Saving…"
    : live
      ? sessionSummary(sessions, now)
      : a.state === "error"
        ? "Can't read its config"
        : setUp
          ? a.state === "outdated"
            ? "Set up, but for another copy of GoApp Figma"
            : "Set up · starts when the agent runs"
          : a.detected
            ? "Installed, goapp-figma not set up"
            : "Not installed";
  const action =
    a.detected && a.state === "missing" ? (
      <button className="btn-primary small" disabled={disabled} onClick={onAdd}>
        Set up
      </button>
    ) : a.state === "outdated" ? (
      <button className="btn-primary small" disabled={disabled} title="Point the entry at this build" onClick={onAdd}>
        Update
      </button>
    ) : null;

  return (
    <li className={`agent${open ? " open" : ""}`}>
      <div className="agent-row">
        <button className="agent-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`agent-tile ${a.detected || live ? tile.tone : "gray"}`}>{tile.mark}</span>
          <span className="grow">
            <span className="row-title">
              {a.label}
              {live && <span className="chip on">Connected{sessions.length > 1 ? ` ×${sessions.length}` : ""}</span>}
              {!live && setUp && <span className="chip">Not running</span>}
              {a.state === "error" && <span className="chip danger">Error</span>}
            </span>
            <span className="row-caption">{caption}</span>
          </span>
          <span className="row-chevron">
            <ChevronIcon />
          </span>
        </button>
        {action}
      </div>
      {(open || error || changed) && (
        <div className="agent-details">
          {error && <p className="note danger">{error}</p>}
          {a.error && <p className="note danger">{a.error}</p>}
          {!error && (changed || (setUp && !live)) && <p className="note brand">To connect: {a.reload}</p>}
          {open && (
            <>
              {sessions.map((s) => (
                <div key={s.id} className="detail" title={`Started in ${s.cwd}`}>
                  <span className="detail-key">Session</span>
                  <span>{sessionLine(s, now)}</span>
                </div>
              ))}
              <div className="detail">
                <span className="detail-key">Config</span>
                <span className="detail-path" title={a.configPath}>
                  {a.configPath}
                </span>
              </div>
              <div className="detail">
                <span className="detail-key">Status</span>
                <span>{STATE_LABEL[a.state]}</span>
              </div>
              <div className="detail-actions">
                <CopyButton text={a.snippet} title="Copy the setup to paste by hand" className="btn-utility">
                  <CopyIcon />
                  Copy config
                </CopyButton>
                {setUp && (
                  <button className="btn-utility" disabled={disabled} onClick={onRemove}>
                    Remove
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function sessionSummary(sessions: AgentSession[], now: number): string {
  const calls = sessions.reduce((sum, s) => sum + s.calls, 0);
  const last = sessions.map((s) => s.lastCall).filter((c) => c !== undefined).sort((a, b) => b.at - a.at)[0];
  const count = sessions.length > 1 ? `${sessions.length} sessions · ` : "";
  return last ? `${count}${calls} call${calls === 1 ? "" : "s"} · last ${last.method} ${ago(now - last.at)}` : `${count}connected, no calls yet`;
}

function sessionLine(session: AgentSession, now: number): string {
  const version = session.client?.version ? `v${session.client.version} · ` : "";
  return `${version}pid ${session.pid} · up ${duration(now - session.startedAt)} · ${session.calls} call${session.calls === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------

function ago(ms: number): string {
  return ms < 45_000 ? "just now" : `${duration(ms)} ago`;
}

function duration(ms: number): string {
  if (ms < 60_000) return "<1 min";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

const quote = (path: string) => (/[\s"]/.test(path) ? JSON.stringify(path) : path);

function useNow(interval: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
