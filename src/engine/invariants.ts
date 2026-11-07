import { standingOf } from "./decisions.ts";
import { type Flow, isGate, isOutlet } from "./flow-schema.ts";
import type { RoomDocument } from "./ports.ts";
import type { Store } from "./store.ts";

// The guarantees Switchyard makes, checked on the event log and the
// reservation ledger as they stand. The Chaos Lab asserts them after every
// scenario; any engine change that breaks one shows up there.
//
// - capacity safety: what the commitments document holds plus every open
//   decision's hold never exceeds the capacity, for each hold's window.
// - approval integrity: every action a person approved was sent with the
//   exact hash they approved.
// - authority separation: no one answered two gates the flow keeps apart.
// - idempotent execution: no action was carried out twice in a case.
// - recoverability: an action whose outcome is unknown is in doubt, and
//   was not sent again.

export interface Invariant {
  name: string;
  ok: boolean;
  detail: string;
}

export function invariants(store: Store, flows: Flow[], docs: RoomDocument[], now: Date): Invariant[] {
  const out: Invariant[] = [];
  const ids = store.caseIds();

  // Capacity safety.
  const commitments = docs.find((d) => d.name === "commitments")?.content;
  const capacity = docs.find((d) => d.name === "capacity")?.content;
  if (commitments !== undefined && capacity !== undefined) {
    const holds = store.holds(now);
    const standing = standingOf(commitments, capacity, holds.map((h) => h.case));
    const over = holds.flatMap((h) => {
      const { capacity: total, committed } = standing(h.resource, h.start);
      const held = holds.filter((o) => o.resource === h.resource && Date.parse(o.until) >= Date.parse(h.start)).reduce((n, o) => n + o.amount, 0);
      return committed + held > total ? [`${h.resource} from ${h.start}: ${committed} committed + ${held} held > ${total}`] : [];
    });
    out.push({ name: "capacity safety", ok: over.length === 0, detail: over.length ? over.join("; ") : `${holds.length} open hold${holds.length === 1 ? "" : "s"}, all within capacity` });
  }

  const approvalProblems: string[] = [];
  const separationProblems: string[] = [];
  const twice: string[] = [];
  const doubts: string[] = [];
  for (const id of ids) {
    const state = store.load(id);
    const flow = flows.find((f) => f.flow === state.flow);
    const events = store.events(id);

    // Approval integrity: the hash a gate approved for an outlet is the hash
    // that outlet was sent with.
    let approved: Record<string, string> = {};
    let offered: Record<string, string> = {};
    for (const e of events) {
      if (e.type === "gate_opened") offered = e.hashes ?? {};
      if (e.type === "rewound") approved = Object.fromEntries(Object.entries(approved).filter(([step]) => !e.steps.includes(step)));
      if (e.type === "gate_answered" && e.approved) approved = { ...approved, ...offered };
      if (e.type === "executed" && approved[e.step] && approved[e.step] !== e.hash) approvalProblems.push(`${id}/${e.step}`);
    }

    // Authority separation.
    for (const step of flow?.steps ?? []) {
      if (!isGate(step)) continue;
      const mine = events.findLast((e) => e.type === "gate_answered" && e.step === step.id);
      for (const other of step.gate.not_same_as) {
        const theirs = events.findLast((e) => e.type === "gate_answered" && e.step === other);
        if (mine?.type === "gate_answered" && theirs?.type === "gate_answered" && mine.answeredBy === theirs.answeredBy) separationProblems.push(`${id}: ${mine.answeredBy} answered ${other} and ${step.id}`);
      }
    }

    // Idempotent execution.
    const done = events.filter((e) => e.type === "executed").map((e) => (e.type === "executed" ? e.step : ""));
    for (const step of new Set(done)) if (done.filter((s) => s === step).length > 1) twice.push(`${id}/${step}`);

    // Recoverability: started and never finished means in doubt, unless a
    // person already resolved it.
    for (const step of flow?.steps ?? []) {
      if (!isOutlet(step)) continue;
      const started = events.some((e) => e.type === "executing" && e.step === step.id);
      const finished = events.some((e) => (e.type === "executed" || e.type === "doubt_resolved") && e.step === step.id);
      const parked = state.pending?.kind === "in_doubt" || events.some((e) => e.type === "in_doubt" && e.step === step.id);
      if (started && !finished && !parked && state.status !== "open") doubts.push(`${id}/${step.id}`);
    }
  }
  out.push({ name: "approval integrity", ok: approvalProblems.length === 0, detail: approvalProblems.length ? `sent with a hash nobody approved: ${approvalProblems.join(", ")}` : "every approved action was sent as approved" });
  out.push({ name: "authority separation", ok: separationProblems.length === 0, detail: separationProblems.join("; ") || "no one answered two gates kept apart" });
  out.push({ name: "idempotent execution", ok: twice.length === 0, detail: twice.length ? `carried out twice: ${twice.join(", ")}` : "no action carried out twice" });
  out.push({ name: "recoverability", ok: doubts.length === 0, detail: doubts.length ? `started, not finished, not in doubt: ${doubts.join(", ")}` : "every action with an unknown outcome is in doubt for a person" });
  return out;
}
