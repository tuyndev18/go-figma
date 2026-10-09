// The coding agents GoApp Figma can register itself with, and where their MCP
// configs live. The plugin's MCP panel lists them and adds or removes the
// goapp-figma entry through the hub process (hub.ts), which has file access.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { LEGACY_SERVER_NAMES, SERVER_NAME, type AgentConfigStatus, type AgentId, type HubMethod, type HubMethods } from "../src/shared/bridge";
import { addEntry, configSnippet, readEntry, removeEntry, type ConfigFormat, type ServerCommand } from "./agentConfig";

interface Agent {
  id: AgentId;
  label: string;
  file: string;
  /** Exists when the agent is installed. */
  dir: string;
  format: ConfigFormat;
  reload: string;
  /** Manual setup, when it's simpler than pasting the config entry. */
  command?: (server: ServerCommand) => string;
  /**
   * The agent's own CLI, preferred over editing its config file: a running
   * Claude Code keeps ~/.claude.json in memory and wrote a removed entry back.
   */
  cli?: {
    program: string;
    /** Each step's arguments; steps marked optional may fail (nothing to remove). */
    add(server: ServerCommand): CliStep[];
    remove(): CliStep[];
  };
}

interface CliStep {
  args: string[];
  optional?: boolean;
}

const home = resolve(homedir());

/** Per-user app data: %APPDATA%, ~/Library/Application Support or ~/.config. */
function appDataDir(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? join(home, "AppData", "Roaming");
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? join(home, ".config");
}

const plain: ConfigFormat = { kind: "json", key: "mcpServers", entry: ({ command, args }) => ({ command, args }) };
const quote = (value: string) => (/[\s"]/.test(value) ? JSON.stringify(value) : value);

function agents(): Agent[] {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  const codexDir = process.env.CODEX_HOME ?? join(home, ".codex");
  const vscodeDir = join(appDataDir(), "Code", "User");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: join(claudeDir ?? home, ".claude.json"),
      dir: claudeDir ?? join(home, ".claude"),
      format: { kind: "json", key: "mcpServers", entry: ({ command, args }) => ({ type: "stdio", command, args, env: {} }) },
      reload: "Start a new Claude Code session, then check /mcp.",
      command: ({ command, args }) => `claude mcp add --scope user ${SERVER_NAME} -- ${[command, ...args].map(quote).join(" ")}`,
      cli: {
        program: "claude",
        add: ({ command, args }) => [
          ...claudeRemoveSteps(),
          { args: ["mcp", "add", "--scope", "user", SERVER_NAME, "--", command, ...args] },
        ],
        remove: claudeRemoveSteps,
      },
    },
    {
      id: "codex",
      label: "Codex",
      file: join(codexDir, "config.toml"),
      dir: codexDir,
      format: { kind: "toml" },
      reload: "Start a new Codex session.",
    },
    {
      id: "cursor",
      label: "Cursor",
      file: join(home, ".cursor", "mcp.json"),
      dir: join(home, ".cursor"),
      format: plain,
      reload: "Cursor reloads it; check Settings → MCP.",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      file: join(appDataDir(), "Claude", "claude_desktop_config.json"),
      dir: join(appDataDir(), "Claude"),
      format: plain,
      reload: "Quit Claude Desktop completely and open it again.",
    },
    {
      id: "vscode",
      label: "VS Code (Copilot)",
      file: join(vscodeDir, "mcp.json"),
      dir: vscodeDir,
      format: { kind: "json", key: "servers", entry: ({ command, args }) => ({ type: "stdio", command, args }) },
      reload: "Start the server from the Extensions view or MCP: List Servers.",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
      dir: join(home, ".codeium", "windsurf"),
      format: plain,
      reload: "Press Refresh in Windsurf's MCP settings.",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      file: join(home, ".gemini", "settings.json"),
      dir: join(home, ".gemini"),
      format: plain,
      reload: "Restart Gemini CLI, then check /mcp.",
    },
  ];
}

