import type { Flow, Step } from "../engine/flow-schema.ts";
import { durationMs, isAgent, isGate, isOutlet, isParallel, isVerify, isWait } from "../engine/flow-schema.ts";
import type { CaseEvent, CaseState, Store } from "../engine/store.ts";
import { nextRuns } from "../inlets/schedule.ts";

// What the dashboard reads. Every value here is derived from the flow files
// and the event log; the page only draws it.

export interface Extras {
  // Agent handle -> model vendor, for agents Switchyard runs itself.
  vendors?: Record<string, string>;
  // Role -> the people who fill it (switchyard.yaml `people:`).
  people?: Record<string, string[]>;
}

type Kind = "agent" | "parallel" | "gate" | "wait" | "outlet" | "verify";

function kindOf(step: Step): Kind {
  return isAgent(step) ? "agent" : isParallel(step) ? "parallel" : isGate(step) ? "gate" : isWait(step) ? "wait" : isVerify(step) ? "verify" : "outlet";
}

export function flowSummaries(flows: Flow[], running: Set<string> = new Set(flows.map((f) => f.flow))) {
  return flows.map((flow) => ({
    flow: flow.flow,
    running: running.has(flow.flow),
    room: flow.room,
    description: flow.description ?? flow.flow,
    inlets: Object.entries(flow.inlet ?? {}).map(([kind, spec]) => ({ kind, spec })),
    steps: flow.steps.map((step) => ({
      id: step.id,
      label: step.id.replace(/_/g, " "),
      kind: kindOf(step),
      who: isAgent(step) ? step.agent : isGate(step) ? step.gate.approver : isWait(step) ? step.wait : isOutlet(step) ? Object.keys(step.outlet)[0] : isVerify(step) ? `code: ${step.verify.check}` : undefined,
      agents: isParallel(step) ? step.parallel : isAgent(step) ? [step.agent] : undefined,
      backup: isAgent(step) ? step.bench : isGate(step) ? step.gate.backup : undefined,
      when: step.when,
      autoRule: isOutlet(step) && step.auto_approve !== false ? step.auto_approve : undefined,
      sla: isAgent(step) || isParallel(step) ? step.sla : undefined,
      deadline: isGate(step) ? step.gate.deadline : undefined,
      approves: isGate(step) ? step.gate.approves : undefined,
      options: isGate(step) ? step.gate.options : undefined,
    })),
  }));
}

export function caseSummaries(store: Store, flows: Flow[]) {
  const byName = new Map(flows.map((f) => [f.flow, f]));
  return store.caseIds().map((id) => {
    const state = store.load(id);
    const timeline = store.timeline(id);
    const opened = timeline[0];
    const flow = byName.get(state.flow);
    return {
      id,
      flow: state.flow,
      title: titleOf(state),
      excerpt: typeof state.data.question === "string" ? state.data.question : undefined,
      source: opened?.type === "opened" ? (opened.source ?? "") : "",
      status: state.status,
      outcome: outcomeOf(state, timeline, flow),
      waiting: waitingOn(state, flow),
      openedAt: opened?.at_iso,
      updatedAt: timeline.at(-1)?.at_iso,
      stations: stations(state, flow),
      data: state.data,
      events: timeline,
    };
  });
}

// A short human title from whatever the inlet brought in. Outside text that
// is free-form (a visitor's question) never becomes the headline: it is shown
// as a quoted excerpt instead.
function titleOf(state: CaseState): string {
  const d = state.data;
  if (typeof d.question === "string") return d.flagged ? "Visitor question · flagged" : "Visitor question";
  if (state.flow === "weekly-report" || (typeof d.period === "string" && Object.keys(d).length <= 2)) {
    return `Sales report · ${String(d.period ?? "").replace(/-/g, " ")}`;
  }
  const pick = (...keys: string[]) => keys.map((k) => d[k]).find((v) => typeof v === "string" || typeof v === "number");
  const who = pick("name", "from_name", "from", "supplier", "client");
  const what = pick("subject", "category", "number", "period", "role");
  const amount = typeof d.amount === "number" ? ` · ${d.amount.toLocaleString("en")}` : "";
  const text = [who, what].filter(Boolean).map(String).join(" — ");
  const short = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  return (short || state.flow) + amount;
}

const DECLINED: Record<string, string> = {
  dispute: "Disputed",
  reject: "Rejected",
  hold: "On hold",
  stop: "Stopped",
  change: "Changes requested",
  "handle-myself": "Handled by staff",
};

const DONE_BY_OUTLET: Record<string, string> = {
  email: "Sent",
  csv: "Recorded",
  visitor: "Answered",
  post: "Posted",
  webhook: "Delivered",
};

