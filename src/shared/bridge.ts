// Protocol between the MCP server (`mcp/`) and the plugin, over a localhost
// WebSocket. The UI iframe owns the socket and relays requests to the sandbox.
//
//   AI agent ──stdio──▶ mcp/server ──ws──▶ plugin UI ──postMessage──▶ sandbox
//
// Messages are JSON; `Uint8Array`s travel as `{ "$bytes": "<base64>" }`.
import type { AnnotationNote, ComponentUsage, DesignAsset } from "../generators/designContext";
import type { ImageFit } from "../core/imageFit";
import type { ProjectFile } from "../generators/project";
import type { CodeSection } from "./messages";
import type { Target } from "./settings";

export const BRIDGE_PORT = 3940;
/** Path the plugin UI connects to; the hub only accepts browser connections here. */
export const BRIDGE_PLUGIN_PATH = "/plugin";
/** Path other MCP server processes connect to when this port already has a hub. */
export const BRIDGE_AGENT_PATH = "/agent";
export const BYTES_TAG = "$bytes";

export interface NodeQuery {
  /** Figma node ids ("12:34", or "12-34" as in a Figma URL); defaults to the current selection. */
  nodeIds?: string[];
  /** File a Figma link pointed at; the plugin refuses to answer from a different file. */
  file?: { key: string; slug?: string };
}

export interface ConvertParams extends NodeQuery {
  /** Defaults to the target picked in the plugin window. */
  target?: Target;
  useColorVariables?: boolean;
  inlineSvg?: boolean;
}

export interface Screenshot {
  nodeId: string;
  name: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

export type VariableValue = string | number | boolean | { alias: string };

/** A variable used by the selection, resolved in the mode of the layer using it. */
export interface VariableDef {
  name: string;
  /** Name used in generated code: `var(--<cssName>)`. */
  cssName: string;
  collection: string;
  /** Figma's resolved type: COLOR, FLOAT, STRING, BOOLEAN, … */
  type: string;
  value: VariableValue;
}

export interface StyleDef {
  type: string;
  name: string;
  /** Human-readable summary: "#1e1e1e", "Inter Bold, 32px, line-height 40px", … */
  value: string;
}

export interface VariableInfo {
  name: string;
  cssName: string;
  type: string;
  /** Mode name → value; colors are CSS colors. */
  values: Record<string, VariableValue>;
}

export interface VariableCollectionInfo {
  name: string;
  modes: string[];
  variables: VariableInfo[];
}

export interface DesignContextResult {
  format: Target;
  nodes: { id: string; name: string }[];
  sections: CodeSection[];
  codeChars: number;
  /** Code is over the requested limit; `metadata` outlines the layers to split it by. */
  tooLarge: boolean;
  metadata?: string;
  components: ComponentUsage[];
  annotations: AnnotationNote[];
  variables: VariableDef[];
  styles: StyleDef[];
  assets: DesignAsset[];
  screenshots: Screenshot[];
  warnings: string[];
}

export interface BridgeMethods {
  get_metadata: {
    params: NodeQuery & { depth?: number };
    result: { xml: string };
  };
  get_design_context: {
    params: NodeQuery & { format?: Target; useColorVariables?: boolean; screenshot?: boolean; maxCodeChars?: number };
    result: DesignContextResult;
  };
  get_variable_defs: {
    params: NodeQuery;
    result: { variables: VariableDef[]; styles: StyleDef[] };
  };
  get_variables: {
    params: Record<string, never>;
    result: { collections: VariableCollectionInfo[] };
  };
  get_screenshot: {
    params: NodeQuery & { scale?: number; format?: "PNG" | "JPG" };
    result: { screenshots: Screenshot[] };
  };
  generate_code: {
    params: ConvertParams;
    result: { target: Target; sections: CodeSection[]; warnings: string[]; images: { fileName: string; bytes: Uint8Array; fit?: ImageFit }[] };
  };
  export_project: {
    params: ConvertParams;
    result: { target: Target; name: string; files: ProjectFile[]; warnings: string[] };
  };
}

export type BridgeMethod = keyof BridgeMethods;

export interface BridgeRequest<M extends BridgeMethod = BridgeMethod> {
  type: "request";
  id: string;
  method: M;
  params: BridgeMethods[M]["params"];
}

export type BridgeResponse =
  | { type: "response"; id: string; ok: true; result: unknown; timing?: BridgeTiming }
  | { type: "response"; id: string; ok: false; error: string; timing?: BridgeTiming };

/** Milliseconds spent in the sandbox handler, and in the plugin window from receiving the request to sending the answer. */
export interface BridgeTiming {
  sandbox?: number;
  window?: number;
}

// ---------------------------------------------------------------------------
// Agent management: the plugin window asks the hub process which coding agents
// use GoApp Figma, and adds or removes the server in their MCP configs.
//
//   plugin ──hub-request──▶ hub ──hub-response──▶ plugin
//   hub ──hub-state──▶ plugin   (on connect and whenever an agent comes or goes)
//   peer ──session──▶ hub       (on connect and after each tool call)

/** Name of the server entry in agent configs (tools show up as mcp__goapp-figma__*). */
export const SERVER_NAME = "goapp-figma";
/** Names the entry had before; setting an agent up again renames them to SERVER_NAME. */
export const LEGACY_SERVER_NAMES: readonly string[] = ["go-figma"];

/** One running MCP server process, i.e. one agent session using GoApp Figma. */
export interface AgentSession {
  id: string;
  /** clientInfo the agent sent in MCP initialize, e.g. { name: "claude-code", version: "2.1.0" }. */
  client?: { name: string; version: string };
  pid: number;
  /** Working directory the agent started the server in, usually its project. */
  cwd: string;
  startedAt: number;
  calls: number;
  lastCall?: { method: string; at: number };
}

export interface HubState {
  version: string;
  pid: number;
  /** Absolute path of the server script (dist/mcp.mjs). */
  serverPath: string;
  /** Started with --hub to manage agents, rather than by an agent. */
  standalone: boolean;
  sessions: AgentSession[];
}

export type AgentId = "claude-code" | "codex" | "cursor" | "claude-desktop" | "vscode" | "windsurf" | "gemini";

export interface AgentConfigStatus {
  id: AgentId;
  label: string;
  /** File the server entry lives in, with the home folder shortened to ~. */
  configPath: string;
  /** The agent's config folder exists, so it is probably installed. */
  detected: boolean;
  /** missing: no goapp-figma entry; outdated: the entry runs a different server script. */
  state: "missing" | "configured" | "outdated" | "error";
  error?: string;
  /** What to paste to set it up by hand. */
  snippet: string;
  /** How to make the agent load a changed config. */
  reload: string;
}

export interface HubMethods {
  list_agents: { params: Record<string, never>; result: { agents: AgentConfigStatus[] } };
  add_agent: { params: { agent: AgentId }; result: AgentConfigStatus };
  remove_agent: { params: { agent: AgentId }; result: AgentConfigStatus };
}

export type HubMethod = keyof HubMethods;

export interface HubRequest<M extends HubMethod = HubMethod> {
  type: "hub-request";
  id: string;
  method: M;
  params: HubMethods[M]["params"];
}

export type HubResponse =
  | { type: "hub-response"; id: string; ok: true; result: unknown }
  | { type: "hub-response"; id: string; ok: false; error: string };
