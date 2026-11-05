import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { InboundMessage, RoomDocument } from "../engine/ports.ts";
import type { SwitchClient } from "../switch/client.ts";
import { lockedCommand } from "./lockdown.ts";

// A Switch agent backed by any coding-agent CLI run headless, one process
// per request: `claude -p`, `pi -p`, `codex exec`. It is how Switchyard's
// starter flows run without Switch Console: the agent's instructions and
// the room's documents come from the same template Console would install.

export interface CliAgentSpec {
  name: string;
  command: string[];
  template: string;
  timeoutMs?: number;
}

// The agent's standing instructions come from its template. The room's
// documents (policy, prices, FAQ) do not: they are read from Switch for every
// request, so a change made in the room applies to the very next case.
export function systemPrompt(templatePath: string, agentName: string): { room: string; instructions: string } {
  const template = parse(readFileSync(templatePath, "utf8"));
  const agent = template.agents.find((a: { name: string }) => a.name === agentName);
  if (!agent) throw new Error(`${templatePath} has no agent named ${agentName}`);
  return {
    room: template.room.name,
    instructions: [
      `You are @${agentName}, an agent in the Switch room "${template.room.name}".`,
      agent.instructions,
      template.room.instructions ?? "",
    ].join("\n\n"),
  };
}

export function documentsSection(docs: RoomDocument[]): string {
  if (docs.length === 0) return "This room has no documents.";
  return docs.map((d) => `## Room document: ${d.name}\n\n${d.content}`).join("\n\n");
}

export class CliAgent {
  private readonly spec: CliAgentSpec;
  private readonly client: SwitchClient;
  private readonly prompt: { room: string; instructions: string };
  // The command as it actually runs: with its tools switched off.
  readonly command: string[];
  // An empty working folder. The real protection is the lockdown flags: a
  // working directory alone confines nothing.
  private readonly cwd = mkdtempSync(join(tmpdir(), "switchyard-agent-"));
  private queue: Promise<void> = Promise.resolve();

  constructor(spec: CliAgentSpec, client: SwitchClient) {
    this.spec = spec;
    this.client = client;
    this.prompt = systemPrompt(spec.template, spec.name);
    this.command = lockedCommand(spec.command);
  }

  start(): void {
    this.client.onMessage((message) => {
      if (process.env.SWITCHYARD_DEBUG) console.log(`[${this.spec.name}] got message addressed=${message.addressed}`);
      if (!message.addressed) return;
      // One request at a time, in arrival order, like a person working a queue.
      this.queue = this.queue.then(() => this.answer(message)).catch((error) => {
        console.error(`[${this.spec.name}]`, error);
      });
    });
  }

  private async answer(message: InboundMessage): Promise<void> {
    if (process.env.SWITCHYARD_DEBUG) console.log(`[${this.spec.name}] running ${this.command[0]}`);
    let reply: string;
    try {
      // Without the room's rules the agent must not guess: a failed read
      // fails the request, and @yard moves the step on, then to a person.
      const docs = this.command.some((a) => a.endsWith("fixture-agent.ts")) ? [] : await this.client.documents(this.prompt.room);
      const request = `${this.prompt.instructions}\n\n${documentsSection(docs)}\n\nAnswer with the text of your chat reply only.\n\n# Message from ${message.sender}\n\n${message.body}`;
      if (simulatedOutage(this.spec.name)) {
        throw new Error("usage limit reached (simulated outage: SWITCHYARD_OUTAGE)");
      }
      reply = await run(this.command, request, this.cwd, this.spec.timeoutMs ?? 300_000);
    } catch (error) {
      // Said in the room, so @yard's failover sees it like any provider error.
      reply = `Provider error: ${(error as Error).message}`;
    }
    await this.client.post(message.room, reply.trim() || "Error: empty reply", message.threadId ?? message.messageId);
  }
}

// SWITCHYARD_OUTAGE=policy,desk makes those agents fail the way a provider
// at its usage limit does, to show and test failover without waiting for one.
function simulatedOutage(name: string): boolean {
  return (process.env.SWITCHYARD_OUTAGE ?? "").split(",").map((s) => s.trim()).includes(name);
}

function run(command: string[], input: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command[0]} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command[0]} exited ${code}: ${(err || out).trim().slice(-300)}`));
    });
    child.stdin.end(input);
  });
}
