import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readReply, stepRequest, stepToken } from "./contracts.ts";
import { compile, lookup, render, type Scope } from "./expr.ts";
import { basisHash, CHECKS, docHash, LEGACY, normalizeName, rowHash, sameHash, short, tableRows, type VerifyResult } from "./verifiers.ts";
import {
  type AgentStep,
  type Flow,
  type GateStep,
  type Step,
  durationMs,
  isAgent,
  isGate,
  isOutlet,
  isParallel,
  isVerify,
  isWait,
  type Outlet,
  type OutletStep,
  type ParallelStep,
  type VerifyStep,
} from "./flow-schema.ts";
import { isApproval, mayAnswer, mention, type People } from "./gates.ts";
import type { ApprovalCard, ApprovalOutcome, Chat, InboundMessage, Outlets, RoomDocument } from "./ports.ts";
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
  // How long an outlet may take. Past it, nobody knows whether the action
  // happened, so the case goes to a person as in doubt (default 60 s).
  outletTimeoutMs?: number;
  people?: People;
  // Agent handle -> model vendor, shown on approval cards as evidence.
  vendors?: Record<string, string>;
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
  private readonly vendors: Record<string, string>;
  // Outlets running right now in this process: not in doubt, just slow.
  private readonly inFlight = new Set<string>();
  private readonly outletTimeoutMs: number;
  // "room/doc" of every document a code check reads or a flow writes. Their
  // rows are attested: a check on one passes only if the row is what
  // Switchyard last wrote or first saw, so an edit made in the room directly
  // (an insider, or a stolen account) cannot pass a check.
  private readonly guarded = new Set<string>();

  constructor(store: Store, chat: Chat, outlets: Outlets, flows: Flow[], options: RunnerOptions = {}) {
    this.store = store;
    this.chat = chat;
    this.outlets = outlets;
    this.flows = new Map(flows.map((flow) => [flow.flow, flow]));
    this.now = options.now ?? Date.now;
    this.people = options.people ?? {};
    this.vendors = options.vendors ?? {};
    this.outletTimeoutMs = options.outletTimeoutMs ?? 60_000;
    for (const flow of flows) {
      for (const step of flow.steps) {
        if (isOutlet(step) && "document" in step.outlet) this.guarded.add(`${step.outlet.document.room}/${step.outlet.document.name}`);
        if (isVerify(step) && typeof step.verify.doc === "string" && !step.verify.doc.includes("{")) this.guarded.add(`${flow.room}/${step.verify.doc}`);
      }
    }

    // Every way into the engine runs one call at a time. A reply, an approval
    // and the timer can arrive together; each must see the state the previous
    // one left, or two of them act on the same snapshot (two answers to one
    // card, a failover on a step that has just been answered).
    for (const name of ["open", "onMessage", "onApproval", "cancel", "resumeAll", "resume", "reassign", "tick"] as const) {
      const run = (this[name] as (...args: unknown[]) => Promise<unknown>).bind(this);
      (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => this.serial(() => run(...args));
    }
  }

  private queue: Promise<unknown> = Promise.resolve();
  private readonly inside = new AsyncLocalStorage<true>();

  // A call made from inside a running call (an adapter that delivers a reply
  // before returning) runs at once instead of waiting on itself.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inside.getStore()) return fn();
    const result = this.queue.then(() => this.inside.run(true, fn));
    this.queue = result.catch(() => undefined);
    return result;
  }

  flowNames(): string[] {
    return [...this.flows.keys()];
  }

  // With a `key`, a delivery that was already seen returns its case instead
  // of opening another (a redelivered webhook must not pay an invoice twice).
  async open(flowName: string, data: Record<string, unknown>, source: string, key?: string): Promise<string> {
    const flow = this.flows.get(flowName);
    if (!flow) throw new Error(`no flow named "${flowName}"`);
    const seen = key ? this.store.caseWithKey(flow.flow, key) : undefined;
    if (seen) return seen;
    const once = onceKey(flow, data);
    const same = once ? this.store.caseWithOnce(flow.flow, once) : undefined;
    if (same) {
      const earlier = this.store.load(same);
      await this.chat.post(flow.room, `${source} sent ${flow.once_per!.map((f) => String(data[f.slice(5)])).join(" ")} again; it is case ${same} already, so it was not opened twice.`, earlier.threadId);
      return same;
    }

    const id = randomUUID().slice(0, 8);
    this.store.append(id, { type: "opened", flow: flow.flow, room: flow.room, data, source, ...(key ? { key } : {}), ...(once ? { once } : {}) });
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
    if (isParallel(step)) {
      this.store.append(state.id, { type: "fanned_out", step: step.id, agents: step.parallel, at: this.now() });
      for (const agent of step.parallel) await this.ask(state, step, agent, 1, 1);
      return true;
    }
    if (isVerify(step)) {
      await this.verify(state, step);
      return this.store.load(state.id).status !== "open";
    }
    if (isWait(step)) {
      const until = this.now() + durationMs(step.wait);
      this.store.append(state.id, { type: "waiting", step: step.id, until, at: this.now() });
      await this.say(state, `Waiting ${step.wait} before the next step (until ${new Date(until).toUTCString()}).`);
      return true;
    }
    if (isOutlet(step)) {
      const payload = renderOutlet(step.outlet, scopeOf(state));
      const hash = hashOutlet(payload);
      const rule = step.auto_approve;
      const autoApproved = rule === true || (typeof rule === "string" && Boolean(compile(rule)(scopeOf(state))));
      if (!autoApproved) {
        const approval = state.approved[step.id];
        if (!approval || !sameHash(approval.hash, hash, LEGACY.action)) {
          const reason = approval
            ? `the action changed after it was approved (${approval.hash} approved, ${hash} now)`
            : "nobody approved it";
          this.store.append(state.id, { type: "failed", step: step.id, reason });
          await this.say(state, `Stopped before "${step.id}": ${reason}. Nothing was sent.`);
          return true;
        }
      }

      const key = `${state.id}/${step.id}`;
      // Already running in this process (a second advance arrived mid-send).
      if (this.inFlight.has(key)) return true;

      // The approval (or the rule) rested on the room documents the checks
      // read. If one changed since, nothing is sent on the old facts: the
      // checks run again on the new version, and so does every later step.
      const MAX_REWINDS = 3;
      if (state.executing[step.id] && safeToRepeat(payload) && (await this.basisDrift(state))) {
        // It may already have happened on the old facts; repeating it on
        // the new ones could do something nobody approved. A person decides.
        await this.openDoubt(state, step, hash, payload, "the room documents its checks read changed while it was in flight");
        return true;
      }
      if (!state.executing[step.id]) {
        const drift = await this.basisDrift(state);
        if (drift && drift !== "unreadable" && this.store.events(state.id).filter((e) => e.type === "rewound").length >= MAX_REWINDS) {
          const reason = `the room documents kept changing (${MAX_REWINDS} re-checks); a person needs to take this case`;
          this.store.append(state.id, { type: "failed", step: step.id, reason });
          await this.say(state, `Stopped before "${step.id}": ${reason}. Nothing was sent.`);
          return true;
        }
        if (drift === "unreadable") {
          const reason = "could not re-read the room's documents before acting";
          this.store.append(state.id, { type: "failed", step: step.id, reason });
          await this.say(state, `Stopped before "${step.id}": ${reason}. Nothing was sent.`);
          return true;
        }
        if (drift) {
          await this.rewind(state, step, drift);
          return false;
        }
      }
      if (state.executing[step.id] && !safeToRepeat(payload)) {
        // A previous run started this action and stopped before recording the
        // result. Repeating it could send the email twice; skipping it could
        // lose it. A person decides.
        await this.openDoubt(state, step, hash, payload);
        return true;
      }

      this.inFlight.add(key);
      let result: Awaited<ReturnType<Outlets["execute"]>>;
      try {
        this.store.append(state.id, { type: "executing", step: step.id, hash, payload });
        result = await withTimeout(this.outlets.execute(payload, key), this.outletTimeoutMs, "the action did not finish in time");
      } catch (error) {
        this.inFlight.delete(key);
        if (error instanceof Error && "refused" in error) {
          // Certainly not done: say so, and stop for a person.
          const reason = `${error.message}; nothing was sent`;
          this.store.append(state.id, { type: "failed", step: step.id, reason });
          await this.say(state, `Stopped at "${step.id}": ${reason}.`);
          return true;
        }
        // A failed send may still have reached the other side (a timeout
        // after the server accepted it), so a person checks, as after a crash.
        await this.openDoubt(this.store.load(state.id), step, hash, payload, (error as Error).message);
        return true;
      }
      const receipt = typeof result === "string" ? result : result.receipt;
      const readback = typeof result === "string" ? undefined : result.readback;
      if (readback !== undefined && readback !== hash) {
        // The other system holds something other than what was approved.
        this.inFlight.delete(key);
        await this.openDoubt(this.store.load(state.id), step, hash, payload, `read back ${short(readback)}, approved ${short(hash)}`);
        return true;
      }
      this.store.append(state.id, { type: "executed", step: step.id, hash, receipt, payload, ...(readback ? { readback } : {}) });
      this.attestWrite(state, payload);
      this.inFlight.delete(key);
      const by = autoApproved ? `rule "${rule === true ? "always" : rule}"` : state.approved[step.id].by;
      await this.say(state, `Done: ${receipt} (approved by ${by}, ${short(hash)})`);
      return false;
    }
    return false;
  }

  private async ask(
    state: CaseState,
    step: AgentStep | ParallelStep,
    agent: string,
    attempt: number,
    tries: number,
    correction?: string,
  ) {
    const parallel = isParallel(step);
    // Agents working the same step in parallel each get their own token.
    const token = stepToken(state.id, parallel ? `${step.id}.${agent.slice(1)}` : step.id, attempt);
    const docs = await this.documentHashes(state);
    this.store.append(state.id, { type: "asked", step: step.id, agent, token, attempt, tries, at: this.now(), parallel, ...(docs ? { docs } : {}) });
    const body = stepRequest({
      ask: step.ask,
      expect: step.expect,
      token,
      untrusted: state.data,
      context: state.results,
      correction,
    });
    await this.chat.sendTargeted(state.room, agent, body, state.threadId!);
  }

  // Which version of each room document the agents are working from. A
  // read failure is recorded, not fatal: the agent itself then fails to read
  // the documents and the step moves on to its backup, then to a person.
  private async documentHashes(state: CaseState): Promise<Record<string, string> | undefined> {
    if (!this.chat.documents) return undefined;
    try {
      const docs = await this.chat.documents(state.room);
      return Object.fromEntries(docs.map((d) => [d.name, docHash(d.content)]));
    } catch {
      return { "(unreadable)": "" };
    }
  }

  private async verify(state: CaseState, step: VerifyStep): Promise<void> {
    const { check, ...rawArgs } = step.verify;
    const spec = CHECKS[check];
    let docs: RoomDocument[] = [];
    if (spec.needsDoc) {
      try {
        if (!this.chat.documents) throw new Error("this Switch connection cannot read room documents");
        docs = await this.chat.documents(state.room);
      } catch (error) {
        // Fail closed: without the rules, nothing is decided automatically.
        const reason = `could not read the room's documents (${(error as Error).message})`;
        this.store.append(state.id, { type: "failed", step: step.id, reason });
        await this.say(state, `Stopped at "${step.id}": ${reason}. A person needs to take this case.`);
        return;
      }
    }
    const args = renderArgs(rawArgs, scopeOf(state));
    const used = typeof args.doc === "string" ? docs.filter((d) => d.name === args.doc) : [];
    let value =
      used.length > 1
        ? { ok: false, detail: `${used.length} documents in this room are named "${String(args.doc)}"; a person must remove the extra one` }
        : spec.run(args, docs, this.now());
    const rows = used.length === 1 ? value.rows : undefined;
    const key = rows?.[used[0]?.name];
    if (key !== undefined && this.guarded.has(`${state.room}/${used[0].name}`)) {
      value = this.checkAttested(state.room, used[0], key, value);
    }
    this.store.append(state.id, {
      type: "verified",
      step: step.id,
      check,
      value,
      ...(used.length === 1 ? { docs: { [used[0].name]: basisHash(used[0].content, rows?.[used[0].name]) } } : {}),
      ...(rows ? { rows } : {}),
    });
    await this.say(state, `${value.ok ? "✓" : "✗"} Checked by code (${check}): ${value.detail}`);
  }

  // A result resting on a row nobody wrote through Switchyard does not pass,
  // whatever the row says: it was edited in the room directly (an insider,
  // or a stolen account), and only a case may change it.
  private checkAttested(room: string, doc: RoomDocument, key: string, value: VerifyResult): VerifyResult {
    const current = rowHash(doc.content, key);
    if (current === "") return value;
    const known = this.store.attestation(room, doc.name, key);
    if (known?.hash === current) return { ...value, attested: true };
    const why = known
      ? `${key}'s row in ${doc.name} is not what Switchyard last wrote there (${known.by}): it was changed in the room directly`
      : this.store.attestedRows(room, doc.name) === 0
        ? `${doc.name} has never been attested (Switchyard attests a room's documents when it starts)`
        : `${key}'s row in ${doc.name} was added in the room directly, not by a case`;
    return { ...value, ok: false, attested: false, detail: `${why}, so nothing is paid on it until a person restores it or a case rewrites it; ${value.detail}` };
  }

  // After a person says a document write went out: attested only if the room
  // now holds exactly the row that was approved.
  private async attestIfWritten(state: CaseState, payload: Outlet): Promise<void> {
    if (!("document" in payload) || !this.chat.documents) return;
    const { room, name, row } = payload.document;
    const doc = (await this.chat.documents(room)).filter((d) => d.name === name);
    if (doc.length === 1 && rowHash(doc[0].content, row[0]) === rowHash(`| ${row.join(" | ")} |`, row[0])) this.attestWrite(state, payload);
  }

  // Records what a document outlet wrote, so the next check accepts it.
  private attestWrite(state: CaseState, payload: Outlet): void {
    if (!("document" in payload)) return;
    const { room, name, row } = payload.document;
    this.store.attest(room, name, row[0], rowHash(`| ${row.join(" | ")} |`, row[0]), `case ${state.id}`, new Date(this.now()));
  }

  // At start (`switchyard up`), and only then: a document Switchyard has
  // never attested is adopted as it stands, and the room is told. A check
  // never adopts: a row with no attestation does not pass.
  async attestRows(): Promise<string[]> {
    if (!this.chat.documents) return [];
    const adopted: string[] = [];
    for (const guarded of this.guarded) {
      const [room, name] = guarded.split("/");
      const docs = (await this.chat.documents(room)).filter((d) => d.name === name);
      if (docs.length === 1 && this.store.attestedRows(room, name) === 0) {
        const rows = this.adopt(room, docs[0], "first seen at start");
        adopted.push(`#${room}/${name}`);
        // Said in the room, so whoever reads it can check the baseline.
        await this.chat.post(room, `Attested ${rows.length} row${rows.length === 1 ? "" : "s"} of ${name} as they stand now (${rows.join(", ")}). From now on a row changed outside a case does not pass a check.`);
      }
    }
    return adopted;
  }

  private adopt(room: string, doc: RoomDocument, by: string): string[] {
    const keys = tableRows(doc.content).map(([key]) => key).filter(Boolean);
    for (const key of keys) this.store.attest(room, doc.name, key, rowHash(doc.content, key), by, new Date(this.now()));
    return keys;
  }

  private async openGate(state: CaseState, step: GateStep): Promise<void> {
    const scope = scopeOf(state);
    const hashes: Record<string, string> = {};
    const payloads: Record<string, unknown> = {};
    for (const target of step.gate.approves) {
      const outlet = this.flowOf(state).steps.find((s) => s.id === target);
      if (!outlet || !isOutlet(outlet)) continue;
      payloads[target] = renderOutlet(outlet.outlet, scope);
      hashes[target] = hashOutlet(payloads[target] as Outlet);
    }
    // A gate opened again after a rewind needs a new card id (Switch keeps one answer per card).
    const before = this.store.events(state.id).filter((e) => e.type === "gate_opened" && e.step === step.id).length;
    const requestId = before ? `${state.id}-${step.id}-v${before + 1}` : `${state.id}-${step.id}`;
    this.store.append(state.id, {
      type: "gate_opened",
      step: step.id,
      requestId,
      approver: step.gate.approver,
      hashes,
      payloads,
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
      return [`${describeOutlet(payload)}\n(approval ${short(hashOutlet(payload))})`];
    });
    const action = previews.join("\n\n") || "No outside action depends on this answer.";
    const sections = [note, action, this.evidence(state), this.timing(step)].filter(Boolean);
    return {
      requestId,
      room: state.room,
      threadId: state.threadId!,
      title: `${mention(this.people, addressee)} ${render(step.gate.title, scope)}`,
      detail: sections.join("\n\n"),
      options: step.gate.options,
    };
  }

  // What the decision can rest on: checks done by code, and whether the
  // agents that checked independently (on which vendors) agreed.
  private evidence(state: CaseState): string {
    const lines: string[] = [];
    for (const step of this.flowOf(state).steps) {
      const value = state.results[step.id] as Record<string, unknown> | undefined;
      if (!value) continue;
      if (isVerify(step)) lines.push(`${value.ok ? "✓" : "✗"} checked by code (${step.verify.check}): ${String(value.detail)}`);
      if (isParallel(step)) {
        const who = step.parallel.map((a) => `${a}${this.vendors[a] ? ` (${this.vendors[a]})` : ""}`).join(" and ");
        lines.push(`${value.agreed ? "✓" : "✗"} ${who} ${value.agreed ? "agreed" : "did not agree"} on ${step.id}`);
      }
    }
    const versions = Object.entries(state.basis).map(([doc, b]) => `${doc} (${b.row ? `${b.row}'s row` : "whole document"}) ${shortHash(b.hash)}`);
    if (versions.length) lines.push(`Checked against room documents: ${versions.join(", ")}. If one changes before anything is released, the checks run again and this card is replaced.`);
    return lines.length ? `Evidence:\n${lines.join("\n")}` : "";
  }

  // Which documents changed since the checks read them, re-read from Switch.
  private async basisDrift(state: CaseState): Promise<Record<string, [string, string]> | "unreadable" | undefined> {
    const basis = Object.entries(state.basis);
    if (basis.length === 0) return undefined;
    let docs: RoomDocument[];
    try {
      if (!this.chat.documents) throw new Error("no documents");
      docs = await this.chat.documents(state.room);
    } catch {
      return "unreadable";
    }
    const drift: Record<string, [string, string]> = {};
    for (const [name, b] of basis) {
      // This case's own approved write moved it on purpose.
      if (state.wrote.has(name)) continue;
      const same = docs.filter((d) => d.name === name);
      const now = same.length === 1 ? basisHash(same[0].content, b.row) : same.length ? `(${same.length} documents)` : "(deleted)";
      if (!sameHash(b.hash, now, LEGACY.document)) drift[name] = [b.hash, now];
    }
    return Object.keys(drift).length ? drift : undefined;
  }

  private async rewind(state: CaseState, at: OutletStep, drift: Record<string, [string, string]>): Promise<void> {
    const order = this.flowOf(state).steps.map((s) => s.id);
    const first = Math.min(...Object.keys(drift).map((doc) => order.indexOf(state.basis[doc].step)));
    const steps = order.slice(first).filter((id) => state.finished.has(id));
    this.store.append(state.id, { type: "rewound", step: at.id, steps, docs: drift });
    const what = Object.entries(drift).map(([doc, [was, now]]) => `${doc} ${shortHash(was)} → ${shortHash(now)}`).join(", ");
    await this.say(state, `Not sending "${at.id}": a document the checks read changed after they ran (${what}). Checking again on the new version; any approval given on the old one no longer counts.`);
  }

  private timing(step: GateStep): string {
    if (!step.gate.deadline) return "";
    const deadline = `${new Date(this.now() + durationMs(step.gate.deadline)).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    return `Decide by ${deadline}${step.gate.backup ? `; after that ${mention(this.people, step.gate.backup)} can decide` : ""}.`;
  }

  async onMessage(message: InboundMessage): Promise<void> {
    const state = this.store
      .openCases()
      .find((c) => c.threadId !== undefined && c.threadId === message.threadId);
    const pending = state?.pending;
    // An agent step is answered by an agent. A person typing the reply in the
    // thread (with a token copied from the request) would be both the source
    // of the facts and, later, the one confirming them.
    if (message.fromPerson && (pending?.kind === "agent" || pending?.kind === "parallel")) return;
    if (state && pending?.kind === "parallel") {
      await this.onParallelReply(state, message);
      return;
    }
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

  private async onParallelReply(state: CaseState, message: InboundMessage): Promise<void> {
    const pending = state.pending;
    if (pending?.kind !== "parallel") return;
    const mine = pending.agents[message.sender];
    const step = this.stepOf(state, pending.step);
    if (!mine || mine.value !== undefined || !step || !isParallel(step)) return;

    const reply = readReply(message.body, step.expect);
    if (reply.token !== undefined && reply.token !== mine.token) return;

    if (!reply.ok) {
      this.store.append(state.id, { type: "reply_rejected", step: step.id, error: `${message.sender}: ${reply.error}` });
      if (PROVIDER_FAILURE.test(message.body)) {
        await this.unavailable(state, step, message.sender, "its provider reported an error");
      } else if (mine.tries < MAX_TRIES) {
        await this.ask(state, step, message.sender, mine.attempt + 1, mine.tries + 1, reply.error);
      } else {
        await this.unavailable(state, step, message.sender, `its replies did not match the step's contract (${reply.error})`);
      }
      return;
    }

    this.store.append(state.id, { type: "partial", step: step.id, agent: message.sender, value: reply.value });
    await this.finishParallel(state.id, step);
  }

  // A checker that cannot answer does not stop the case. Its answer is
  // recorded as unavailable, the step counts as not agreed, and the flow's
  // own rule (typically `when: match.agreed == false`) hands it to a person.
  private async unavailable(state: CaseState, step: ParallelStep, agent: string, reason: string): Promise<void> {
    this.store.append(state.id, { type: "partial", step: step.id, agent, value: { unavailable: true, reason } });
    await this.say(state, `${agent} could not check "${step.id}" (${reason}); the other answers go ahead without it.`);
    await this.finishParallel(state.id, step);
  }

  private async finishParallel(caseId: string, step: ParallelStep): Promise<void> {
    const pending = this.store.load(caseId).pending;
    if (pending?.kind !== "parallel" || pending.step !== step.id) return;
    const answers = Object.fromEntries(Object.entries(pending.agents).map(([a, s]) => [a, s.value]));
    if (Object.values(answers).some((value) => value === undefined)) return;
    this.store.append(caseId, { type: "answered", step: step.id, value: combine(step, answers) });
    await this.advance(caseId);
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
    const doubtful = this.store
      .openCases()
      .find((c) => c.pending?.kind === "in_doubt" && c.pending.requestIds.includes(outcome.requestId));
    if (doubtful) {
      await this.resolveDoubt(doubtful, outcome);
      return;
    }
    const state = this.store
      .openCases()
      .find((c) => c.pending?.kind === "gate" && c.pending.requestIds.includes(outcome.requestId));
    const pending = state?.pending;
    if (!state || pending?.kind !== "gate") return;

    const step = this.stepOf(state, pending.step);
    if (!step || !isGate(step)) return;

    const answerer = await this.chat.handleOf(outcome.answeredBy);
    const sameAs = step.gate.not_same_as
      .map((other) => this.store.events(state.id).findLast((e) => e.type === "gate_answered" && e.step === other))
      .find((e) => e?.type === "gate_answered" && e.answeredBy === answerer);
    if (sameAs && sameAs.type === "gate_answered") {
      await this.say(state, `${answerer} answered "${sameAs.step}", so a different person must decide "${step.id}".`);
      const requestId = `${pending.requestIds[0]}-r${pending.requestIds.length}`;
      this.store.append(state.id, { type: "card_reopened", step: step.id, requestId });
      await this.chat.openApproval(this.gateCard(state, step, requestId, step.gate.approver, `Re-opened: ${answerer} answered "${sameAs.step}"; four eyes means someone else decides this.`));
      return;
    }
    if (!mayAnswer(step.gate, answerer, pending.escalated, this.people)) {
      const deciders = pending.escalated && step.gate.backup
        ? `${step.gate.approver} or ${step.gate.backup}`
        : step.gate.approver;
      await this.say(state, `${answerer ?? "That answer"} cannot decide "${step.id}"; it is for ${deciders}.`);
      // Switch keeps one answer per card, so a re-opened card is a new request.
      const requestId = `${pending.requestIds[0]}-r${pending.requestIds.length}`;
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

  // After a restart: carries on every open case that is not waiting on
  // someone, which is where a crash between two steps leaves a case.
  async resumeAll(): Promise<void> {
    for (const state of this.store.openCases()) {
      if (!state.pending) await this.advance(state.id);
    }
  }

  private async openDoubt(state: CaseState, step: OutletStep, hash: string, payload: Outlet, error?: string): Promise<void> {
    const earlier = this.store.events(state.id).filter((e) => e.type === "in_doubt" && e.step === step.id).length;
    const requestId = `${state.id}-${step.id}-doubt${earlier ? `-v${earlier + 1}` : ""}`;
    const approver = this.approverOf(state, step.id);
    const why = error ? `"${step.id}" failed (${error}), and it may still have reached the other side.` : `Switchyard stopped while doing "${step.id}" and can't tell whether it happened.`;
    // The card goes out before the case is marked in doubt: if the process
    // stops in between, the restart finds no doubt yet and simply asks again.
    await this.chat.openApproval(this.doubtCard(state, step.id, requestId, hash, payload));
    this.store.append(state.id, { type: "in_doubt", step: step.id, requestId, hash, at: this.now() });
    await this.say(state, `${why} ${mention(this.people, approver ?? "@yard")} please check.`);
  }

  private doubtCard(state: CaseState, stepId: string, requestId: string, hash: string, payload: Outlet, note?: string): ApprovalCard {
    const approver = this.approverOf(state, stepId);
    const detail = `${describeOutlet(payload)}\n(approval ${short(hash)})\n\nCheck the recipient's side before answering. "send it again" repeats exactly this action.`;
    return {
      requestId,
      room: state.room,
      threadId: state.threadId!,
      title: `${approver ? mention(this.people, approver) + " " : ""}did "${stepId}" go out?`,
      detail: note ? `${note}\n\n${detail}` : detail,
      options: [DOUBT_SENT, DOUBT_RESEND],
    };
  }

  private async resolveDoubt(state: CaseState, outcome: ApprovalOutcome): Promise<void> {
    const pending = state.pending;
    if (pending?.kind !== "in_doubt") return;
    const step = this.stepOf(state, pending.step);
    if (!step || !isOutlet(step)) return;

    const answerer = await this.chat.handleOf(outcome.answeredBy);
    const approver = this.approverOf(state, step.id);
    const allowed = answerer !== undefined && (!approver || mayAnswer({ approver, title: "", options: ["x", "y"], approves: [], not_same_as: [] }, answerer, false, this.people));
    if (!allowed) {
      await this.say(state, `${answerer ?? "That answer"} cannot decide this; it is for ${approver}.`);
      // Switch keeps one answer per card, so asking again needs a new card.
      const requestId = `${pending.requestIds[0]}-r${pending.requestIds.length}`;
      this.store.append(state.id, { type: "card_reopened", step: step.id, requestId });
      const { hash, payload } = state.executing[step.id];
      await this.chat.openApproval(this.doubtCard(state, step.id, requestId, hash, payload as Outlet, `Re-opened: only ${approver} can decide this.`));
      return;
    }

    this.store.append(state.id, { type: "doubt_resolved", step: step.id, answer: outcome.answer, answeredBy: answerer! });
    const { hash, payload } = state.executing[step.id];
    if (outcome.answer === DOUBT_SENT && this.outlets.lookup && "pay" in (payload as Outlet)) {
      // A person's word that a payment went out is checked with the bank.
      let held: Awaited<ReturnType<NonNullable<Outlets["lookup"]>>>;
      try {
        held = await this.outlets.lookup(payload as Outlet, `${state.id}/${step.id}`);
      } catch (error) {
        await this.openDoubt(this.store.load(state.id), step, hash, payload as Outlet, `could not ask the bank (${(error as Error).message})`);
        return;
      }
      if (!held || typeof held === "string" || held.readback === undefined || !sameHash(hash, held.readback, LEGACY.action)) {
        const reason = !held
          ? `${answerer} said it went out, but the bank holds no payment under ${state.id}/${step.id}`
          : `${answerer} said it went out, but the bank holds a different payment under that key (read back ${typeof held === "string" || !held.readback ? "?" : short(held.readback)}, approved ${short(hash)})`;
        await this.openDoubt(this.store.load(state.id), step, hash, payload as Outlet, reason);
        return;
      }
      this.store.append(state.id, { type: "executed", step: step.id, hash, payload, receipt: `${held.receipt} (confirmed with the bank after ${answerer} said it went out)`, readback: held.readback });
    } else if (outcome.answer === DOUBT_SENT) {
      this.store.append(state.id, { type: "executed", step: step.id, hash, payload, receipt: `confirmed sent by ${answerer}` });
      await this.attestIfWritten(state, payload as Outlet);
    } else {
      let result: Awaited<ReturnType<Outlets["execute"]>>;
      try {
        result = await withTimeout(this.outlets.execute(payload as Outlet, `${state.id}/${step.id}`), this.outletTimeoutMs, "the action did not finish in time");
      } catch (error) {
        await this.openDoubt(this.store.load(state.id), step, hash, payload as Outlet, (error as Error).message);
        return;
      }
      const receipt = typeof result === "string" ? result : result.receipt;
      const readback = typeof result === "string" ? undefined : result.readback;
      if (readback !== undefined && !sameHash(hash, readback, LEGACY.action)) {
        await this.openDoubt(this.store.load(state.id), step, hash, payload as Outlet, `read back ${short(readback)}, approved ${short(hash)}`);
        return;
      }
      this.store.append(state.id, { type: "executed", step: step.id, hash, payload, receipt: `${receipt} (resent by ${answerer})`, ...(readback ? { readback } : {}) });
      this.attestWrite(state, payload as Outlet);
    }
    await this.advance(state.id);
  }

  // The person whose gate approved this outlet, if one did.
  private approverOf(state: CaseState, outletId: string): string | undefined {
    const gate = this.flowOf(state).steps.find((s) => isGate(s) && s.gate.approves.includes(outletId));
    return gate && isGate(gate) ? gate.gate.approver : undefined;
  }

  // Ends a wait step early, on a person's word.
  async resume(caseId: string, by: string): Promise<string | undefined> {
    const state = this.store.load(caseId);
    if (state.status !== "open" || state.pending?.kind !== "wait") return "that case is not waiting";
    this.store.append(caseId, { type: "waited", step: state.pending.step, by });
    await this.say(state, `${by} ended the wait early.`);
    await this.advance(caseId);
    return undefined;
  }

  // Moves a waiting agent step to another agent, on a person's word.
  async reassign(caseId: string, to: string, by: string): Promise<string | undefined> {
    const state = this.store.load(caseId);
    const pending = state.pending;
    if (state.status !== "open" || pending?.kind !== "agent") return "that case is not waiting on an agent";
    const step = this.stepOf(state, pending.step);
    if (!step || !isAgent(step)) return "that step is not an agent step";
    const agents = this.agentsOf(this.flowOf(state));
    if (!agents.has(to)) return `${to} is not one of this flow's agents (${[...agents].join(", ")}); a person cannot take an agent's step`;

    this.store.append(caseId, { type: "failed_over", step: step.id, from: pending.agent, to, reason: `reassigned by ${by}` });
    await this.say(state, `${by} moved "${step.id}" from ${pending.agent} to ${to}.`);
    await this.ask(state, step, to, pending.attempt + 1, 1);
    return undefined;
  }

  // The agents a flow names, and those running beside it.
  private agentsOf(flow: Flow): Set<string> {
    const agents = new Set(Object.keys(this.vendors).map((a) => a.toLowerCase()));
    for (const step of flow.steps) {
      if (isAgent(step)) {
        agents.add(step.agent.toLowerCase());
        if (step.bench) agents.add(step.bench.toLowerCase());
      }
      if (isParallel(step)) for (const a of step.parallel) agents.add(a.toLowerCase());
    }
    return agents;
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

      if (pending.kind === "wait") {
        if (now >= pending.until) {
          this.store.append(state.id, { type: "waited", step: pending.step });
          await this.advance(state.id);
        }
        continue;
      }

      if (pending.kind === "parallel" && step && isParallel(step) && step.sla) {
        if (now - pending.at >= durationMs(step.sla)) {
          const missing = Object.entries(pending.agents).filter(([, s]) => s.value === undefined).map(([a]) => a);
          for (const agent of missing) await this.unavailable(this.store.load(state.id), step, agent, `no answer within ${step.sla}`);
        }
        continue;
      }

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
        const requestId = `${pending.requestIds[0]}-escalated`;
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

const DOUBT_SENT = "it went out";
const DOUBT_RESEND = "send it again";

// Outlets whose receiver ignores a repeat with the same key, so finishing an
// interrupted one is safe: ledger rows carry the key, visitor replies too.
// Repeating these cannot do the action twice: csv and visitor replies are
// keyed, a document row is set (not appended), and the bank takes each
// payment key once.
function safeToRepeat(outlet: Outlet): boolean {
  return "csv" in outlet || "visitor" in outlet || "document" in outlet || "pay" in outlet;
}

// Fills a verify step's args. A value that is only a placeholder keeps the
// type of what it names (a list of quote lines stays a list).
function renderArgs(args: Record<string, unknown>, scope: Scope): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (typeof v !== "string") return [k, v];
      const whole = /^\{([A-Za-z_][\w.-]*)\}$/.exec(v);
      return [k, whole ? lookup(scope, whole[1].split(".")) : render(v, scope)];
    }),
  );
}

