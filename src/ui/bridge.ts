// Connects the plugin window to the GoApp Figma MCP server (mcp/server.ts) so AI
// agents can read the design. The UI only relays: the sandbox does the work.
// The MCP panel also talks to the hub process itself, to see which agents are
// connected and to set GoApp Figma up in their configs.
import {
  BRIDGE_PLUGIN_PATH,
  BRIDGE_PORT,
  BYTES_TAG,
  type BridgeRequest,
  type BridgeResponse,
  type HubMethod,
  type HubMethods,
  type HubRequest,
  type HubResponse,
  type HubState,
} from "../shared/bridge";

export type BridgeStatus = "connected" | "disconnected";

// The server only runs while an agent uses it, so keep retrying quietly.
const RETRY_MS = 5000;
/** Close code of a hub handing over to a newer build (mcp/hub.ts); the new one is up within a second. */
const CLOSE_HANDOFF = 1012;
const HANDOFF_RETRY_MS = 1500;
const HUB_TIMEOUT_MS = 30_000;

export const HUB_NOT_RUNNING = "The GoApp Figma MCP server isn't running.";

export interface BridgeEvents {
  status(status: BridgeStatus): void;
  /** Sent by the hub on connect and whenever an agent comes or goes; null while disconnected. */
  hubState(state: HubState | null): void;
}

export interface Bridge {
  respond(response: BridgeResponse): void;
  /** Ask the hub process, e.g. to add GoApp Figma to an agent's MCP config. */
  call<M extends HubMethod>(method: M, params: HubMethods[M]["params"]): Promise<HubMethods[M]["result"]>;
  /** Try to connect right away instead of waiting for the next retry. */
  reconnect(): void;
  close(): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function connectBridge(relay: (request: BridgeRequest) => void, events: BridgeEvents): Bridge {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** Request id → when it arrived, to report how long the window held it. */
  const received = new Map<string, number>();
  const pending = new Map<string, Pending>();
  let nextId = 0;

  const failPending = (reason: string) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  };

  const reconnect = (delay = RETRY_MS) => {
    if (!closed) retry = setTimeout(open, delay);
  };

  const open = () => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}${BRIDGE_PLUGIN_PATH}`);
    } catch {
      return reconnect();
    }
    socket = ws;
    ws.onopen = () => events.status("connected");
    ws.onmessage = (event: MessageEvent<string>) => {
      let message: BridgeRequest | HubResponse | { type: "hub-state"; state: HubState };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (message?.type) {
        case "request":
          received.set(message.id, Date.now());
          relay(message);
          break;
        case "hub-state":
          events.hubState(message.state);
          break;
        case "hub-response": {
          const p = pending.get(message.id);
          if (!p) break;
          pending.delete(message.id);
          clearTimeout(p.timer);
          if (message.ok) p.resolve(message.result);
          else p.reject(new Error(message.error));
          break;
        }
      }
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      failPending("The connection to the GoApp Figma MCP server closed.");
      events.status("disconnected");
      events.hubState(null);
      reconnect(event.code === CLOSE_HANDOFF ? HANDOFF_RETRY_MS : RETRY_MS);
    };
  };

  open();
  return {
    respond(response) {
      const start = received.get(response.id);
      received.delete(response.id);
      if (start !== undefined) response = { ...response, timing: { ...response.timing, window: Date.now() - start } };
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response, encodeBytes));
    },
    call(method, params) {
      const ws = socket;
      if (ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(HUB_NOT_RUNNING));
      // randomUUID needs a secure context, which the plugin iframe isn't.
      const request: HubRequest = { type: "hub-request", id: `hub-${++nextId}`, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error("The GoApp Figma MCP server didn't answer. Restart it or the agent, then try again."));
        }, HUB_TIMEOUT_MS);
        pending.set(request.id, { resolve: resolve as (result: unknown) => void, reject, timer });
        ws.send(JSON.stringify(request));
      });
    },
    reconnect() {
      if (closed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      clearTimeout(retry);
      open();
    },
    close() {
      closed = true;
      clearTimeout(retry);
      failPending("The plugin window closed.");
      socket?.close();
    },
  };
}

function encodeBytes(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { [BYTES_TAG]: toBase64(value) } : value;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
