import { randomUUID } from "node:crypto";
import { readReply, stepRequest, stepToken } from "./contracts.ts";
import { compile, render, type Scope } from "./expr.ts";
import {
  type AgentStep,
  type Flow,
  type GateStep,
  type Step,
  durationMs,
  isAgent,
  isGate,
  isOutlet,
} from "./flow-schema.ts";
import { isApproval, mayAnswer, mention, type People } from "./gates.ts";
import type { ApprovalCard, ApprovalOutcome, Chat, InboundMessage, Outlets } from "./ports.ts";
import type { CaseState, Store } from "./store.ts";
import { describeOutlet, hashOutlet, renderOutlet } from "../outlets/payload.ts";

// Each agent gets one corrected retry before the case moves on: to the
// bench agent if there is one, then to a person.
const MAX_TRIES = 2;

// Replies that mean the agent's provider failed, not that the agent got the
// task wrong. These go to the bench agent instead of being re-asked.
const PROVIDER_FAILURE =
  /\b(provider error|rate.?limit(ed)?|usage limit|quota|overloaded|429|503|service unavailable|try again later)\b/i;

export interface RunnerOptions {
  now?: () => number;
  people?: People;
}

// Drives cases through their flow. It keeps no state of its own: every
// decision is made from the case's event log, and every change is appended to
// it before the next step runs.
export class Runner {
  private readonly store: Store;
  private readonly chat: Chat;
  private readonly outlets: Outlets;
  private readonly flows: Map<string, Flow>;
  private readonly now: () => number;
  private readonly people: People;

  constructor(store: Store, chat: Chat, outlets: Outlets, flows: Flow[], options: RunnerOptions = {}) {
    this.store = store;
    this.chat = chat;
    this.outlets = outlets;
    this.flows = new Map(flows.map((flow) => [flow.flow, flow]));
    this.now = options.now ?? Date.now;
    this.people = options.people ?? {};
  }

  flowNames(): string[] {
    return [...this.flows.keys()];
  }

  async open(flowName: string, data: Record<string, unknown>, source: string): Promise<string> {
    const flow = this.flows.get(flowName);
    if (!flow) throw new Error(`no flow named "${flowName}"`);

    const id = randomUUID().slice(0, 8);
    this.store.append(id, { type: "opened", flow: flow.flow, room: flow.room, data, source });
    const threadId = await this.chat.post(flow.room, `Case ${id} opened by ${source}: ${flow.description ?? flow.flow}`);
    this.store.append(id, { type: "thread", threadId });
    await this.advance(id);
    return id;
  }

  // Runs steps until the case waits on someone, finishes or fails.
  async advance(caseId: string): Promise<void> {
    for (;;) {
      const state = this.store.load(caseId);
      if (state.status !== "open" || state.pending) return;

      const step = this.flowOf(state).steps.find((s) => !state.finished.has(s.id));
      if (!step) {
        this.store.append(caseId, { type: "done" });
        await this.say(state, `Case ${caseId} is done.`);
        return;
      }

      if (step.when !== undefined && !compile(step.when)(scopeOf(state))) {
        this.store.append(caseId, { type: "skipped", step: step.id });
        continue;
      }

      const waiting = await this.start(state, step);
      if (waiting) return;
    }
  }

  // Starts one step. Returns true when the case must now wait (or stopped).
  private async start(state: CaseState, step: Step): Promise<boolean> {
    if (isAgent(step)) {
      await this.ask(state, step, step.agent, 1, 1);
      return true;
    }
    if (isGate(step)) {
      await this.openGate(state, step);
      return true;
    }
    if (isOutlet(step)) {
      const payload = renderOutlet(step.outlet, scopeOf(state));
      const hash = hashOutlet(payload);
      const rule = step.auto_approve;
      const autoApproved = rule === true || (typeof rule === "string" && Boolean(compile(rule)(scopeOf(state))));
      if (!autoApproved) {
        const approval = state.approved[step.id];
        if (!approval || approval.hash !== hash) {
          const reason = approval
            ? `the action changed after it was approved (${approval.hash} approved, ${hash} now)`
            : "nobody approved it";
          this.store.append(state.id, { type: "failed", step: step.id, reason });
          await this.say(state, `Stopped before "${step.id}": ${reason}. Nothing was sent.`);
          return true;
        }
      }
      const receipt = await this.outlets.execute(payload, `${state.id}/${step.id}`);
      this.store.append(state.id, { type: "executed", step: step.id, hash, receipt });
      const by = autoApproved ? `rule "${rule === true ? "always" : rule}"` : state.approved[step.id].by;
      await this.say(state, `Done: ${receipt} (approved by ${by}, ${hash})`);
      return false;
    }
    return false;
  }

