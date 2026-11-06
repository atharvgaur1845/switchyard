import type { Flow } from "./flow-schema.ts";
import { fills, type People } from "./gates.ts";
import type { Chat, InboundMessage } from "./ports.ts";
import { docHash, short } from "./verifiers.ts";
import type { Runner } from "./runner.ts";
import type { CaseState, Store } from "./store.ts";

const HELP = `I run this room's flows. Ask me:
- \`@yard flows\`: the flows I run here
- \`@yard cases\`: open cases
- \`@yard status <case>\`: where a case is
- \`@yard start <flow> key=value ...\`: open a case by hand
- \`@yard cancel <case>\`: stop a case
- \`@yard reassign <case> @agent\`: give a waiting step to another agent
- \`@yard resume <case>\`: end a wait step early
- \`@yard docs\`: this room's documents (the rules agents and checks use)
- \`@yard edit <document> "<old text>" "<new text>"\`: change a rule (approvers only)`;

// People talk to @yard in the room. Agents can't: a command changes what
// runs, so it has to come from a person.
export class Commands {
  private readonly runner: Runner;
  private readonly store: Store;
  private readonly chat: Chat;
  private readonly flows: Flow[];
  private readonly people: People;

  constructor(runner: Runner, store: Store, chat: Chat, flows: Flow[], people: People = {}) {
    this.runner = runner;
    this.store = store;
    this.chat = chat;
    this.flows = flows;
    this.people = people;
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
        const state = this.find(args[0], message.room);
        await reply(state ? describe(state, this.store) : `I have no case \`${args[0] ?? ""}\`.`);
        break;
      }

