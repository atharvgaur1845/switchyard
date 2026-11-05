import { resolve } from "node:path";

// CLI agents read text written by people outside the company: emails, forms,
// visitors' messages. They must not be able to act on it, so every agent CLI
// runs with its tools, MCP servers, extensions and local context switched
// off. The flags are added here, not trusted to each config file.
//
// A config may only choose the model. Every other argument is refused, since
// CLIs have many ways to bring tools back (`--mcp-config`, `--settings`
// hooks, `--plugin-dir`, a bare `--` that turns later flags into text).

const LOCKDOWN: Record<string, string[]> = {
  // Tested: `pi --no-tools` cannot write files; plain `pi -p` can.
  pi: ["--no-tools", "--no-mcp", "--no-extensions", "--no-skills", "--no-context-files"],
  // `claude -p` already refuses tools that need permission; these also drop
  // the user's settings, MCP servers and CLAUDE.md, so nothing leaks in.
  claude: ["--tools", "", "--strict-mcp-config", "--setting-sources", ""],
};

// Switchyard's own deterministic agent (canned replies, no model, no tools).
export const FIXTURE_AGENT = resolve(import.meta.dirname, "fixture-agent.ts");

export class UnsafeAgentError extends Error {}

export function lockedCommand(command: string[]): string[] {
  // Absolute, because agents run in an empty temporary working folder.
  if (isFixtureAgent(command)) {
    const fixtures = command[2] === "--fixtures" ? ["--fixtures", resolve(command[3])] : [];
    return [command[0], FIXTURE_AGENT, ...fixtures];
  }

  const [binary, ...args] = command;
  const name = binary.split("/").at(-1)!;
  const flags = LOCKDOWN[name];
  if (!flags) {
    throw new UnsafeAgentError(
      `don't know how to run "${name}" without tools; supported agent CLIs: ${Object.keys(LOCKDOWN).join(", ")}`,
    );
  }

  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") {
      kept.push("-p");
    } else if (arg === "--model" && args[i + 1] && !args[i + 1].startsWith("-")) {
      kept.push("--model", args[++i]);
    } else if (/^--model=[^\s]+$/.test(arg)) {
      kept.push("--model", arg.slice("--model=".length));
    } else {
      throw new UnsafeAgentError(`"${arg}" is not allowed in an agent command: only -p and --model can be set`);
    }
  }
  if (!kept.includes("-p")) kept.unshift("-p");
  return [binary, ...kept, ...flags];
}

// Exactly `node <this repo's fixture agent> [--fixtures <dir>]`, nothing else.
function isFixtureAgent(command: string[]): boolean {
  const [binary, script, ...rest] = command;
  // `node` from PATH, or this very Node binary: never just any file named node.
  if (!binary || !script || (binary !== "node" && binary !== process.execPath) || resolve(script) !== FIXTURE_AGENT) return false;
  return rest.length === 0 || (rest.length === 2 && rest[0] === "--fixtures");
}

// The model vendor behind an agent command, for the different-vendor checks.
// Undefined when it can't be told, so no warning is guessed either way.
export function vendorOf(command: string[]): string | undefined {
  if (isFixtureAgent(command)) return "fixture";
  const name = command[0].split("/").at(-1)!;
  const flag = command.findIndex((a) => a === "--model" || a.startsWith("--model="));
  const model = flag === -1 ? "" : command[flag].includes("=") ? command[flag].split("=")[1] : (command[flag + 1] ?? "");
  if (model) {
    if (/gemini/i.test(model)) return "google";
    if (/claude|haiku|sonnet|opus/i.test(model)) return "anthropic";
    if (/gpt|^o\d/i.test(model)) return "openai";
  }
  if (name === "claude") return "anthropic";
  return undefined;
}