// What a finished case came to, in one word a person would use.
function outcomeOf(state: CaseState, events: CaseEvent[], flow: Flow | undefined): { label: string; tone: "act" | "stop" | "person" | "agent" | "neutral" } {
  if (state.status === "cancelled") return { label: "Cancelled", tone: "stop" };
  if (state.status === "failed") return { label: "Stopped", tone: "stop" };
  if (state.status === "open") {
    const p = state.pending;
    if (p?.kind === "in_doubt") return { label: "In doubt", tone: "stop" };
    if (p?.kind === "gate") return { label: p.escalated ? "Escalated" : "Needs a person", tone: "person" };
    if (p?.kind === "wait") return { label: "Scheduled", tone: "neutral" };
    return { label: "Agents working", tone: "agent" };
  }
  const executed = events.filter((e) => e.type === "executed");
  const declined = events.find((e) => e.type === "gate_answered" && !e.approved);
  if (executed.length > 0) {
    const last = executed.at(-1)!;
    const step = last.type === "executed" ? flow?.steps.find((s) => s.id === last.step) : undefined;
    const kind = step && isOutlet(step) ? Object.keys(step.outlet)[0] : "";
    return { label: DONE_BY_OUTLET[kind] ?? "Done", tone: "act" };
  }
  if (declined && declined.type === "gate_answered") {
    return { label: DECLINED[declined.answer] ?? `Declined (${declined.answer})`, tone: "stop" };
  }
  // No outside action and nobody declined: an agent's verdict ended it.
  const verdict = events
    .filter((e) => e.type === "answered")
    .map((e) => (e.type === "answered" && e.value && typeof e.value === "object" ? (e.value as Record<string, unknown>) : {}))
    .map((v) => String(v.verdict ?? v.result ?? ""))
    .find((v) => /reject|mismatch|no_po/.test(v));
  if (verdict) return { label: `Rejected by policy check`, tone: "stop" };
  return { label: "Closed · nothing to do", tone: "neutral" };
}

// What a case is waiting on, with the times the engine will act next.
function waitingOn(state: CaseState, flow: Flow | undefined) {
  const p = state.pending;
  if (!p) return null;
  const step = flow?.steps.find((s) => s.id === p.step);
  if (p.kind === "wait") return { kind: "wait", step: p.step, until: p.until };
  if (p.kind === "agent") {
    const sla = step && isAgent(step) && step.sla ? durationMs(step.sla) : undefined;
    return { kind: "agent", step: p.step, who: p.agent, since: p.at, slaAt: sla ? p.at + sla : undefined, bench: step && isAgent(step) ? step.bench : undefined };
  }
  if (p.kind === "parallel") {
    const sla = step && isParallel(step) && step.sla ? durationMs(step.sla) : undefined;
    const missing = Object.keys(p.agents).filter((a) => p.agents[a].value === undefined);
    return { kind: "agent", step: p.step, who: missing.join(" + "), since: p.at, slaAt: sla ? p.at + sla : undefined };
  }
  if (p.kind === "in_doubt") return { kind: "person", step: p.step, since: p.at, doubt: true };
  const deadline = step && isGate(step) && step.gate.deadline ? durationMs(step.gate.deadline) : undefined;
  return {
    kind: "person",
    step: p.step,
    approver: step && isGate(step) ? step.gate.approver : undefined,
    since: p.at,
    escalated: p.escalated,
    remindAt: deadline ? p.at + deadline / 2 : undefined,
    deadlineAt: deadline ? p.at + deadline : undefined,
    escalateTo: step && isGate(step) ? step.gate.backup : undefined,
  };
}

// Each flow step as a station on the case's track.
function stations(state: CaseState, flow: Flow | undefined) {
  if (!flow) return [];
  return flow.steps
    .map((step) => {
      let status: "done" | "skipped" | "current" | "todo" | "stopped" = "todo";
      if (state.pending?.step === step.id) status = "current";
      else if (state.finished.has(step.id)) status = step.id in state.results ? "done" : "skipped";
      return { id: step.id, kind: kindOf(step), status };
    })
    .map((station, i, all) => {
      // Where a failed or cancelled case stopped: the first station not reached.
      if ((state.status === "failed" || state.status === "cancelled") && station.status === "todo" &&
          all.slice(0, i).every((s) => s.status !== "todo")) {
        return { ...station, status: "stopped" as const };
      }
      return station;
    });
}

// `available` are flows on disk that are not set up yet; the page lists
// them so a team can see what else it could turn on.
export function overview(flows: Flow[], available: Flow[] = [], extras: Extras = {}) {
  const running = new Set(flows.map((f) => f.flow));
  return {
    flows: flowSummaries([...flows, ...available], running),
    schedules: nextRuns(flows),
    vendors: extras.vendors ?? {},
    people: extras.people ?? {},
  };
}
