import type { Flow } from "../engine/flow-schema.ts";
import type { RoomDocument } from "../engine/ports.ts";
import type { Store } from "../engine/store.ts";
import { tableRows } from "../engine/verifiers.ts";

// The company Switchyard runs inside, for the console's Company view: every
// department's records as the room's documents hold them now, and what the
// controls did, counted from the event log. Nothing here is computed for
// display only; each figure names the events or rows it comes from.

// tableRows drops the header line; the header is the first table line.
const table = (doc?: RoomDocument) => {
  if (!doc) return { headers: [] as string[], rows: [] as string[][] };
  const first = doc.content.split("\n").map((l) => l.trim()).find((l) => l.startsWith("|")) ?? "";
  return { headers: first.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()), rows: tableRows(doc.content) };
};

export function companyView(store: Store, flows: Flow[], docs: RoomDocument[], now = new Date()) {
  const byName = (n: string) => docs.find((d) => d.name === n);
  const cases = store.caseIds().map((id) => ({ id, state: store.load(id), events: store.events(id) }));
  const of = (flow: string) => cases.filter((c) => c.state.flow === flow);
  const count = (pred: (e: { type: string } & Record<string, unknown>) => boolean, list = cases) =>
    list.reduce((n, c) => n + c.events.filter((e) => pred(e as never)).length, 0);
  const verified = (list: typeof cases, step: string, ok: boolean) =>
    list.filter((c) => c.events.some((e) => e.type === "verified" && e.step === step && (e.value as { ok?: boolean }).ok === ok));

  const decisions = of("contract-decision");
  const invoices = of("invoice-check");
  const bankChanges = of("bank-change");
  const holds = store.holds(now);

  const outcomes = [
    { key: "conflicts", label: "Conflicting commitments caught", n: verified(decisions, "fit", false).length, from: "contract cases whose proposal failed the commitments check" },
    { key: "overalloc", label: "Over-allocations refused", n: count((e) => e.type === "reservation_refused", decisions) + decisions.filter((c) => c.events.some((e) => e.type === "verified" && e.step === "counter_fit" && /\bR-/.test(String((e.value as { conflict_ids?: string }).conflict_ids ?? "")))).length, from: "refused holds, and counteroffers that failed because another decision held the capacity" },
    { key: "unauth", label: "Unauthorized answers blocked", n: count((e) => e.type === "card_reopened"), from: "cards re-opened because the wrong person, or the same person twice, answered" },
    { key: "invoices", label: "Invoices and bank changes held", n: new Set([...verified(invoices, "po_check", false), ...verified(invoices, "bank_check", false)]).size + bankChanges.filter((c) => c.events.some((e) => e.type === "gate_answered" && ["block", "hold"].includes(String(e.answer)))).length, from: "invoices failing the PO or account-on-file check, and bank changes blocked or held" },
    { key: "invalidated", label: "Decisions re-opened by changed facts", n: count((e) => e.type === "assumption_broken" || e.type === "rewound"), from: "assumptions broken after acting, and approvals voided before acting" },
    { key: "executed", label: "Actions carried out as approved", n: count((e) => e.type === "executed"), from: "executed events whose payload hashed to the approved action" },
  ];

  const contracts = decisions.map((c) => {
    const d = c.state.data as Record<string, unknown>;
    const hold = holds.filter((h) => h.case === c.id);
    return { id: c.id, customer: String(d.customer ?? ""), value: Number(d.value ?? 0), status: c.state.status, reconsider: d.reconsider ?? null, held: hold.map((h) => `${h.amount} ${h.resource}`).join(", "), answers: c.events.filter((e) => e.type === "gate_answered").map((e) => `${(e as { step: string }).step}: ${(e as { answer: string }).answer} by ${(e as { answeredBy: string }).answeredBy}`) };
  });

  return {
    company: "AsterCompute",
    tagline: "A sandbox GPU cloud company: its customers, capacity, engineers, suppliers and rules are demo data in Switch room documents.",
    departments: [
      { id: "sales", name: "Sales", what: "Customer contracts, as cases", records: { headers: ["case", "customer", "₹ a year", "status", "held now"], rows: contracts.map((c) => [c.id, c.customer, c.value.toLocaleString("en-IN"), c.reconsider ? `deciding again (after ${c.reconsider})` : c.status, c.held || "·"]) } },
      { id: "infra", name: "Infrastructure", what: "GPU capacity and who holds it", records: table(byName("capacity")), holds },
      { id: "engineering", name: "Engineering", what: "Promises of people and capacity", records: table(byName("commitments")) },
      { id: "finance", name: "Finance", what: "Purchase orders and what has been invoiced", records: table(byName("purchase-orders")) },
      { id: "procurement", name: "Procurement", what: "Suppliers and the accounts on file", records: table(byName("vendor-master")) },
      { id: "compliance", name: "Compliance", what: "The company's rules and who set them", records: table(byName("policy")) },
    ],
    outcomes,
    flows: flows.map((f) => f.flow),
  };
}
