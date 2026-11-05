import { describe, expect, it } from "vitest";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { FIXTURE_AGENT, lockedCommand, UnsafeAgentError, vendorOf } from "../src/agents/lockdown.ts";
import { vendorProblems } from "../src/agents/vendors.ts";

describe("agent lockdown", () => {
  it("switches off pi's tools, MCP, extensions, skills and context files", () => {
    expect(lockedCommand(["pi", "-p", "--model", "gemini-flash-lite-latest"])).toEqual([
      "pi", "-p", "--model", "gemini-flash-lite-latest",
      "--no-tools", "--no-mcp", "--no-extensions", "--no-skills", "--no-context-files",
    ]);
  });

  it("switches off claude's tools and drops user settings and MCP servers", () => {
    expect(lockedCommand(["claude", "-p", "--model", "haiku"])).toEqual([
      "claude", "-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    ]);
  });

  it.each([
    [["claude", "-p", "--tools", "Bash"]],
    [["claude", "-p", "--tools=Bash"]],
    [["claude", "-p", "--"]],
    [["claude", "-p", "--mcp-config", "x.json", "--allowedTools", "mcp__x"]],
    [["claude", "-p", "--settings", "hooks.json"]],
    [["claude", "-p", "--plugin-dir", "./p"]],
    [["pi", "-p", "-e", "./ext.js"]],
    [["pi", "-p", "--tools", "bash"]],
  ])("refuses a config that could bring tools back: %j", (command) => {
    expect(() => lockedCommand(command)).toThrow(UnsafeAgentError);
  });

  it("accepts --model=value and adds -p when it is missing", () => {
    expect(lockedCommand(["pi", "--model=gemini-flash-lite-latest"]).slice(0, 4)).toEqual(["pi", "-p", "--model", "gemini-flash-lite-latest"]);
  });

  it("exempts only the real fixture agent, not anything that mentions it", () => {
    expect(() => lockedCommand(["bash", "-c", "rm -rf ~ # fixture-agent.ts"])).toThrow(UnsafeAgentError);
    expect(() => lockedCommand(["node", "/tmp/evil/fixture-agent.ts"])).toThrow(UnsafeAgentError);
    expect(lockedCommand(["node", FIXTURE_AGENT])).toEqual(["node", FIXTURE_AGENT]);
  });

  it("refuses a CLI it cannot lock down", () => {
    expect(() => lockedCommand(["codex", "exec"])).toThrow(UnsafeAgentError);
    expect(() => lockedCommand(["bash", "-c", "cat"])).toThrow(/without tools/);
  });

  it("names the vendor behind each command", () => {
    expect(vendorOf(["claude", "-p", "--model", "haiku"])).toBe("anthropic");
    expect(vendorOf(["pi", "-p", "--model", "gemini-flash-lite-latest"])).toBe("google");
    expect(vendorOf(["pi", "-p", "--model", "claude-haiku-4-5"])).toBe("anthropic");
    expect(vendorOf(["pi", "-p", "--model=gemini-flash-lite-latest"])).toBe("google");
    expect(vendorOf(["pi", "-p"])).toBeUndefined();
  });
});

describe("different-vendor checks", () => {
  const flow = loadFlow(`
flow: f
room: r
steps:
  - id: check
    agent: "@a"
    ask: q
    expect: { v: str }
    bench: "@b"
  - id: both
    parallel: ["@c", "@d"]
    ask: q
    expect: { v: [x, y] }
`);
  const claude = ["claude", "-p", "--model", "haiku"];
  const gemini = ["pi", "-p", "--model", "gemini-flash-lite-latest"];

  it("is quiet when backups and parallel checkers use different vendors", () => {
    expect(vendorProblems([flow], { a: claude, b: gemini, c: claude, d: gemini })).toEqual([]);
  });

  it("reports a backup on the same vendor, and same-vendor parallel checkers", () => {
    expect(vendorProblems([flow], { a: claude, b: claude, c: gemini, d: gemini })).toEqual([
      { flow: "f", step: "check", agents: ["@a", "@b"], vendor: "anthropic" },
      { flow: "f", step: "both", agents: ["@c", "@d"], vendor: "google" },
    ]);
  });
});
