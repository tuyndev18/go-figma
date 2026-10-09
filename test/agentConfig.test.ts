import { describe, expect, it } from "vitest";
import { addEntry, configSnippet, readEntry, removeEntry, stripJsonc, type ConfigFormat } from "../mcp/agentConfig";

const server = { command: "node", args: ["C:\\tools\\go-figma\\dist\\mcp.mjs"] };
const json: ConfigFormat = { kind: "json", key: "mcpServers", entry: ({ command, args }) => ({ command, args }) };
const vscode: ConfigFormat = { kind: "json", key: "servers", entry: ({ command, args }) => ({ type: "stdio", command, args }) };
const toml: ConfigFormat = { kind: "toml" };

describe("JSON agent configs", () => {
  it("adds the entry next to other servers and settings", () => {
    const before = '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n';
    const after = addEntry(json, before, server);
    expect(JSON.parse(after)).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "x" }, "goapp-figma": { command: "node", args: server.args } },
    });
    expect(readEntry(json, after, server.args[0])).toBe("configured");
  });

  it("creates the file content from nothing, keeping tabs and CRLF when the file uses them", () => {
    expect(JSON.parse(addEntry(json, "", server))).toEqual({ mcpServers: { "goapp-figma": { command: "node", args: server.args } } });
    const after = addEntry(json, '{\r\n\t"a": 1\r\n}\r\n', server);
    expect(after).toContain('\r\n\t"mcpServers"');
    expect(after.endsWith("}\r\n")).toBe(true);
  });

  it("tells a stale entry from a current one, however the path is spelled", () => {
    const current = JSON.stringify({ mcpServers: { "goapp-figma": { command: "node", args: ["c:/Tools/go-figma/dist/mcp.mjs"] } } });
    const stale = JSON.stringify({ mcpServers: { "goapp-figma": { command: "node", args: ["D:/old/mcp.mjs"] } } });
    expect(readEntry(json, current, server.args[0])).toBe("configured");
    expect(readEntry(json, stale, server.args[0])).toBe("outdated");
    expect(readEntry(json, "{}", server.args[0])).toBe("missing");
    expect(readEntry(json, "", server.args[0])).toBe("missing");
  });

  it("removes only the goapp-figma entry", () => {
    const before = addEntry(json, JSON.stringify({ mcpServers: { other: { command: "x" } } }), server);
    expect(JSON.parse(removeEntry(json, before))).toEqual({ mcpServers: { other: { command: "x" } } });
    const untouched = '{ "mcpServers": {} }';
    expect(removeEntry(json, untouched)).toBe(untouched);
  });

  it("reads JSONC but refuses to rewrite it, since comments would be lost", () => {
    const jsonc = '{\n  // servers\n  "servers": {\n    "a": { "url": "http://x//y", }, /* b */\n  },\n}';
    expect(JSON.parse(stripJsonc(jsonc))).toEqual({ servers: { a: { url: "http://x//y" } } });
    expect(readEntry(vscode, jsonc, server.args[0])).toBe("missing");
    expect(() => addEntry(vscode, jsonc, server)).toThrow(/comments/);
  });

  it("rejects files that aren't a JSON object", () => {
    expect(() => readEntry(json, "{ nope", server.args[0])).toThrow(/valid JSON/);
    expect(() => readEntry(json, "[]", server.args[0])).toThrow(/object/);
    expect(() => addEntry(json, '{ "mcpServers": [] }', server)).toThrow(/mcpServers/);
  });
});

describe("Codex config.toml", () => {
  const base = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "mini"\n';

  it("appends a table whose strings TOML reads like JSON", () => {
    const after = addEntry(toml, base, server);
    expect(after).toBe(`${base}\n[mcp_servers.goapp-figma]\ncommand = "node"\nargs = ["C:\\\\tools\\\\go-figma\\\\dist\\\\mcp.mjs"]\n`);
    expect(readEntry(toml, after, server.args[0])).toBe("configured");
    expect(addEntry(toml, "", server)).toBe(`${configSnippet(toml, server)}\n`);
  });

  it("removes the table and its subtables, leaving the rest as it was", () => {
    const withEntry =
      'model = "o4"\n\n[mcp_servers."goapp-figma"]\ncommand = "node"\nargs = [\'D:\\old\\mcp.mjs\']\n\n[mcp_servers.goapp-figma.env]\nA = "1"\n\n[profiles.fast]\nmodel = "mini"\n';
    expect(readEntry(toml, withEntry, server.args[0])).toBe("outdated");
    expect(removeEntry(toml, withEntry)).toBe('model = "o4"\n\n[profiles.fast]\nmodel = "mini"\n');
    expect(removeEntry(toml, base)).toBe(base);
  });

  it("replaces an existing table instead of adding a second one", () => {
    const twice = addEntry(toml, addEntry(toml, base, { command: "node", args: ["D:/old.mjs"] }), server);
    expect(twice.match(/\[mcp_servers\.goapp-figma\]/g)).toHaveLength(1);
    expect(readEntry(toml, twice, server.args[0])).toBe("configured");
  });

  it("leaves inline entries for the user to edit", () => {
    const inline = '[mcp_servers]\ngoapp-figma = { command = "node", args = ["C:/tools/go-figma/dist/mcp.mjs"] }\n';
    expect(readEntry(toml, inline, server.args[0])).toBe("configured");
    expect(() => addEntry(toml, inline, server)).toThrow(/inline/);
  });
});

describe("entries under the old go-figma name", () => {
  const legacyJson = JSON.stringify({ mcpServers: { other: { command: "x" }, "go-figma": { command: "node", args: server.args } } });
  const legacyToml = 'model = "o4"\n\n[mcp_servers.go-figma]\ncommand = "node"\nargs = ["C:/tools/go-figma/dist/mcp.mjs"]\n';

  it("reads them as outdated, so the panel offers Update", () => {
    expect(readEntry(json, legacyJson, server.args[0])).toBe("outdated");
    expect(readEntry(toml, legacyToml, server.args[0])).toBe("outdated");
  });

  it("renames them when set up again", () => {
    const after = JSON.parse(addEntry(json, legacyJson, server));
    expect(Object.keys(after.mcpServers)).toEqual(["other", "goapp-figma"]);
    const tomlAfter = addEntry(toml, legacyToml, server);
    expect(tomlAfter).not.toContain("[mcp_servers.go-figma]");
    expect(tomlAfter).toContain("[mcp_servers.goapp-figma]");
    expect(readEntry(toml, tomlAfter, server.args[0])).toBe("configured");
  });

  it("removes them too", () => {
    expect(JSON.parse(removeEntry(json, legacyJson))).toEqual({ mcpServers: { other: { command: "x" } } });
    expect(removeEntry(toml, legacyToml)).toBe('model = "o4"\n');
  });
});
