// Helpers shared by the dashboard's views. Everything a view shows is read
// from the API (the flow files and the event log); nothing here makes up a
// value, and a view with no data says so.

import { esc, sameHash } from "./icons.js";

export const token = new URLSearchParams(location.search).get("token");
export const withToken = (path) => path + (token ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : "");
export const api = (path, init) =>
  fetch(withToken(path), init).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`);
    return r.json();
  });

export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
export const money = (n) => (typeof n === "number" ? n.toLocaleString("en", { maximumFractionDigits: 2 }) : esc(n));
export const mask = (iban) => (iban && iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : (iban ?? ""));
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const seconds = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

// The latest value each code check recorded in a case, by check name.
export function checksOf(c) {
  const out = {};
  for (const e of c.events) if (e.type === "verified") out[e.check] = e.value ?? {};
  return out;
}

// What was approved, and what was done, in order: an action counts as
// matched only when every hash recorded for it agrees.
export function receiptsOf(c, stepOf) {
  const out = [];
  const approvals = {};
  let gate = null;
  for (const e of c.events) {
    if (e.type === "gate_opened") gate = e;
    if (e.type === "rewound") for (const step of e.steps) delete approvals[step];
    if (e.type === "gate_answered" && gate) {
      for (const [step, hash] of Object.entries(gate.hashes)) approvals[step] = { hash, by: e.answeredBy, answer: e.answer, approved: e.approved, gate: e.step, payload: gate.payloads?.[step] };
      if (!e.approved) for (const [step, hash] of Object.entries(gate.hashes)) out.push({ kind: "declined", step, hash, ...approvals[step] });
    }
    if (e.type === "executed") {
      const a = approvals[e.step];
      // true: every hash we have agrees; false: one differs; undefined: a rule ran it and nothing was read back.
      const agrees = (!a || sameHash(a.hash, e.hash)) && (e.readback === undefined || sameHash(e.readback, e.hash));
      const match = !agrees ? false : a || e.readback ? true : undefined;
      out.push({ kind: "executed", step: e.step, approval: a, hash: e.hash, receipt: e.receipt, payload: e.payload, readback: e.readback, match, rule: stepOf?.(c, e.step)?.autoRule, ruleInputs: e.rule?.inputs, at: e.at_iso });
    }
    if (e.type === "failed" && /approved/.test(e.reason)) out.push({ kind: "blocked", step: e.step, reason: e.reason });
  }
  return out;
}

// Payments sent through the bank, with whether the bank's copy matches.
export function paymentsOf(c) {
  return c.events
    .filter((e) => e.type === "executed" && e.payload?.pay)
    .map((e) => ({ caseId: c.id, at: e.at_iso, to: e.payload.pay.to, amount: Number(e.payload.pay.amount), currency: e.payload.pay.currency ?? "", reference: e.payload.pay.reference, proven: e.readback !== undefined && sameHash(e.readback, e.hash), byRule: Boolean(e.rule) }));
}

// The tone of an outcome label, as the case list colours it.
export const TONE_ORDER = ["stop", "person", "agent", "act", "neutral"];

// One event as a short line for streams: who did what, in which tone.
// Returns null for events that are bookkeeping (an "executing" before its
// "executed", a skipped step).
export function describe(e) {
  const step = String(e.step ?? "").replace(/_/g, " ");
  switch (e.type) {
    case "opened": return { tone: "neutral", kind: "inlet", who: "inlet", text: `case opened from ${e.source || "outside"}` };
    case "fanned_out": return { tone: "agent", kind: "agent", who: "@yard", text: `asked ${e.agents.join(" and ")} to work ${step} independently` };
    case "asked": return e.parallel && e.attempt === 1 ? null : { tone: "agent", kind: "agent", who: "@yard", text: `asked ${e.agent} for ${step}${e.tries > 1 ? ` (try ${e.tries})` : ""}` };
    case "partial": return { tone: e.value?.unavailable ? "stop" : "agent", kind: "agent", who: e.agent, text: e.value?.unavailable ? `could not answer ${step}: ${e.value.reason}` : `answered ${step}` };
    case "answered": return { tone: "agent", kind: "agent", who: "@yard", text: e.value && typeof e.value === "object" && "complete" in e.value ? (e.value.complete ? `every agent answered ${step}` : `an agent could not answer ${step}`) : `accepted the answer to ${step}` };
    case "reply_rejected": return { tone: "stop", kind: "agent", who: "@yard", text: `reply not accepted: ${e.error}` };
    case "failed_over": return { tone: "stop", kind: "agent", who: "@yard", text: `moved ${step} from ${e.from} to ${e.to}: ${e.reason}` };
    case "verified": return { tone: e.value?.ok ? "act" : "stop", kind: "code", who: "code", text: `${e.check}: ${e.value?.detail ?? (e.value?.ok ? "passed" : "failed")}` };
    case "gate_opened": return { tone: "person", kind: "person", who: "@yard", text: `card for ${e.approver}: ${step}` };
    case "gate_answered": return { tone: e.approved ? "person" : "stop", kind: "person", who: e.answeredBy, text: `chose "${e.answer}" on ${step}` };
    case "card_reopened": return { tone: "stop", kind: "person", who: "@yard", text: `refused an answer on ${step} and re-opened the card` };
    case "reminded": return { tone: "person", kind: "person", who: "@yard", text: `reminded the approver of ${step}` };
    case "escalated": return { tone: "person", kind: "person", who: "@yard", text: `escalated ${step}${e.to ? ` to ${e.to}` : ""}` };
    case "rewound": return { tone: "stop", kind: "code", who: "@yard", text: `an approval on ${step} stopped counting: what its checks read changed` };
    case "flagged": return { tone: "stop", kind: "person", who: e.by, text: `${mask(e.iban)} recorded as ${e.how === "callback" ? "refused on the callback" : "blocked by a person"}` };
    case "cleared": return { tone: "act", kind: "person", who: e.by, text: `${mask(e.iban)} cleared after a callback and a second approver` };
    case "executed": return { tone: "act", kind: "action", who: "@yard", text: e.receipt };
    case "in_doubt": return { tone: "stop", kind: "action", who: "@yard", text: `could not tell whether ${step} happened; a person decides` };
    case "failed": return { tone: "stop", kind: "action", who: "@yard", text: `stopped at ${step}: ${e.reason}` };
    case "cancelled": return { tone: "stop", kind: "action", who: e.by, text: "cancelled the case" };
    case "done": return { tone: "act", kind: "action", who: "@yard", text: "closed the case" };
    default: return null;
  }
}

// A JSON value as a collapsible tree, escaped. Used wherever the page shows
// a recorded value as it is.
export function tree(value, depth = 0) {
  if (value === null || value === undefined) return `<span class="j-null">${value === null ? "null" : "—"}</span>`;
  if (typeof value === "string") return `<span class="j-str">${esc(value)}</span>`;
  if (typeof value === "number" || typeof value === "boolean") return `<span class="j-lit">${esc(String(value))}</span>`;
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (!entries.length) return `<span class="j-null">${Array.isArray(value) ? "[]" : "{}"}</span>`;
  const rows = entries.map(([k, v]) => `<li><span class="j-key">${esc(k)}</span> ${tree(v, depth + 1)}</li>`).join("");
  const label = Array.isArray(value) ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : `${entries.length} field${entries.length === 1 ? "" : "s"}`;
  return depth >= 1 ? `<details class="j-node"><summary>${label}</summary><ul>${rows}</ul></details>` : `<ul class="j-root">${rows}</ul>`;
}