export async function handleHubRequest<M extends HubMethod>(
  method: M,
  params: HubMethods[M]["params"],
  server: ServerCommand,
): Promise<HubMethods[M]["result"]> {
  type Result = HubMethods[M]["result"];
  if (method === "list_agents") return { agents: await Promise.all(agents().map((a) => status(a, server))) } as Result;
  if (method === "add_agent" || method === "remove_agent") {
    const agent = agents().find((a) => a.id === (params as { agent?: unknown }).agent);
    if (!agent) throw new Error(`Unknown agent "${String((params as { agent?: unknown }).agent)}".`);
    await (method === "add_agent" ? add(agent, server) : remove(agent));
    return (await status(agent, server)) as Result;
  }
  throw new Error(`Unknown method "${method}".`);
}

async function status(agent: Agent, server: ServerCommand): Promise<AgentConfigStatus> {
  const result: AgentConfigStatus = {
    id: agent.id,
    label: agent.label,
    configPath: displayPath(agent.file),
    detected: existsSync(agent.dir) || existsSync(agent.file),
    state: "missing",
    snippet: agent.command?.(server) ?? configSnippet(agent.format, server),
    reload: agent.reload,
  };
  try {
    result.state = readEntry(agent.format, await readText(agent.file), server.args[0]);
  } catch (error) {
    result.state = "error";
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

async function add(agent: Agent, server: ServerCommand): Promise<void> {
  if (!existsSync(agent.dir) && !existsSync(agent.file)) {
    throw new Error(`${agent.label} doesn't seem to be installed (no ${displayPath(agent.dir)}).`);
  }
  if (agent.cli && (await hasCli(agent.cli.program))) return runSteps(agent.cli.program, agent.cli.add(server));
  const before = await readText(agent.file);
  await save(agent.file, before, addEntry(agent.format, before, server));
}

async function remove(agent: Agent): Promise<void> {
  if (agent.cli && (await hasCli(agent.cli.program))) return runSteps(agent.cli.program, agent.cli.remove());
  const before = await readText(agent.file);
  await save(agent.file, before, removeEntry(agent.format, before));
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Keeps a backup of the previous config next to it, and swaps the new one in
 * with a rename so an agent reading at the same moment never sees half a file.
 */
async function save(file: string, before: string, after: string): Promise<void> {
  if (after === before) return;
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) await copyFile(file, `${file}.goapp-figma.bak`);
  const temp = `${file}.goapp-figma.tmp`;
  await writeFile(temp, after);
  try {
    await rename(temp, file);
  } catch {
    // Windows refuses to replace a file another process holds open.
    await writeFile(file, after);
    await rm(temp, { force: true });
  }
}

function displayPath(path: string): string {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

// ---------------------------------------------------------------------------
// Agent CLIs

/** Our entry under its current and former names, in the user scope. */
function claudeRemoveSteps(): CliStep[] {
  return [SERVER_NAME, ...LEGACY_SERVER_NAMES].map((name) => ({ args: ["mcp", "remove", name, "--scope", "user"], optional: true }));
}

const cliChecks = new Map<string, Promise<boolean>>();

function hasCli(program: string): Promise<boolean> {
  let check = cliChecks.get(program);
  if (!check) {
    check = runCli(program, ["--version"]).then(
      () => true,
      () => false,
    );
    cliChecks.set(program, check);
  }
  return check;
}

async function runSteps(program: string, steps: CliStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await runCli(program, step.args);
    } catch (error) {
      if (!step.optional) throw error;
    }
  }
}

function runCli(program: string, args: string[]): Promise<string> {
  // npm installs CLIs as .cmd/.ps1 shims on Windows, which only a shell can run.
  const windows = process.platform === "win32";
  const quoted = windows ? args.map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
  return new Promise((resolve, reject) => {
    execFile(program, quoted, { shell: windows, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${program} ${args.join(" ")} failed: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}