// One result from several agents: each answer under the agent's name (so
// `review.rev-claude.verdict` works), and `agreed` when every agent gave the
// same value for every enum field.
export function combine(step: ParallelStep, answers: Record<string, unknown>): Record<string, unknown> {
  const values = Object.values(answers) as Record<string, unknown>[];
  // Agreement means the same decision and the same figures: two checkers who
  // both say "match" but read different amounts did not agree.
  const compared = Object.entries(step.expect)
    .filter(([, type]) => Array.isArray(type) || type === "number" || type === "number?")
    .map(([name]) => name);
  // Figures must match to the cent; rounding hides float noise, not differences.
  const same = (a: unknown, b: unknown) =>
    typeof a === "number" && typeof b === "number" ? Math.round(a * 100) === Math.round(b * 100) : a === b;
  const agreed =
    values.every((v) => !v.unavailable) && compared.every((field) => values.every((v) => same(v[field], values[0][field])));
  return {
    ...Object.fromEntries(Object.entries(answers).map(([agent, value]) => [agent.slice(1), value])),
    agreed,
  };
}

// What `when:` conditions and `{placeholders}` can see: the case data under
// `case`, and each finished step's result under its id.
export function scopeOf(state: CaseState): Scope {
  return { case: state.data, ...state.results, by: state.deciders, this: { id: state.id } };
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// The business key of a case, or undefined when the flow has none or a field
// is missing (an empty key would make unrelated cases duplicates).
function onceKey(flow: Flow, data: Record<string, unknown>): string | undefined {
  if (!flow.once_per?.length) return undefined;
  // "FP-0912" and "FP 0912", "Fabrikam-Print" and "Fabrikam Print" are one invoice.
  const values = flow.once_per.map((f) => normalizeName(String(data[f.slice(5)] ?? "")));
  return values.every((v) => v !== "") ? JSON.stringify(values) : undefined;
}

// Row hashes are stored as "row:<hash>"; people read just the hash.
const shortHash = (h: string) => short(h).replace(/^row:/, "").slice(0, 12);