  private async ask(state: CaseState, step: AgentStep, agent: string, attempt: number, tries: number, correction?: string) {
    const token = stepToken(state.id, step.id, attempt);
    this.store.append(state.id, { type: "asked", step: step.id, agent, token, attempt, tries, at: this.now() });
    const body = stepRequest({
      ask: render(step.ask, scopeOf(state)),
      expect: step.expect,
      token,
      untrusted: state.data,
      context: state.results,
      correction,
    });
    await this.chat.sendTargeted(state.room, agent, body, state.threadId!);
  }

  private async openGate(state: CaseState, step: GateStep): Promise<void> {
    const scope = scopeOf(state);
    const hashes: Record<string, string> = {};
    for (const target of step.gate.approves) {
      const outlet = this.flowOf(state).steps.find((s) => s.id === target);
      if (outlet && isOutlet(outlet)) hashes[target] = hashOutlet(renderOutlet(outlet.outlet, scope));
    }
    const requestId = `${state.id}-${step.id}`;
    this.store.append(state.id, {
      type: "gate_opened",
      step: step.id,
      requestId,
      approver: step.gate.approver,
      hashes,
      at: this.now(),
    });
    await this.chat.openApproval(this.gateCard(state, step, requestId, step.gate.approver));
  }

  // The card shows the exact actions an answer authorizes, so the person
  // approves what will happen rather than a summary of it.
  private gateCard(state: CaseState, step: GateStep, requestId: string, addressee: string, note?: string): ApprovalCard {
    const scope = scopeOf(state);
    const previews = step.gate.approves.flatMap((target) => {
      const outlet = this.flowOf(state).steps.find((s) => s.id === target);
      if (!outlet || !isOutlet(outlet)) return [];
      const payload = renderOutlet(outlet.outlet, scope);
      return [`${describeOutlet(payload)}\n(approval ${hashOutlet(payload)})`];
    });
    const detail = previews.join("\n\n") || "No outside action depends on this answer.";
    return {
      requestId,
      room: state.room,
      threadId: state.threadId!,
      title: `${mention(this.people, addressee)} ${render(step.gate.title, scope)}`,
      detail: note ? `${note}\n\n${detail}` : detail,
      options: step.gate.options,
    };
  }

  async onMessage(message: InboundMessage): Promise<void> {
    const state = this.store
      .openCases()
      .find((c) => c.threadId !== undefined && c.threadId === message.threadId);
    const pending = state?.pending;
    if (!state || pending?.kind !== "agent" || message.sender !== pending.agent) return;

    const step = this.stepOf(state, pending.step);
    if (!step || !isAgent(step)) return;

    const reply = readReply(message.body, step.expect);
    // A reply carrying an older attempt's token is stale; the newer request
    // is still outstanding.
    if (reply.token !== undefined && reply.token !== pending.token) return;

    if (reply.ok) {
      this.store.append(state.id, { type: "answered", step: step.id, value: reply.value });
      await this.advance(state.id);
      return;
    }

    this.store.append(state.id, { type: "reply_rejected", step: step.id, error: reply.error });
    if (PROVIDER_FAILURE.test(message.body) && (await this.failOver(state, step, "its provider reported an error"))) {
      return;
    }
    if (pending.tries < MAX_TRIES) {
      await this.ask(state, step, pending.agent, pending.attempt + 1, pending.tries + 1, reply.error);
      return;
    }
    if (await this.failOver(state, step, `its replies did not match the step's contract (${reply.error})`)) return;
    this.store.append(state.id, { type: "failed", step: step.id, reason: reply.error });
    await this.say(state, `${pending.agent} could not finish "${step.id}" (${reply.error}). A person needs to take this case.`);
  }

  // Hands an agent step to its bench agent. Returns false when there is no
  // bench, or the bench is the one already failing.
  private async failOver(state: CaseState, step: AgentStep, reason: string): Promise<boolean> {
    const current = state.pending?.kind === "agent" ? state.pending : undefined;
    if (!current || !step.bench || current.agent === step.bench) return false;

    this.store.append(state.id, { type: "failed_over", step: step.id, from: current.agent, to: step.bench, reason });
    await this.say(state, `${current.agent} is not answering "${step.id}" (${reason}); handing it to ${step.bench}.`);
    await this.ask(state, step, step.bench, current.attempt + 1, 1);
    return true;
  }

