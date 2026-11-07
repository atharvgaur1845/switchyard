import { capacityOf, commitmentsOf } from "./decisions.ts";
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

  // Capacity safety: every resource in the capacity document, at today and
  // at the start of every open hold, with or without holds. Over-commitment
  // is a breach unless the engine already caught it: capacity was lost after
  // decisions were carried out, and Assumption Watch has those decisions
  // marked (broken, or suspect while a noisy reading is confirmed).
  const commitments = docs.find((d) => d.name === "commitments")?.content;
  const capacity = docs.find((d) => d.name === "capacity")?.content;
  if (commitments === undefined || capacity === undefined) {
    out.push({ name: "capacity safety", ok: false, detail: `cannot be checked: no ${commitments === undefined ? "commitments" : "capacity"} document` });
  } else {
    const holds = store.holds(now);
    const rows = capacityOf(capacity);
    const unreadable = rows.filter((r) => !Number.isFinite(r.available) || r.available < 0).map((r) => r.resource || "(no name)");
    const promises = commitmentsOf(commitments);
    const badRows = promises.filter((r) => !Number.isFinite(r.amount) || Number.isNaN(Date.parse(r.until))).map((r) => r.id || "(no id)");
    const watched = ids.some((id) => store.events(id).some((e) => e.type === "assumption_broken" || e.type === "assumption_suspect"));
    // When each promise starts: a row a decision wrote starts where that
    // decision's hold started (recorded when it was taken); a row with no
    // start on record is counted from today, on the cautious side.
    const startOf = new Map<string, string>();
    for (const id of ids) {
      for (const e of store.events(id)) if (e.type === "reserved") for (const h of e.holds) startOf.set(`${id}|${h.resource}`, h.start);
    }
    const today = now.toISOString().slice(0, 10);
    const open = new Set(holds.map((h) => h.case));
    const running = promises
      .filter((p) => Number.isFinite(p.amount) && !open.has(/case ([0-9a-f]+)/.exec(p.basis)?.[1] ?? ""))
      .map((p) => ({ ...p, from: startOf.get(`${/case ([0-9a-f]+)/.exec(p.basis)?.[1] ?? ""}|${p.resource}`) ?? today }));
    const over: string[] = [];
    for (const r of rows.filter((x) => Number.isFinite(x.available))) {
      // The total can only rise on a day something starts.
      const dates = new Set([today, ...holds.filter((h) => h.resource === r.resource).map((h) => h.start), ...running.filter((p) => p.resource === r.resource).map((p) => p.from)]);
      for (const date of dates) {
        const at = Date.parse(date);
        const committed = running.filter((p) => p.resource === r.resource && Date.parse(p.from) <= at && Date.parse(p.until) >= at).reduce((n, p) => n + p.amount, 0);
        const held = holds.filter((h) => h.resource === r.resource && Date.parse(h.start) <= at && Date.parse(h.until) >= at).reduce((n, h) => n + h.amount, 0);
        if (committed + held > r.available) over.push(`${r.resource} at ${date}: ${committed} committed + ${held} held > ${r.available}`);
      }
    }
    const problems = [...unreadable.map((x) => `capacity for ${x} is not a finite number`), ...badRows.map((x) => `commitment ${x} cannot be read`)];
    const ok = problems.length === 0 && (over.length === 0 || watched);
    out.push({
      name: "capacity safety",
      ok,
      detail: problems.length
        ? `cannot be checked: ${problems.join("; ")}`
        : over.length
          ? `${over.join("; ")}${watched ? " (capacity was lost after decisions were carried out; Assumption Watch has them marked to decide again)" : ""}`
          : `${rows.length} resource${rows.length === 1 ? "" : "s"} and ${holds.length} open hold${holds.length === 1 ? "" : "s"}, all within capacity`,
    });
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
