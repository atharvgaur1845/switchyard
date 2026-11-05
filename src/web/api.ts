import type { Flow } from "../engine/flow-schema.ts";
import { isAgent, isGate, isParallel, isWait } from "../engine/flow-schema.ts";
import type { CaseState, Store } from "../engine/store.ts";
import { nextRuns } from "../inlets/schedule.ts";

// What the dashboard reads. Shaped here so the page stays a plain view.

export function flowSummaries(flows: Flow[], running: Set<string> = new Set(flows.map((f) => f.flow))) {
  return flows.map((flow) => ({
    flow: flow.flow,
    running: running.has(flow.flow),
    room: flow.room,
    description: flow.description ?? flow.flow,
    inlets: Object.entries(flow.inlet ?? {}).map(([kind, spec]) => ({ kind, spec })),
    steps: flow.steps.map((step) => ({
      id: step.id,
      kind: isAgent(step) || isParallel(step) ? "agent" : isGate(step) ? "gate" : isWait(step) ? "wait" : "outlet",
      who: isAgent(step) ? step.agent : isParallel(step) ? step.parallel.join(" + ") : isGate(step) ? step.gate.approver : isWait(step) ? step.wait : outletKind(step),
      backup: isAgent(step) ? step.bench : isGate(step) ? step.gate.backup : undefined,
      conditional: step.when !== undefined,
      auto: "auto_approve" in step && step.auto_approve !== false,
    })),
  }));
}

function outletKind(step: Flow["steps"][number]): string {
  return "outlet" in step ? Object.keys(step.outlet)[0] : "";
}

export function caseSummaries(store: Store, flows: Flow[]) {
  const byName = new Map(flows.map((f) => [f.flow, f]));
  return store.caseIds().map((id) => {
    const state = store.load(id);
    const timeline = store.timeline(id);
    const opened = timeline[0];
    return {
      id,
      flow: state.flow,
      title: titleOf(state),
      source: opened?.type === "opened" ? (opened.source ?? "") : "",
      status: state.status,
      waiting: waitingOn(state),
      openedAt: opened?.at_iso,
      updatedAt: timeline.at(-1)?.at_iso,
      stations: stations(state, byName.get(state.flow)),
      data: state.data,
      events: timeline,
    };
  });
}

// A short human title from whatever the inlet brought in.
function titleOf(state: CaseState): string {
  const d = state.data;
  const pick = (...keys: string[]) => keys.map((k) => d[k]).find((v) => typeof v === "string" || typeof v === "number");
  const who = pick("name", "from_name", "from", "supplier", "client");
  const what = pick("subject", "question", "category", "number", "period", "role");
  const amount = typeof d.amount === "number" ? ` · ${d.amount.toLocaleString("en")}` : "";
  const text = [who, what].filter(Boolean).map(String).join(" — ");
  const short = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  return (short || state.flow) + amount;
}

function waitingOn(state: CaseState) {
  const p = state.pending;
  if (!p) return null;
  return p.kind === "agent"
    ? { kind: "agent", step: p.step, who: p.agent, since: p.at }
    : p.kind === "wait"
      ? { kind: "wait", step: p.step, until: p.until }
      : p.kind === "parallel"
        ? { kind: "agent", step: p.step, who: Object.keys(p.agents).filter((a) => p.agents[a].value === undefined).join(" + "), since: p.at }
        : p.kind === "in_doubt"
          ? { kind: "person", step: p.step, since: p.at, escalated: false, doubt: true }
          : { kind: "person", step: p.step, since: p.at, escalated: p.escalated };
}

// Each flow step as a station on the case's track.
function stations(state: CaseState, flow: Flow | undefined) {
  if (!flow) return [];
  return flow.steps.map((step) => {
    let status: "done" | "skipped" | "current" | "todo" | "stopped" = "todo";
    if (state.pending?.step === step.id) status = "current";
    else if (state.finished.has(step.id)) status = step.id in state.results ? "done" : "skipped";
    return {
      id: step.id,
      kind: isAgent(step) || isParallel(step) ? "agent" : isGate(step) ? "gate" : isWait(step) ? "wait" : "outlet",
      status,
    };
  }).map((station, i, all) => {
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
export function overview(flows: Flow[], available: Flow[] = []) {
  const running = new Set(flows.map((f) => f.flow));
  return { flows: flowSummaries([...flows, ...available], running), schedules: nextRuns(flows) };
}
