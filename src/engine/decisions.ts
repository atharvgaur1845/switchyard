import type { RoomDocument } from "./ports.ts";
import { docHash, type Grounding, locate, tableRows, type VerifyResult } from "./verifiers.ts";

// Checks for company decisions, done by code. A decision is checked against
// two room documents: what the company has already promised (`commitments`,
// one row per promise: who it is to, which resource it holds, until when,
// who decided it) and the company's own rules (`policy`, one row per rule,
// with who set it). Free capacity comes from a third document (`capacity`).
// The agents argue; these decide what is true: whether a proposal fits what
// is left after the promises already made, and whether it breaks a rule.

const DAY = 86_400_000;
const MONTH_DAYS = 30.44;

export interface Commitment {
  id: string;
  kind: string;
  to: string;
  resource: string;
  amount: number;
  until: string;
  decided_by: string;
  basis: string;
}

const num = (v: unknown) => Number(String(v ?? "").replace(/[,%\s]|INR/g, ""));
const fmt = (n: number, digits = 1) => n.toLocaleString("en", { maximumFractionDigits: digits });
const money = (n: number) => fmt(Math.round(n), 0);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function commitmentsOf(content: string): Commitment[] {
  return tableRows(content).map(([id = "", kind = "", to = "", resource = "", amount = "", until = "", decided_by = "", basis = ""]) => ({ id, kind, to, resource, amount: num(amount), until, decided_by, basis }));
}

export function capacityOf(content: string): { resource: string; available: number; unit: string; as_of: string }[] {
  return tableRows(content).map(([resource = "", available = "", unit = "", as_of = ""]) => ({ resource, available: num(available), unit, as_of }));
}

function policyOf(content: string): Map<string, { limit: number; text: string; set_by: string }> {
  return new Map(tableRows(content).map(([rule = "", limit = "", set_by = ""]) => [rule.toLowerCase(), { limit: num(limit), text: limit, set_by }]));
}

// Resources a promise holds, and the arguments that ask for them.
const ASKS = [
  { resource: "gpu-hours", arg: "gpu_hours", unit: "GPU-hours a month" },
  { resource: "engineers", arg: "engineers", unit: "engineers" },
];

