import type { Flow } from "../engine/flow-schema.ts";
import { isGate, isOutlet } from "../engine/flow-schema.ts";
import { compactIban } from "../engine/verifiers.ts";
import type { CaseEvent, Store } from "../engine/store.ts";
import { caseSummaries } from "./api.ts";

// The Investigations view: cases grouped by the accounts that connect them,
// with every connection backed by a recorded fact (who, what, when, from
// which case). Nothing here is a score or a guess; it is the event log read
// across cases. A person blocking a request is suspicion, not proof, and is
// labelled that way.

type Node = { kind: "case" | "account" | "vendor"; id: string; label: string };

export interface Evidence {
  id: string;
  from: Node;
  relation: "requested" | "pays" | "paid" | "printed" | "on-file" | "blocked" | "cleared" | "other-vendor";
  to: Node;
  source: string;
  caseId?: string;
  by?: string;
  at: string;
  status: string;
}

export interface Cluster {
  id: string;
  title: string;
  accounts: string[];
  cases: { id: string; title: string; flow: string; status: string; outcome: { label: string; tone: string }; openedAt?: string; waiting?: string }[];
  evidence: Evidence[];
  timeline: { at: string; seq: number; caseId: string; tone: "stop" | "person" | "act" | "neutral" | "agent"; text: string; by?: string }[];
  impact: {
    asked: number;
    paid: { amount: number; to: string; caseId: string; reference: string }[];
    open: number;
    stale: number;
    held: number;
  };
}

const mask = (iban: string) => (iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : iban);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// The last value each verify step recorded in a case, by check name.
function checksOf(events: CaseEvent[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const e of events) if (e.type === "verified") out[e.check] = rec(e.value);
  return out;
}

