// Reads and edits the goapp-figma entry in a coding agent's MCP config. Text in,
// text out: agents.ts does the file I/O, so this stays testable and never
// touches anything but that entry (and the go-figma one it was called before).
import { LEGACY_SERVER_NAMES, SERVER_NAME } from "../src/shared/bridge";

export interface ServerCommand {
  command: string;
  args: string[];
}

export type ConfigFormat =
  /** `{ "<key>": { "goapp-figma": entry } }`; JSONC (comments, trailing commas) is read but not rewritten. */
  | { kind: "json"; key: "mcpServers" | "servers"; entry: (server: ServerCommand) => Record<string, unknown> }
  /** Codex `config.toml`: a `[mcp_servers.goapp-figma]` table. */
  | { kind: "toml" };

export type EntryState = "missing" | "configured" | "outdated";

const ALL_NAMES = [SERVER_NAME, ...LEGACY_SERVER_NAMES];

/**
 * Whether the config has our entry, and whether it runs the server at
 * `scriptPath`. An entry under an old name is "outdated": updating renames it.
 */
export function readEntry(format: ConfigFormat, text: string, scriptPath: string): EntryState {
  const target = normalizePath(scriptPath);
  if (format.kind === "toml") {
    const block = tomlBlock(text, [SERVER_NAME]);
    if (block !== null) return normalizePath(block).includes(target) ? "configured" : "outdated";
    return tomlBlock(text, LEGACY_SERVER_NAMES) !== null ? "outdated" : "missing";
  }
  const servers = serverMap(parseJson(text).data, format.key);
  const entry = servers?.[SERVER_NAME];
  if (entry === undefined) return LEGACY_SERVER_NAMES.some((name) => servers && name in servers) ? "outdated" : "missing";
  const args = (entry as { args?: unknown })?.args;
  return Array.isArray(args) && args.some((a) => typeof a === "string" && normalizePath(a) === target) ? "configured" : "outdated";
}

/** Add our entry, replacing an existing one and any under an old name. */
export function addEntry(format: ConfigFormat, text: string, server: ServerCommand): string {
  if (format.kind === "toml") {
    const eol = lineEnding(text);
    const rest = removeTomlBlock(text, ALL_NAMES).trimEnd();
    return (rest ? rest + eol + eol : "") + tomlTable(server).join(eol) + eol;
  }
  const { data, comments } = parseJson(text);
  if (comments) throw new Error("The file has comments, which saving would drop. Add the snippet by hand.");
  const servers = Object.entries(serverMap(data, format.key) ?? {}).filter(([name]) => !LEGACY_SERVER_NAMES.includes(name));
  data[format.key] = { ...Object.fromEntries(servers), [SERVER_NAME]: format.entry(server) };
  return printJson(data, text);
}

/** Remove our entry (under any of its names); other servers and settings are kept. */
export function removeEntry(format: ConfigFormat, text: string): string {
  if (format.kind === "toml") {
    if (tomlBlock(text, ALL_NAMES) === null) return text;
    const eol = lineEnding(text);
    const rest = removeTomlBlock(text, ALL_NAMES).trimEnd();
    return rest ? rest + eol : "";
  }
  const { data, comments } = parseJson(text);
  const servers = serverMap(data, format.key);
  if (!servers || !ALL_NAMES.some((name) => name in servers)) return text;
  if (comments) throw new Error(`The file has comments, which saving would drop. Remove the ${SERVER_NAME} entry by hand.`);
  for (const name of ALL_NAMES) delete servers[name];
  return printJson(data, text);
}

/** The entry on its own, to paste by hand. */
export function configSnippet(format: ConfigFormat, server: ServerCommand): string {
  if (format.kind === "toml") return tomlTable(server).join("\n");
  return JSON.stringify({ [format.key]: { [SERVER_NAME]: format.entry(server) } }, null, 2);
}

// ---------------------------------------------------------------------------
// JSON

type JsonObject = Record<string, unknown>;