export const DECISION_CHECKS: Record<string, { needsDoc: boolean; run: (args: Record<string, unknown>, docs: RoomDocument[]) => VerifyResult }> = {
  // args: doc (commitments), capacity (document name), start (date), weeks,
  // gpu_hours, engineers, exclude (case ids whose own rows do not count:
  // the decision being checked again, and the one it reconsiders).
  // Fits when every resource asked for is free for the whole window, after
  // the promises already made. Names every promise in the way, and who made it.
  commitments: {
    needsDoc: true,
    run(args, docs) {
      const doc = docs.find((d) => d.name === args.doc);
      const cap = docs.find((d) => d.name === (args.capacity ?? "capacity"));
      if (!doc || !cap) return { ok: false, detail: `this room has no ${!doc ? String(args.doc) : String(args.capacity ?? "capacity")} document` };
      const start = Date.parse(String(args.start ?? ""));
      const weeks = num(args.weeks);
      if (Number.isNaN(start) || !(weeks > 0)) return { ok: false, detail: "there is no start date and length to check against what is committed" };
      const end = start + weeks * 7 * DAY;
      const exclude = String(args.exclude ?? "").split(/[\s,]+/).filter(Boolean);
      const rows = commitmentsOf(doc.content).filter((r) => !exclude.some((id) => r.basis.includes(`case ${id}`)));
      const capacity = capacityOf(cap.content);
      const lines: string[] = [];
      const conflicts: (Commitment & { resource_short: number })[] = [];
      const needs: Record<string, number> = {};
      const free: Record<string, number> = {};
      const shortfall: Record<string, number> = {};
      for (const ask of ASKS) {
        const need = num(args[ask.arg]);
        if (!(need > 0)) continue;
        const total = capacity.find((c) => c.resource === ask.resource)?.available ?? 0;
        // A promise holds its resource until its date; one that ends before
        // the window starts holds nothing in it.
        const held = rows.filter((r) => r.resource === ask.resource && !Number.isNaN(Date.parse(r.until)) && Date.parse(r.until) >= start);
        const left = total - held.reduce((n, r) => n + r.amount, 0);
        needs[ask.arg] = need;
        free[ask.arg] = left;
        if (need <= left) continue;
        shortfall[ask.arg] = need - left;
        for (const r of held) conflicts.push({ ...r, resource_short: need - left });
        lines.push(`needs ${fmt(need)} ${ask.unit} from ${iso(start)} to ${iso(end)}, and ${fmt(Math.max(0, left))} of ${fmt(total)} are free: ${held.map((r) => `${r.id} holds ${fmt(r.amount)} for ${r.to} until ${r.until} (decided by ${r.decided_by})`).join(", ")}`);
      }
      return {
        ok: conflicts.length === 0,
        detail: conflicts.length ? lines.join("; ") : `fits what is left after ${rows.length} commitments, from ${iso(start)} to ${iso(end)}`,
        needs,
        free,
        shortfall,
        shortfall_gpu_hours: shortfall.gpu_hours ?? 0,
        conflicts,
        conflict_ids: [...new Set(conflicts.map((c) => c.id))].join(", ") || "none",
        start: iso(start),
        end: iso(end),
        // A service promise runs for the contract's term, a year by default.
        term_end: iso(start + (num(args.term_months) || 12) * MONTH_DAYS * DAY),
        commitments: rows,
        capacity,
        // The decision rests on the capacity as it is now: a change to it
        // voids an approval not yet acted on, and Assumption Watch re-checks it.
        watch: { [cap.name]: { hash: docHash(cap.content) } },
      };
    },
  },

  // args: doc (policy), value (a year, before discount), discount_pct,
  // uptime, weeks, gpu_hours, engineers, shortfall_gpu_hours (from the
  // commitments check). Every figure is computed here from the policy's own
  // rates; nothing an agent forecast is used.
  constitution: {
    needsDoc: true,
    run(args, docs) {
      const doc = docs.find((d) => d.name === args.doc);
      if (!doc) return { ok: false, detail: `this room has no ${String(args.doc)} document` };
      const rules = policyOf(doc.content);
      const rule = (name: string) => rules.get(name);
      const value = num(args.value);
      const discount = num(args.discount_pct);
      const uptime = num(args.uptime);
      const gpu = num(args.gpu_hours) || 0;
      const engineers = num(args.engineers) || 0;
      const months = (num(args.weeks) * 7) / MONTH_DAYS;
      if (!(value > 0) || Number.isNaN(discount) || Number.isNaN(uptime) || !(months > 0)) return { ok: false, detail: "the terms are incomplete: value, discount, uptime and length are all needed" };
      const gpuCost = rule("gpu-hour cost")?.limit ?? Number.NaN;
      const engCost = rule("engineer-month cost")?.limit ?? Number.NaN;
      const net = value * (1 - discount / 100);
      const cost = gpu * 12 * gpuCost + engineers * months * engCost;
      const margin = ((net - cost) / net) * 100;
      const fixed = num(args.shortfall_gpu_hours) > 0 ? num(args.shortfall_gpu_hours) * 12 * gpuCost : 0;
      const checks = [
        { rule: "max discount", value: discount, shown: `${fmt(discount)}%`, ok: (r: number) => discount <= r },
        { rule: "min gross margin", value: margin, shown: `${fmt(margin)}% (code: ${money(net)} after discount, ${money(cost)} cost = ${fmt(gpu)} GPU-hours × 12 × ${money(gpuCost)} + ${fmt(engineers)} engineers × ${fmt(months)} months × ${money(engCost)})`, ok: (r: number) => margin >= r },
        { rule: "max uptime promised", value: uptime, shown: `${fmt(uptime, 3)}%`, ok: (r: number) => uptime <= r },
        { rule: "new fixed costs this quarter", value: fixed, shown: fixed ? `${money(fixed)} a year, to buy the GPU-hours that are already promised to others` : "none", ok: (r: number) => fixed <= r },
      ].map((c) => {
        const r = rule(c.rule);
        if (!r || Number.isNaN(r.limit)) return { rule: c.rule, limit: "missing", set_by: "", value: c.value, ok: false, detail: `the policy has no "${c.rule}" rule, so this cannot pass` };
        const ok = !Number.isNaN(c.value) && c.ok(r.limit);
        return { rule: c.rule, limit: r.text, set_by: r.set_by, value: Math.round(c.value * 100) / 100, ok, detail: `${c.rule} ${r.text} (set by ${r.set_by}): ${c.shown}${ok ? "" : ", which breaks it"}` };
      });
      const broken = checks.filter((c) => !c.ok);
      return {
        ok: broken.length === 0 && !Number.isNaN(margin),
        detail: broken.length ? broken.map((c) => c.detail).join("; ") : `within every rule in ${doc.name}: margin ${fmt(margin)}%, discount ${fmt(discount)}%, uptime ${fmt(uptime, 3)}%`,
        rules: checks,
        broken: broken.length,
        broken_rules: broken.map((c) => c.rule).join(", ") || "none",
        margin: Math.round(margin * 10) / 10,
        net,
        cost: Math.round(cost),
        fixed_cost: Math.round(fixed),
      };
    },
  },

  // args: text (the proposal), by_<role> (each role's answer),
  // proposal_fit, proposal_policy, counter_fit, counter_policy (the code
  // checks). The dissent ledger: every objection is kept with its quote and
  // where the quote is in the proposal, never averaged into a verdict. An
  // objection whose quote is not in the proposal is set aside, and says so.
  // A rule the proposal breaks is binding: no answer on a card overrides it,
  // only an alternative that passes.
  dissent: {
    needsDoc: false,
    run(args) {
      const text = typeof args.text === "string" ? args.text : "";
      // One argument per role: by_finance, by_red_team, ...
      const positions = Object.fromEntries(Object.entries(args).filter(([k]) => k.startsWith("by_")).map(([k, v]) => [k.slice(3).replace(/_/g, " "), v as Record<string, unknown> | undefined]));
      const ledger: { from: string; claim: string; quote?: string; grounded?: Grounding; materiality: string; status: string }[] = [];
      const stances: { role: string; position: string }[] = [];
      for (const [role, value] of Object.entries(positions)) {
        if (!value || value.unavailable) {
          stances.push({ role, position: "could not answer" });
          ledger.push({ from: role, claim: `could not answer${value?.reason ? `: ${String(value.reason)}` : ""}`, materiality: "high", status: "open: this view is missing" });
          continue;
        }
        stances.push({ role, position: String(value.position ?? "none given") });
        for (const o of Array.isArray(value.objections) ? (value.objections as Record<string, unknown>[]) : []) {
          const quote = typeof o?.quote === "string" ? o.quote : undefined;
          const grounded = quote && text ? locate(text, quote) : undefined;
          ledger.push({ from: role, claim: String(o?.claim ?? ""), quote, ...(grounded ? { grounded } : {}), materiality: ["high", "medium", "low"].includes(String(o?.materiality)) ? String(o.materiality) : "medium", status: grounded ? "open" : "set aside: its quote is not in the proposal" });
        }
      }
      const fit = (args.proposal_fit ?? {}) as { ok?: boolean; detail?: string };
      const policy = (args.proposal_policy ?? {}) as { rules?: { ok: boolean; detail: string }[] };
      const counterOk = (args.counter_fit as { ok?: boolean } | undefined)?.ok === true && (args.counter_policy as { ok?: boolean } | undefined)?.ok === true;
      const binding = [...(fit.ok === false && fit.detail ? [fit.detail] : []), ...(policy.rules ?? []).filter((r) => !r.ok).map((r) => r.detail)];
      for (const claim of binding) ledger.push({ from: "code", claim, materiality: "binding", status: counterOk ? "binding: the proposal cannot be accepted as it stands; the counteroffer passes it" : "binding: the proposal cannot be accepted as it stands" });
      const open = ledger.filter((l) => l.status.startsWith("open"));
      return {
        ok: open.length === 0,
        detail: `${stances.map((s) => `${s.role}: ${s.position}`).join(", ")}; ${open.length} objection${open.length === 1 ? "" : "s"} open${ledger.length - open.length - binding.length ? `, ${ledger.length - open.length - binding.length} set aside` : ""}; ${binding.length} binding finding${binding.length === 1 ? "" : "s"} by code against the proposal as it stands`,
        stances,
        ledger,
        open: open.length,
        binding: binding.length,
      };
    },
  },
};