export function investigations(store: Store, flows: Flow[]): { clusters: Cluster[]; totals: Record<string, number> } {
  const summaries = new Map(caseSummaries(store, flows).map((c) => [c.id, c]));
  const flowOf = new Map(flows.map((f) => [f.flow, f]));
  type Touch = { caseId: string; iban: string; relation: Evidence["relation"]; at: string; source: string; vendor?: string; by?: string; status: string };
  const touches: Touch[] = [];
  // Every vendor an account is on file for, as the checks read it. One
  // account can be on file for several vendors (a factoring company paid on
  // behalf of each), and each of them is a fact.
  const onFile = new Map<string, Map<string, { at: string; caseId: string }>>();
  const putOnFile = (iban: string, vendor: string, at: string, caseId: string) => {
    const owners = onFile.get(iban) ?? new Map<string, { at: string; caseId: string }>();
    if (!owners.has(vendor)) owners.set(vendor, { at, caseId });
    onFile.set(iban, owners);
  };
  const signal = new Set<string>();
  const decisions: Touch[] = [];

  for (const [id, c] of summaries) {
    const events = c.events;
    const checks = checksOf(events);
    const at = c.openedAt ?? "";
    const bc = checks.bank_change;
    if (bc?.new_iban) {
      touches.push({ caseId: id, iban: String(bc.new_iban), relation: "requested", at, vendor: String(bc.vendor ?? ""), source: `bank-change email from ${String(bc.sender_domain || "an unknown sender")}`, status: "requested, not yet on file" });
    }
    if (bc?.current_iban && bc.vendor) putOnFile(String(bc.current_iban), String(bc.vendor), at, id);
    const vb = checks.vendor_bank;
    if (vb?.iban) {
      touches.push({ caseId: id, iban: String(vb.iban), relation: "pays", at, vendor: String(vb.vendor ?? ""), source: "vendor master, read by the bank check", status: "the account this invoice would pay" });
      if (vb.vendor) putOnFile(String(vb.iban), String(vb.vendor), at, id);
    }
    const printed = typeof c.data.iban === "string" ? compactIban(c.data.iban) : "";
    if (printed && printed !== String(vb?.iban ?? "")) {
      touches.push({ caseId: id, iban: printed, relation: "printed", at, source: "printed on the invoice", status: "printed on the invoice; never paid" });
    }
    for (const link of (checks.links?.links as { kind: string; iban: string; caseId?: string; owner?: string; detail: string }[] | undefined) ?? []) {
      signal.add(link.iban);
      if (link.kind === "other-vendor" && link.owner) putOnFile(link.iban, link.owner, at, id);
      if (link.kind === "other-vendor") {
        touches.push({ caseId: id, iban: link.iban, relation: "other-vendor", at, source: "vendor master, read by the links check", status: `${link.detail}; may be legitimate (factoring)` });
      }
    }
    for (const e of events) {
      const when = (e as { at_iso?: string }).at_iso ?? at;
      if (e.type === "flagged") {
        signal.add(e.iban);
        decisions.push(e.how === "callback"
          ? { caseId: id, iban: e.iban, relation: "blocked", at: new Date(e.at).toISOString(), by: e.by, source: `callback on the number on file: ${e.vendor} said it is not their account (request from ${e.sender || "an unknown sender"})`, status: "not confirmed by the supplier: refused, fraud not proven" }
          : { caseId: id, iban: e.iban, relation: "blocked", at: new Date(e.at).toISOString(), by: e.by, source: `a person answered "block" on a request from ${e.sender || "an unknown sender"}`, status: "blocked by a person: suspected, not confirmed fraud" });
      }
      if (e.type === "cleared") {
        decisions.push({ caseId: id, iban: e.iban, relation: "cleared", at: new Date(e.at).toISOString(), by: e.by, source: "people called the supplier and approved a change to it", status: "cleared after a callback and a second approver" });
      }
      if (e.type === "executed" && rec(rec(e.payload).pay).to) {
        const pay = rec(rec(e.payload).pay);
        touches.push({ caseId: id, iban: String(pay.to), relation: "paid", at: when, source: `sandbox bank: ${e.receipt}`, status: `paid ${String(pay.amount)} ${String(pay.currency ?? "")}`.trim() });
      }
    }
  }

  // Clusters: accounts with a recorded signal, joined through the cases
  // that touch them. An ordinary on-file account never joins two cases by
  // itself, or every invoice from one supplier would be one "incident".
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const all = [...touches, ...decisions];
  for (const t of all) if (signal.has(t.iban)) union(`a:${t.iban}`, `c:${t.caseId}`);
  const groups = new Map<string, { accounts: Set<string>; cases: Set<string> }>();
  for (const t of all) {
    if (!signal.has(t.iban)) continue;
    const root = find(`a:${t.iban}`);
    const g = groups.get(root) ?? { accounts: new Set(), cases: new Set() };
    g.accounts.add(t.iban);
    g.cases.add(t.caseId);
    groups.set(root, g);
  }

  const clusters: Cluster[] = [];
  for (const g of groups.values()) {
    const caseIds = [...g.cases].sort((a, b) => (summaries.get(a)?.openedAt ?? "").localeCompare(summaries.get(b)?.openedAt ?? ""));
    const node = {
      case: (id: string): Node => ({ kind: "case", id, label: summaries.get(id)?.title ?? id }),
      account: (iban: string): Node => ({ kind: "account", id: iban, label: mask(iban) }),
      vendor: (name: string): Node => ({ kind: "vendor", id: name, label: name }),
    };
    const evidence: Evidence[] = [];
    const seen = new Set<string>();
    const add = (e: Omit<Evidence, "id">) => {
      const id = `${e.from.id}|${e.relation}|${e.to.id}|${e.caseId ?? ""}`;
      if (seen.has(id)) return;
      seen.add(id);
      evidence.push({ id, ...e });
    };
    const accounts = new Set(g.accounts);
    const paidTo = new Set(all.filter((t) => t.relation === "paid").map((t) => `${t.caseId}|${t.iban}`));
    for (const t of all.filter((t) => g.cases.has(t.caseId))) {
      // "would pay" says nothing more once the same case paid that account.
      if (t.relation === "pays" && paidTo.has(`${t.caseId}|${t.iban}`)) continue;
      accounts.add(t.iban);
      if (t.relation === "blocked" || t.relation === "cleared") {
        add({ from: node.case(t.caseId), relation: t.relation, to: node.account(t.iban), source: t.source, caseId: t.caseId, by: t.by, at: t.at, status: t.status });
      } else if (t.relation === "other-vendor") {
        // Drawn below, with every vendor the account is on file for.
      } else {
        add({ from: node.case(t.caseId), relation: t.relation, to: node.account(t.iban), source: t.source, caseId: t.caseId, at: t.at, status: t.status });
      }
    }
    for (const iban of accounts) {
      const owners = [...(onFile.get(iban) ?? new Map()).entries()];
      for (const [vendor, seen] of owners) {
        const others = owners.map(([v]) => v).filter((v) => v !== vendor);
        add({
          from: node.account(iban),
          relation: "on-file",
          to: node.vendor(vendor),
          source: "vendor master, as a check read it",
          caseId: seen.caseId,
          at: seen.at,
          status: others.length ? `on file for ${vendor}, and also for ${others.join(", ")}: shared (a factoring company is one legitimate reason)` : `on file for ${vendor}`,
        });
      }
    }

    const timeline: Cluster["timeline"] = [];
    let asked = 0;
    let stale = 0;
    let open = 0;
    let held = 0;
    const paid: Cluster["impact"]["paid"] = [];
    for (const id of caseIds) {
      const c = summaries.get(id)!;
      const flow = flowOf.get(c.flow);
      if (typeof c.data.amount === "number") asked += c.data.amount;
      if (c.status === "open") open++;
      if (c.outcome.label.startsWith("Held") || c.outcome.label.startsWith("Blocked")) held++;
      for (const e of c.events) {
        const at = e.at_iso;
        const seq = e.seq;
        if (e.type === "opened") timeline.push({ at, seq, caseId: id, tone: "neutral", text: `opened: ${c.title} (${e.source ?? e.flow})` });
        if (e.type === "verified" && e.check === "links" && rec(e.value).ok === false) timeline.push({ at, seq, caseId: id, tone: "stop", text: `linked by code: ${String(rec(e.value).detail)}` });
        if (e.type === "flagged") timeline.push({ at, seq, caseId: id, tone: "stop", by: e.by, text: e.how === "callback" ? `${mask(e.iban)} recorded: the supplier said on the phone it is not theirs` : `${mask(e.iban)} recorded as blocked by a person (suspected, not confirmed)` });
        if (e.type === "cleared") timeline.push({ at, seq, caseId: id, tone: "act", by: e.by, text: `${mask(e.iban)} cleared: called and approved after the block` });
        if (e.type === "gate_answered") {
          const step = flow?.steps.find((s) => s.id === e.step);
          timeline.push({ at, seq, caseId: id, tone: e.approved ? "person" : "stop", by: e.answeredBy, text: `answered "${e.answer}" on ${step && isGate(step) ? e.step.replace(/_/g, " ") : e.step}` });
        }
        if (e.type === "rewound") {
          stale++;
          const why = Object.entries(e.docs).map(([d, [was, now]]) => (d.startsWith("links:") ? `links on ${mask(d.slice(6))} went ${was} → ${now}` : `${d} changed`)).join(", ");
          timeline.push({ at, seq, caseId: id, tone: "stop", text: `an approval stopped counting: ${why}` });
        }
        if (e.type === "executed") {
          const step = flow?.steps.find((s) => s.id === e.step);
          const pay = rec(rec(e.payload).pay);
          if (pay.to) paid.push({ amount: Number(pay.amount), to: String(pay.to), caseId: id, reference: String(pay.reference ?? "") });
          timeline.push({ at, seq, caseId: id, tone: "act", text: `${step && isOutlet(step) ? Object.keys(step.outlet)[0] : "done"}: ${e.receipt}` });
        }
      }
    }
    timeline.sort((a, b) => a.seq - b.seq);
    const blocked = evidence.filter((e) => e.relation === "blocked");
    const first = [...g.accounts][0];
    clusters.push({
      id: `${first}-${caseIds[0]}`,
      title: blocked.length
        ? `${[...new Set(blocked.map((b) => b.to.label))].join(", ")}: blocked by a person, named again in ${caseIds.length - 1} other case${caseIds.length === 2 ? "" : "s"}`
        : `${[...g.accounts].map(mask).join(", ")}: on file for more than one vendor`,
      accounts: [...accounts],
      cases: caseIds.map((id) => {
        const c = summaries.get(id)!;
        const w = c.waiting as { kind?: string; approver?: string; step?: string } | null;
        return { id, title: c.title, flow: c.flow, status: c.status, outcome: c.outcome, openedAt: c.openedAt, waiting: w?.kind === "person" ? `${w.approver ?? "a person"} on ${String(w.step ?? "").replace(/_/g, " ")}` : undefined };
      }),
      evidence,
      timeline,
      impact: { asked, paid, open, stale, held },
    });
  }
  clusters.sort((a, b) => (b.timeline.at(-1)?.seq ?? 0) - (a.timeline.at(-1)?.seq ?? 0));
  return {
    clusters,
    totals: {
      clusters: clusters.length,
      blocked: new Set(clusters.flatMap((c) => c.evidence.filter((e) => e.relation === "blocked").map((e) => e.to.id))).size,
      open: clusters.reduce((n, c) => n + c.impact.open, 0),
      stale: clusters.reduce((n, c) => n + c.impact.stale, 0),
    },
  };
}