      case "start": {
        const flow = roomFlows.find((f) => f.flow === args[0]);
        if (!flow) {
          await reply(`No flow \`${args[0] ?? ""}\` here. \`@yard flows\` lists them.`);
          break;
        }
        // A flow that pays or rewrites the room's records only takes work from
        // its signed inlet: a case typed into chat skips the signature.
        if (flow.steps.some((s) => "outlet" in s && ("pay" in s.outlet || "document" in s.outlet))) {
          await reply(`\`${flow.flow}\` cases only come in through its own inlet (${Object.keys(flow.inlet ?? {}).join(", ") || "none"}), never from chat: it pays or changes the room's records.`);
          break;
        }
        // Anything else started by hand still needs someone who holds a role.
        const may = Object.keys(this.people).length === 0
          ? "No one can start cases from chat until switchyard.yaml maps roles to people (people:)."
          : this.mayAct(message.sender, flow);
        if (may) {
          await reply(may);
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
        const state = this.find(args[0], message.room);
        const refused = this.refuse(message.sender, state);
        if (refused) {
          await reply(refused);
          break;
        }
        const done = state ? await this.runner.cancel(state.id, message.sender) : false;
        if (!done) await reply(`Case \`${args[0] ?? ""}\` is not open.`);
        break;
      }

      case "reassign": {
        const state = this.find(args[0], message.room);
        const refused = this.refuse(message.sender, state);
        if (refused) {
          await reply(refused);
          break;
        }
        const to = args[1]?.toLowerCase();
        if (!state || !to?.startsWith("@")) {
          await reply("Use `@yard reassign <case> @agent`.");
          break;
        }
        const problem = await this.runner.reassign(state.id, to, message.sender);
        if (problem) await reply(`Can't reassign: ${problem}.`);
        break;
      }

      case "resume": {
        const state = this.find(args[0], message.room);
        const refused = this.refuse(message.sender, state);
        if (refused) {
          await reply(refused);
          break;
        }
        const problem = state ? await this.runner.resume(state.id, message.sender) : `no case \`${args[0] ?? ""}\``;
        if (problem) await reply(`Can't resume: ${problem}.`);
        break;
      }

      case "docs": {
        if (!this.chat.documents) {
          await reply("This Switch connection cannot read room documents.");
          break;
        }
        const docs = await this.chat.documents(message.room);
        await reply(
          docs.map((d) => `- \`${d.name}\` (version \`${short(docHash(d.content))}\`)${d.description ? `: ${d.description}` : ""}`).join("\n") ||
            "This room has no documents.",
        );
        break;
      }

      case "edit": {
        await reply(await this.edit(message, match[1]));
        break;
      }

      default:
        await reply(HELP);
    }
    return true;
  }

  // Changing a rule changes what agents and checks decide from then on, so
  // only people who fill an approver role may do it, the change must match
  // exactly one place, and the room is told the old and new versions.
  private async edit(message: InboundMessage, text: string): Promise<string> {
    const parsed = /^edit\s+(\S+)\s+"((?:[^"\\]|\\.)+)"\s+"((?:[^"\\]|\\.)*)"\s*$/s.exec(text.trim());
    if (!parsed) return 'Use `@yard edit <document> "<old text>" "<new text>"`.';
    const [, name, oldText, newText] = parsed;
    const roles = Object.entries(this.people).filter(([, who]) => who.includes(message.sender)).map(([role]) => role);
    if (roles.length === 0) return `${message.sender} cannot change this room's rules: only people who fill an approver role can.`;
    if (!this.chat.documents || !this.chat.updateDocument) return "This Switch connection cannot change room documents.";

    // A document a code check reads decides payments by itself (the account
    // on file, the PO amount), so one person may not change it from chat:
    // it changes only through a flow with its own checks and four eyes.
    const checkedBy = this.flows
      .filter((f) => f.room === message.room)
      .flatMap((f) => f.steps.filter((s) => "verify" in s && s.verify.doc === name).map((s) => `${f.flow}.${s.id}`));
    if (checkedBy.length) {
      const via = this.flows.find((f) => f.room === message.room && f.steps.some((s) => "outlet" in s && "document" in s.outlet && s.outlet.document.name === name));
      return `\`${name}\` is read by code checks (${checkedBy.join(", ")}), so it cannot be edited from chat${via ? `; changes go through a \`${via.flow}\` case (a callback and a second approver)` : ""}.`;
    }
    const doc = (await this.chat.documents(message.room)).find((d) => d.name === name);
    if (!doc) return `No document \`${name}\` here. \`@yard docs\` lists them.`;
    const count = doc.content.split(oldText).length - 1;
    if (count !== 1) return `"${oldText}" appears ${count} times in \`${name}\`; it must appear exactly once.`;
    const content = doc.content.replace(oldText, newText);
    await this.chat.updateDocument(message.room, doc.id, content);
    return `${message.sender} (${roles.join(", ")}) changed \`${name}\`: "${oldText}" → "${newText}". Version \`${short(docHash(doc.content))}\` → \`${short(docHash(content))}\`; cases asked from now on use the new version.`;
  }

  // A case is only reachable from its own room: someone in #sales cannot
  // cancel a payment waiting in #finance.
  private find(id: string | undefined, room: string): CaseState | undefined {
    if (!id || !this.store.caseIds().includes(id)) return undefined;
    const state = this.store.load(id);
    return state.room === room ? state : undefined;
  }

  // Cancelling, reassigning or resuming changes what happens to a case, so
  // when switchyard.yaml names people, only someone who fills a role the
  // case's flow uses may do it.
  private refuse(sender: string, state: CaseState | undefined): string | undefined {
    if (!state) return undefined;
    const flow = this.flows.find((f) => f.flow === state.flow);
    return flow ? this.mayAct(sender, flow, `case \`${state.id}\``) : undefined;
  }

  private mayAct(sender: string, flow: Flow, what = `a \`${flow.flow}\` case`): string | undefined {
    if (Object.keys(this.people).length === 0) return undefined;
    // A flow with no gates names no roles: anyone who holds one may act.
    const named = flow.steps.flatMap((s) => ("gate" in s ? [s.gate.approver, ...(s.gate.backup ? [s.gate.backup] : [])] : []));
    const roles = new Set(named.length ? named : Object.keys(this.people));
    return [...roles].some((role) => fills(this.people, role, sender)) ? undefined : `${sender} cannot start or change ${what}: only ${[...roles].join(" or ")} can.`;
  }
}

function waitingOn(state: CaseState): string {
  const pending = state.pending;
  if (!pending) return state.status;
  if (pending.kind === "parallel") return `waiting on ${Object.keys(pending.agents).join(" and ")} for "${pending.step}"`;
  if (pending.kind === "in_doubt") return `in doubt: did "${pending.step}" go out? (waiting on a person)`;
  if (pending.kind === "wait") return `waiting until ${new Date(pending.until).toUTCString()}`;
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
