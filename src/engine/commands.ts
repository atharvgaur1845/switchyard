import type { Flow } from "./flow-schema.ts";
import type { Chat, InboundMessage } from "./ports.ts";
import type { Runner } from "./runner.ts";
import type { CaseState, Store } from "./store.ts";

const HELP = `I run this room's flows. Ask me:
- \`@yard flows\`: the flows I run here
- \`@yard cases\`: open cases
- \`@yard status <case>\`: where a case is
- \`@yard start <flow> key=value ...\`: open a case by hand
- \`@yard cancel <case>\`: stop a case
- \`@yard reassign <case> @agent\`: give a waiting step to another agent`;

// People talk to @yard in the room. Agents can't: a command changes what
// runs, so it has to come from a person.
export class Commands {
  private readonly runner: Runner;
  private readonly store: Store;
  private readonly chat: Chat;
  private readonly flows: Flow[];

  constructor(runner: Runner, store: Store, chat: Chat, flows: Flow[]) {
    this.runner = runner;
    this.store = store;
    this.chat = chat;
    this.flows = flows;
  }

  // Returns true when the message was a command (handled or refused).
  async handle(message: InboundMessage): Promise<boolean> {
    const match = /^\s*@yard\b\s*(.*)$/is.exec(message.body);
    if (!match || !message.fromPerson) return false;

    const reply = (body: string) => this.chat.post(message.room, body, message.threadId ?? message.messageId);
    const [verb = "help", ...args] = match[1].trim().split(/\s+/).filter(Boolean);
    const roomFlows = this.flows.filter((f) => f.room === message.room);

    switch (verb.toLowerCase()) {
      case "flows":
        await reply(roomFlows.map((f) => `- \`${f.flow}\`: ${f.description ?? ""} (${f.steps.length} steps)`).join("\n") || "No flows run in this room.");
        break;

      case "cases": {
        const open = this.store.openCases().filter((c) => c.room === message.room);
        await reply(open.map((c) => `- \`${c.id}\` ${c.flow}: ${waitingOn(c)}`).join("\n") || "No open cases.");
        break;
      }

      case "status": {
        const state = this.find(args[0]);
        await reply(state ? describe(state, this.store) : `I have no case \`${args[0] ?? ""}\`.`);
        break;
      }

      case "start": {
        const flow = roomFlows.find((f) => f.flow === args[0]);
        if (!flow) {
          await reply(`No flow \`${args[0] ?? ""}\` here. \`@yard flows\` lists them.`);
          break;
        }
        const data = Object.fromEntries(
          args.slice(1).map((pair) => {
            const [key, ...rest] = pair.split("=");
            const value = rest.join("=");
            return [key, value !== "" && Number.isFinite(Number(value)) ? Number(value) : value];
          }),
        );
        const id = await this.runner.open(flow.flow, data, message.sender);
        await reply(`Opened case \`${id}\`.`);
        break;
      }

      case "cancel": {
        const state = this.find(args[0]);
        const done = state ? await this.runner.cancel(state.id, message.sender) : false;
        if (!done) await reply(`Case \`${args[0] ?? ""}\` is not open.`);
        break;
      }

      case "reassign": {
        const state = this.find(args[0]);
        const to = args[1]?.toLowerCase();
        if (!state || !to?.startsWith("@")) {
          await reply("Use `@yard reassign <case> @agent`.");
          break;
        }
        const problem = await this.runner.reassign(state.id, to, message.sender);
        if (problem) await reply(`Can't reassign: ${problem}.`);
        break;
      }

      default:
        await reply(HELP);
    }
    return true;
  }

  private find(id: string | undefined): CaseState | undefined {
    if (!id) return undefined;
    return this.store.caseIds().includes(id) ? this.store.load(id) : undefined;
  }
}

function waitingOn(state: CaseState): string {
  const pending = state.pending;
  if (!pending) return state.status;
  return pending.kind === "agent" ? `waiting on ${pending.agent} for "${pending.step}"` : `waiting on approval "${pending.step}"`;
}

function describe(state: CaseState, store: Store): string {
  const lines = [`Case \`${state.id}\` (${state.flow}): ${waitingOn(state)}`];
  for (const event of store.events(state.id)) {
    if (event.type === "answered") lines.push(`- ${event.step}: ${JSON.stringify(event.value)}`);
    if (event.type === "gate_answered") lines.push(`- ${event.step}: ${event.answer} by ${event.answeredBy}`);
    if (event.type === "executed") lines.push(`- ${event.step}: ${event.receipt}`);
    if (event.type === "failed_over") lines.push(`- ${event.step}: ${event.from} -> ${event.to} (${event.reason})`);
    if (event.type === "failed") lines.push(`- stopped at ${event.step}: ${event.reason}`);
  }
  return lines.join("\n");
}
