// WebSocket link between MCP server processes and the Figma plugin.
//
// The first server process to bind the port becomes the hub, and the plugin UI
// connects to it at /plugin. Later processes (a second agent, another editor)
// connect to the hub at /agent and have their requests forwarded, so Claude
// Code and Codex can share one plugin window. When the hub exits, a peer takes
// the port over and the plugin reconnects to it.
//
// The hub also tells the plugin which agent sessions are connected (peers
// report theirs), and answers its MCP panel's requests to add or remove Go
// Figma in agent configs (agents.ts).
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_AGENT_PATH,
  BRIDGE_PLUGIN_PATH,
  BYTES_TAG,
  type AgentSession,
  type BridgeMethod,
  type BridgeMethods,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeTiming,
  type HubRequest,
  type HubResponse,
  type HubState,
} from "../src/shared/bridge";
import { handleHubRequest } from "./agents";

const REQUEST_TIMEOUT_MS = 120_000;
/** A bit longer than the plugin UI's reconnect interval. */
const PLUGIN_WAIT_MS = 6_000;
/** Joining retries while a hub is exiting or handing the port over. */
const JOIN_ATTEMPTS = 20;
const JOIN_RETRY_MS = 250;
/** After a handoff, older processes wait this long so the newer one gets the port first. */
const HANDOFF_DELAY_MS = 1000;
/** WebSocket close code the plugin window takes as "reconnect right away". */
export const CLOSE_HANDOFF = 1012;

export const NOT_CONNECTED =
  "The GoApp Figma plugin is not connected. In Figma desktop, run Plugins → Development → GoApp Figma " +
  "and keep its window open (the MCP dot in the plugin turns green), then try again.";

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
  started: number;
  /** Socket the request went out on; if it closes, the request fails. */
  via: WebSocket;
}

export interface HubOptions {
  version: string;
  /** Absolute path of this server script; agent configs are pointed at it. */
  serverPath: string;
  /** Started with --hub: keeps the port for the plugin's MCP panel, serves no agent itself. */
  standalone?: boolean;
  /**
   * When this build was made. A hub hands the port to a newer build that
   * connects as a peer, so rebuilding takes effect without restarting every agent.
   */
  build: number;
}

export function log(message: string): void {
  // stdout carries the MCP protocol; diagnostics go to stderr.
  console.error(`[goapp-figma] ${message}`);
}

export class Hub {
  private role: "none" | "hub" | "peer" = "none";
  private servers: Server[] = [];
  /** Hub: the plugin window. */
  private plugin: WebSocket | null = null;
  private pluginWaiters: (() => void)[] = [];
  /** Hub: forwarded request id → the peer that sent it and the plugin it went to. */
  private routes = new Map<string, { peer: WebSocket; plugin: WebSocket }>();
  /** Peer: connection to the hub. */
  private hub: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private joining: Promise<void> | null = null;
  /** The agent session this process serves; null when standalone. */
  private readonly session: AgentSession | null;
  /** Hub: sessions of the peer processes, shown in the plugin's MCP panel. */
  private peerSessions = new Map<WebSocket, AgentSession>();
  /** Hub: every connected peer process. */
  private peers = new Set<WebSocket>();
  /** Peer: wait before rejoining when the hub closes, to let a newer build take the port. */
  private rejoinDelay = 0;
  private closed = false;

  constructor(
    private readonly port: number,
    private readonly options: HubOptions,
  ) {
    this.session = options.standalone
      ? null
      : { id: randomUUID(), pid: process.pid, cwd: process.cwd(), startedAt: Date.now(), calls: 0 };
  }

  get isHub(): boolean {
    return this.role === "hub";
  }

  /** The agent this process serves, from its MCP initialize request. */
  setClient(client: { name: string; version: string } | undefined): void {
    if (!this.session || !client) return;
    this.session.client = { name: String(client.name), version: String(client.version) };
    this.publish();
  }