function parseJson(text: string): { data: JsonObject; comments: boolean } {
  const source = text.replace(/^﻿/, "");
  if (!source.trim()) return { data: {}, comments: false };
  let value: unknown;
  let comments = false;
  try {
    value = JSON.parse(source);
  } catch {
    // Most files are plain JSON; only strip JSONC when they aren't.
    comments = true;
    try {
      value = JSON.parse(stripJsonc(source));
    } catch (error) {
      throw new Error(`The file isn't valid JSON (${error instanceof Error ? error.message : error}).`);
    }
  }
  if (!isObject(value)) throw new Error("The file isn't a JSON object.");
  return { data: value, comments };
}

function serverMap(data: JsonObject, key: string): JsonObject | undefined {
  const servers = data[key];
  if (servers === undefined) return undefined;
  if (!isObject(servers)) throw new Error(`"${key}" isn't an object.`);
  return servers;
}

/** Same indentation and line endings as the original file. */
function printJson(data: JsonObject, original: string): string {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? "  ";
  const eol = lineEnding(original);
  return JSON.stringify(data, null, indent).replace(/\n/g, eol) + eol;
}

const TRAILING_COMMA = /\s*[}\]]/y;

/** JSONC → JSON: drops comments, then trailing commas, outside strings. */
export function stripJsonc(text: string): string {
  const withoutComments = scanJson(text, (c, i) => {
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      return end < 0 ? text.length : end;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      return end < 0 ? text.length : end + 2;
    }
    return i;
  });
  return scanJson(withoutComments, (c, i) => {
    TRAILING_COMMA.lastIndex = i + 1;
    return c === "," && TRAILING_COMMA.test(withoutComments) ? i + 1 : i;
  });
}

/** Copies `text`, letting `skip` drop the span from i to the index it returns; strings are copied whole. */
function scanJson(text: string, skip: (c: string, i: number) => number): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, ++i);
      continue;
    }
    const next = skip(text[i], i);
    if (next > i) i = next;
    else out += text[i++];
  }
  return out;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// TOML (Codex)

const TABLE_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;

/** `goapp-figma = { … }` under [mcp_servers], or a dotted key: valid TOML this editor doesn't rewrite. */
function inlinePattern(names: readonly string[]): RegExp {
  return new RegExp(`^\\s*(?:mcp_servers\\s*\\.\\s*)?["']?(?:${names.join("|")})["']?\\s*=`, "m");
}

function tableName(line: string): string | null {
  const match = TABLE_HEADER.exec(line);
  return match ? match[1].replace(/\s*\.\s*/g, ".").replace(/["']/g, "").trim() : null;
}

/** [mcp_servers.<name>] or one of its subtables ([mcp_servers.<name>.env]). */
const isOwnTable = (table: string, names: readonly string[]) =>
  names.some((name) => table === `mcp_servers.${name}` || table.startsWith(`mcp_servers.${name}.`));

/** Lines of our tables under `names`; null if there are none. */
function tomlBlock(text: string, names: readonly string[]): string | null {
  const lines: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const table = tableName(line);
    if (table !== null) inside = isOwnTable(table, names);
    if (inside) lines.push(line);
  }
  if (lines.length > 0) return lines.join("\n");
  const inline = inlinePattern(names);
  return inline.test(text) ? (text.split(/\r?\n/).find((line) => inline.test(line)) ?? "") : null;
}

function removeTomlBlock(text: string, names: readonly string[]): string {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => isOwnTable(tableName(line) ?? "", names)) && inlinePattern(names).test(text)) {
    throw new Error(`${SERVER_NAME} is set up inline in this file. Edit that entry by hand.`);
  }
  const kept: string[] = [];
  let inside = false;
  /** Blank lines at the end of the removed table: they separate it from the next one, so they stay. */
  let gap = 0;
  for (const line of lines) {
    const table = tableName(line);
    if (table !== null) {
      const own = isOwnTable(table, names);
      // The blank lines before the table go with it.
      if (own && !inside) while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop();
      if (!own && inside && kept.length > 0) kept.push(...Array<string>(gap).fill(""));
      inside = own;
    }
    if (inside) gap = line.trim() ? 0 : gap + 1;
    else kept.push(line);
  }
  return kept.join(lineEnding(text));
}

/** JSON strings are valid TOML basic strings, and arrays of them valid TOML arrays. */
function tomlTable(server: ServerCommand): string[] {
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`];
}

// ---------------------------------------------------------------------------

function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Compare paths however they were written: escaped backslashes, forward slashes, any case. */
function normalizePath(value: string): string {
  return value.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
}