  async onApproval(outcome: ApprovalOutcome): Promise<void> {
    const state = this.store
      .openCases()
      .find((c) => c.pending?.kind === "gate" && c.pending.requestIds.includes(outcome.requestId));
    const pending = state?.pending;
    if (!state || pending?.kind !== "gate") return;

    const step = this.stepOf(state, pending.step);
    if (!step || !isGate(step)) return;

    const answerer = await this.chat.handleOf(outcome.answeredBy);
    if (!mayAnswer(step.gate, answerer, pending.escalated, this.people)) {
      const deciders = pending.escalated && step.gate.backup
        ? `${step.gate.approver} or ${step.gate.backup}`
        : step.gate.approver;
      await this.say(state, `${answerer ?? "That answer"} cannot decide "${step.id}"; it is for ${deciders}.`);
      // Switch keeps one answer per card, so a re-opened card is a new request.
      const requestId = `${state.id}-${step.id}-r${pending.requestIds.length}`;
      this.store.append(state.id, { type: "card_reopened", step: step.id, requestId });
      await this.chat.openApproval(
        this.gateCard(state, step, requestId, step.gate.approver, `Re-opened: only ${deciders} can decide this.`),
      );
      return;
    }

    this.store.append(state.id, {
      type: "gate_answered",
      step: step.id,
      answer: outcome.answer,
      answeredBy: answerer!,
      approved: isApproval(step.gate, outcome.answer),
    });
    await this.advance(state.id);
  }

  async cancel(caseId: string, by: string): Promise<boolean> {
    const state = this.store.load(caseId);
    if (state.status !== "open") return false;
    this.store.append(caseId, { type: "cancelled", by });
    await this.say(state, `Case ${caseId} was cancelled by ${by}. Nothing further will run.`);
    return true;
  }

  // Moves a waiting agent step to another agent, on a person's word.
  async reassign(caseId: string, to: string, by: string): Promise<string | undefined> {
    const state = this.store.load(caseId);
    const pending = state.pending;
    if (state.status !== "open" || pending?.kind !== "agent") return "that case is not waiting on an agent";
    const step = this.stepOf(state, pending.step);
    if (!step || !isAgent(step)) return "that step is not an agent step";

    this.store.append(caseId, { type: "failed_over", step: step.id, from: pending.agent, to, reason: `reassigned by ${by}` });
    await this.say(state, `${by} moved "${step.id}" from ${pending.agent} to ${to}.`);
    await this.ask(state, step, to, pending.attempt + 1, 1);
    return undefined;
  }

  // Called on an interval. Reminds approvers, escalates overdue gates and
  // moves stalled agent steps to their bench. Everything it does is logged,
  // so a restart never repeats a reminder or an escalation.
  async tick(): Promise<void> {
    const now = this.now();
    for (const state of this.store.openCases()) {
      const pending = state.pending;
      if (!pending) continue;
      const step = this.stepOf(state, pending.step);

      if (pending.kind === "agent" && step && isAgent(step) && step.sla) {
        if (now - pending.at >= durationMs(step.sla)) {
          await this.failOver(state, step, `no answer within ${step.sla}`);
        }
        continue;
      }

      if (pending.kind !== "gate" || !step || !isGate(step) || !step.gate.deadline) continue;
      const { gate } = step;
      const deadline = durationMs(step.gate.deadline);
      const elapsed = now - pending.at;

      if (!pending.reminded && elapsed >= deadline / 2) {
        this.store.append(state.id, { type: "reminded", step: step.id });
        const left = Math.max(1, Math.round((deadline - elapsed) / 60_000));
        await this.say(state, `${mention(this.people, gate.approver)} reminder: "${render(gate.title, scopeOf(state))}" is waiting on you (about ${left} min left).`);
      }

      if (!pending.escalated && elapsed >= deadline) {
        const requestId = `${state.id}-${step.id}-escalated`;
        this.store.append(state.id, { type: "escalated", step: step.id, requestId, to: gate.backup });
        if (gate.backup) {
          await this.say(state, `${gate.approver} has not answered in ${gate.deadline}; ${mention(this.people, gate.backup)} can decide now.`);
          await this.chat.openApproval(
            this.gateCard(state, step, requestId, gate.backup, `Escalated: ${gate.approver} did not answer in ${gate.deadline}.`),
          );
        } else {
          await this.say(state, `${mention(this.people, gate.approver)}: "${render(gate.title, scopeOf(state))}" is overdue (${gate.deadline}).`);
        }
      }
    }
  }

  private flowOf(state: CaseState): Flow {
    return this.flows.get(state.flow)!;
  }

  private stepOf(state: CaseState, id: string): Step | undefined {
    return this.flowOf(state).steps.find((s) => s.id === id);
  }

  private async say(state: CaseState, body: string): Promise<void> {
    await this.chat.post(state.room, body, state.threadId);
  }
}

// What `when:` conditions and `{placeholders}` can see: the case data under
// `case`, and each finished step's result under its id.
export function scopeOf(state: CaseState): Scope {
  return { case: state.data, ...state.results };
}