  /** Become the hub, or connect to the process that already is. */
  join(): Promise<void> {
    if (this.role === "hub" || (this.role === "peer" && this.hub?.readyState === WebSocket.OPEN)) return Promise.resolve();
    this.joining ??= this.tryJoin().finally(() => (this.joining = null));
    return this.joining;
  }

  async request<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<BridgeMethods[M]["result"]> {
    await this.join();
    if (this.role === "hub") await this.waitForPlugin();
    const socket = this.role === "hub" ? this.plugin : this.hub;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(NOT_CONNECTED);
    if (this.session) {
      this.session.calls++;
      this.session.lastCall = { method, at: Date.now() };
      this.publish();
    }

    const request: BridgeRequest<M> = { type: "request", id: randomUUID(), method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Figma did not answer "${method}" within ${REQUEST_TIMEOUT_MS / 1000}s.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request.id, { resolve: resolve as (result: unknown) => void, reject, timer, via: socket, method, started: Date.now() });
      socket.send(JSON.stringify(request));
    });
  }

  close(): void {
    this.closed = true;
    this.plugin?.close();
    this.hub?.close();
    for (const server of this.servers) server.close();
  }

  private async tryJoin(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (await this.listen()) {
        this.role = "hub";
        log(`Waiting for the Figma plugin on ws://localhost:${this.port}${BRIDGE_PLUGIN_PATH}`);
        return;
      }
      try {
        this.hub = await this.connectToHub();
        this.role = "peer";
        log(`Port ${this.port} has a hub already; forwarding requests through it.`);
        return;
      } catch (error) {
        // The hub may be exiting or handing over: the port frees up in a moment.
        if (attempt >= JOIN_ATTEMPTS) throw error;
        await sleep(JOIN_RETRY_MS);
      }
    }
  }

  /** A newer build joined: give it the port and continue as one of its peers. */
  private handOff(build: number): void {
    if (this.role !== "hub") return;
    log("A newer GoApp Figma build connected; handing the port over to it.");
    for (const server of this.servers) server.close();
    this.servers = [];
    this.role = "none";
    const notice = JSON.stringify({ type: "handoff", build });
    for (const peer of this.peers) {
      if (peer.readyState === WebSocket.OPEN) peer.send(notice);
      peer.close();
    }
    this.peers.clear();
    this.peerSessions.clear();
    this.plugin?.close(CLOSE_HANDOFF, "Handing over to a newer GoApp Figma server");
    this.plugin = null;
    setTimeout(() => {
      if (!this.closed) this.join().catch((error: Error) => log(error.message));
    }, HANDOFF_DELAY_MS);
  }

  // -------------------------------------------------------------------------
  // Hub

  private listen(): Promise<boolean> {
    const wss = new WebSocketServer({ noServer: true });
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? "").split("?")[0];
      const kind = path === BRIDGE_PLUGIN_PATH ? "plugin" : path === BRIDGE_AGENT_PATH ? "agent" : null;
      if (!kind || !originAllowed(kind, req.headers.origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => (kind === "plugin" ? this.attachPlugin(ws) : this.attachPeer(ws)));
    };
    const create = () => {
      const server = createServer((_req, res) => res.writeHead(426).end("GoApp Figma MCP bridge: WebSocket only.\n"));
      server.on("upgrade", upgrade);
      return server;
    };

    return new Promise((resolve, reject) => {
      const primary = create();
      primary.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
      primary.listen(this.port, "127.0.0.1", () => {
        this.servers.push(primary);
        // The plugin dials `localhost`, which the browser may resolve to ::1.
        // A hub handing over may still hold it for a moment, so retry.
        const listenIpv6 = (attempt: number) => {
          const ipv6 = create();
          ipv6.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "EADDRINUSE" && attempt < JOIN_ATTEMPTS && this.servers.includes(primary)) {
              setTimeout(() => listenIpv6(attempt + 1), JOIN_RETRY_MS);
            }
          });
          ipv6.listen(this.port, "::1", () => {
            if (this.servers.includes(primary)) this.servers.push(ipv6);
            else ipv6.close();
          });
        };
        listenIpv6(1);
        resolve(true);
      });
    });
  }

  private attachPlugin(ws: WebSocket): void {
    // A reopened plugin window replaces the previous one.
    if (this.plugin && this.plugin !== ws) this.plugin.close(1000, "Replaced by a newer plugin window");
    this.plugin = ws;
    log("Figma plugin connected.");
    for (const wake of this.pluginWaiters.splice(0)) wake();
    this.sendState();

    ws.on("error", () => {});
    ws.on("message", (data) => {
      const text = data.toString();
      const message = parseObject(text);
      if (message?.type === "hub-request") {
        void this.answerPlugin(ws, message as unknown as HubRequest);
        return;
      }
      const id = typeof message?.id === "string" ? message.id : undefined;
      const route = id ? this.routes.get(id) : undefined;
      if (route && id) {
        this.routes.delete(id);
        if (route.peer.readyState === WebSocket.OPEN) route.peer.send(text);
      } else {
        this.settle(text);
      }
    });
    ws.on("close", () => {
      if (this.plugin === ws) {
        this.plugin = null;
        log("Figma plugin disconnected.");
      }
      const reason = "The Figma plugin window was closed before it answered.";
      this.failVia(ws, reason);
      for (const [id, route] of this.routes) {
        if (route.plugin !== ws) continue;
        this.routes.delete(id);
        if (route.peer.readyState === WebSocket.OPEN) route.peer.send(JSON.stringify(failure(id, reason)));
      }
    });
  }

  private attachPeer(ws: WebSocket): void {
    this.peers.add(ws);
    ws.on("error", () => {});
    ws.on("message", async (data) => {
      const message = parseObject(data.toString());
      if (message?.type === "hello") {
        if (typeof message.build === "number" && message.build > this.options.build) this.handOff(message.build);
        return;
      }
      if (message?.type === "session") {
        const session = readSession(message.session);
        if (session) this.peerSessions.set(ws, session);
        this.sendState();
        return;
      }
      const request = message as BridgeRequest | undefined;
      if (request?.type !== "request" || typeof request.id !== "string") return;
      await this.waitForPlugin();
      const plugin = this.plugin;
      if (!plugin || plugin.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify(failure(request.id, NOT_CONNECTED)));
        return;
      }
      this.routes.set(request.id, { peer: ws, plugin });
      plugin.send(data.toString());
    });
    ws.on("close", () => {
      this.peers.delete(ws);
      for (const [id, route] of this.routes) if (route.peer === ws) this.routes.delete(id);
      if (this.peerSessions.delete(ws)) this.sendState();
    });
  }

  /** Management requests from the plugin's MCP panel; this process answers them itself. */
  private async answerPlugin(ws: WebSocket, request: HubRequest): Promise<void> {
    let response: HubResponse;
    try {
      const server = { command: "node", args: [this.options.serverPath] };
      const result = await handleHubRequest(request.method, request.params, server);
      response = { type: "hub-response", id: request.id, ok: true, result };
      if (request.method !== "list_agents") log(`${request.method} ${JSON.stringify(request.params)}: done.`);
    } catch (error) {
      response = { type: "hub-response", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  }

  private sendState(): void {
    const plugin = this.plugin;
    if (plugin?.readyState !== WebSocket.OPEN) return;
    const state: HubState = {
      version: this.options.version,
      pid: process.pid,
      serverPath: this.options.serverPath,
      standalone: this.options.standalone ?? false,
      sessions: [...(this.session ? [this.session] : []), ...this.peerSessions.values()],
    };
    plugin.send(JSON.stringify({ type: "hub-state", state }));
  }

  /** Report this process's session: to the plugin as the hub, to the hub as a peer. */
  private publish(): void {
    if (this.role === "hub") this.sendState();
    else if (this.session && this.hub?.readyState === WebSocket.OPEN) this.hub.send(JSON.stringify({ type: "session", session: this.session }));
  }

  /** Give a plugin window that is about to (re)connect a moment to show up. */
  private waitForPlugin(): Promise<void> {
    if (this.plugin) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PLUGIN_WAIT_MS);
      this.pluginWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Peer

  private connectToHub(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}${BRIDGE_AGENT_PATH}`);
      ws.once("error", (error) => reject(new Error(`Port ${this.port} is taken by another program: ${error.message}`)));
      ws.once("open", () => {
        // Older hubs ignore hello; newer ones hand over when this build is newer.
        ws.send(JSON.stringify({ type: "hello", build: this.options.build, version: this.options.version }));
        if (this.session) ws.send(JSON.stringify({ type: "session", session: this.session }));
        ws.on("error", () => {});
        ws.on("message", (data) => {
          const text = data.toString();
          const message = parseObject(text);
          if (message?.type === "handoff") {
            // The hub is giving the port to a newer build; let that one take it first.
            this.rejoinDelay = typeof message.build === "number" && message.build > this.options.build ? HANDOFF_DELAY_MS : 0;
            return;
          }
          this.settle(text);
        });
        ws.on("close", () => {
          if (this.hub === ws) {
            this.hub = null;
            this.role = "none";
            // Take the port over right away so the plugin finds a hub when it reconnects.
            const delay = this.rejoinDelay;
            this.rejoinDelay = 0;
            setTimeout(() => {
              if (!this.closed) this.join().catch((error: Error) => log(error.message));
            }, delay);
          }
          this.failVia(ws, "Lost the connection to the GoApp Figma hub process before Figma answered.");
        });
        resolve(ws);
      });
    });
  }

  // -------------------------------------------------------------------------

  private settle(text: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(text, decodeBytes);
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    logTiming(pending.method, Date.now() - pending.started, response.timing);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  private failVia(socket: WebSocket, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.via !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }
}

/**
 * Browsers always send Origin on WebSocket handshakes, so web pages can't pose
 * as an agent and read designs. Plugin iframes have an opaque ("null") origin.
 */
function originAllowed(kind: "plugin" | "agent", origin: string | undefined): boolean {
  if (kind === "agent") return origin === undefined;
  return origin === "null" || (origin !== undefined && /^https:\/\/([a-z0-9-]+\.)*figma\.com$/.test(origin));
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A peer's session, keeping only well-formed fields. */
function readSession(raw: unknown): AgentSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.pid !== "number" || typeof s.cwd !== "string") return null;
  const session: AgentSession = {
    id: s.id,
    pid: s.pid,
    cwd: s.cwd,
    startedAt: typeof s.startedAt === "number" ? s.startedAt : Date.now(),
    calls: typeof s.calls === "number" ? s.calls : 0,
  };
  const client = s.client as Record<string, unknown> | undefined;
  if (typeof client?.name === "string") session.client = { name: client.name, version: String(client.version ?? "") };
  const last = s.lastCall as Record<string, unknown> | undefined;
  if (typeof last?.method === "string" && typeof last.at === "number") session.lastCall = { method: last.method, at: last.at };
  return session;
}

/**
 * Where a request's time went: in the sandbox's handler, waiting in the plugin
 * window (busy rendering its own preview), or in transit.
 */
function logTiming(method: string, total: number, timing: BridgeTiming | undefined): void {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [`${method}: ${s(total)}`];
  if (timing?.sandbox !== undefined) parts.push(`sandbox ${s(timing.sandbox)}`);
  if (timing?.window !== undefined && timing.sandbox !== undefined) parts.push(`waiting in plugin window ${s(timing.window - timing.sandbox)}`);
  log(parts.join(", "));
}

function failure(id: string, error: string): BridgeResponse {
  return { type: "response", id, ok: false, error };
}

function decodeBytes(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && BYTES_TAG in value) {
    const data = (value as Record<string, unknown>)[BYTES_TAG];
    if (typeof data === "string") return new Uint8Array(Buffer.from(data, "base64"));
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
