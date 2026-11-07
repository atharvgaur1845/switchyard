// The Decision Room: one company decision at a time. What was proposed and
// the alternative, side by side, as code checked them; each view's position;
// every objection, kept with its quote; who decided and co-signed; the
// commitments it wrote; and whether what it rested on still holds. All of it
// from the case's events.

import { esc, hx, icon } from "./icons.js";
import { money, plural, setHash, stamp, stepsOf } from "./views.js";

const ROLE_STEPS = ["assess", "challenge"];

export const isDecision = (c) => c.events.some((e) => e.type === "verified" && e.check === "dissent") || c.flow === "contract-decision";

function positions(c, flow) {
  const out = [];
  for (const id of ROLE_STEPS) {
    const step = flow?.steps.find((s) => s.id === id);
    for (const e of c.events.filter((x) => x.type === "partial" && x.step === id)) {
      out.push({ role: step?.roles?.[e.agent] ?? e.agent, agent: e.agent, value: e.value, at: e.at_iso });
    }
  }
  return out;
}

// Each objection's status, as the log now stands: open, then answered for
// by whoever chose to go ahead with it open.
function ledgerRows(c, dissent) {
  const decided = c.events.find((e) => e.type === "gate_answered" && e.step === "decide" && e.approved);
  return (dissent?.ledger ?? []).map((l) => ({ ...l, status: l.status === "open" && decided ? `open when ${decided.answeredBy} chose "${decided.answer}": answerable for it` : l.status }));
}

const cell = (ok) => (ok === undefined ? '<span class="t-muted">—</span>' : ok ? icon("check", "t-act") : icon("x", "t-stop"));

function alternatives(c, checks) {
  const p = c.data;
  const counter = c.events.find((e) => e.type === "partial" && e.step === "assess" && e.value?.counteroffer)?.value.counteroffer;
  const col = (terms, fit, policy) => ({ terms, fit, policy });
  const cols = [col(p && { discount_pct: p.discount_pct, uptime: p.uptime, start: p.start, weeks: p.weeks, gpu_hours: p.gpu_hours, engineers: p.engineers }, checks.fit, checks.policy), col(counter, checks.counter_fit, checks.counter_policy)];
  const rule = (policy, name) => policy?.rules?.find((r) => r.rule === name);
  const rows = [
    ["Discount", (t) => (t ? `${t.discount_pct}%` : "—"), (x) => rule(x.policy, "max discount")?.ok],
    ["Uptime promised", (t) => (t ? `${t.uptime}%` : "—"), (x) => rule(x.policy, "max uptime promised")?.ok],
    ["Year-1 margin (code)", (_, x) => (x.policy?.margin !== undefined ? `${x.policy.margin}%` : "—"), (x) => rule(x.policy, "min year-1 margin")?.ok],
    ["New fixed cost (code)", (_, x) => (x.policy?.fixed_cost !== undefined ? money(x.policy.fixed_cost) : "—"), (x) => rule(x.policy, "new fixed costs this quarter")?.ok],
    ["GPU-hours a month", (t, x) => (t ? `${t.gpu_hours} <span class="t-muted">(${x.fit?.free?.gpu_hours ?? "?"} free)</span>` : "—"), (x) => (x.fit ? !(x.fit.shortfall?.gpu_hours > 0) : undefined)],
    ["Engineers", (t, x) => (t ? `${t.engineers} <span class="t-muted">(${x.fit?.free?.engineers ?? "?"} free)</span>` : "—"), (x) => (x.fit ? !(x.fit.shortfall?.engineers > 0) : undefined)],
    ["Window", (t, x) => (x.fit?.start ? `${x.fit.start} → ${x.fit.end}` : t ? `${t.start}, ${t.weeks} weeks` : "—"), () => undefined],
  ];
  const verdict = (x) => (x.fit?.ok && x.policy?.ok ? '<span class="pill act">passes every check</span>' : x.fit || x.policy ? '<span class="pill stop">fails</span>' : '<span class="pill neutral">not proposed</span>');
  return `<table class="dr-alts"><thead><tr><th></th><th>As proposed ${verdict(cols[0])}</th><th>Counteroffer (finance desk) ${verdict(cols[1])}</th></tr></thead><tbody>
    ${rows.map(([label, show, ok]) => `<tr><th>${esc(label)}</th>${cols.map((x) => `<td><span class="dr-ok">${cell(ok(x))}</span>${show(x.terms, x)}</td>`).join("")}</tr>`).join("")}
    <tr><th>Promises in the way</th>${cols.map((x) => `<td>${x.fit ? (x.fit.conflicts?.length ? [...new Map(x.fit.conflicts.map((k) => [k.id, k])).values()].map((k) => `<span class="dr-promise" title="${esc(k.basis)}"><b>${esc(k.id)}</b> ${esc(k.to)} · ${esc(k.resource)} ${esc(k.amount)} until ${esc(k.until)} · ${esc(k.decided_by)}</span>`).join("") : '<span class="t-act">none</span>') : "—"}</td>`).join("")}</tr>
  </tbody></table>`;
}

function marked(text, ledger) {
  const spans = ledger.filter((l) => l.grounded?.in === "text").map((l) => l.grounded).sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const g of spans) {
    if (g.start < at) continue;
    out += esc(text.slice(at, g.start)) + `<mark title="${g.start}–${g.end}">${esc(text.slice(g.start, g.end))}</mark>`;
    at = g.end;
  }
  return out + esc(text.slice(at));
}

function watch(c, flow, cases) {
  const broken = c.events.filter((e) => e.type === "assumption_broken");
  const carried = c.events.some((e) => e.type === "executed");
  const list = (flow?.assumptions ?? []).map((a) => {
    const b = broken.find((x) => x.assumption === a.id);
    const again = b && cases.find((x) => x.id === b.reopened);
    return `<li class="${b ? "bad" : carried ? "ok" : "wait"}">${icon(b ? "alert" : carried ? "check" : "clock")}<div><b>${esc(a.title)}</b>
      <div class="fine">${b ? `Broke ${esc(stamp(b.at_iso))}: ${esc(b.detail)}` : carried ? "Holding: code checks it again on every tick, on the room's documents as they are now." : "Watched once the decision is carried out."}</div>
      ${again ? `<div class="fine">Decided again in <a class="caselink" href="#decisions/${esc(again.id)}">case ${esc(again.id)}</a> <span class="pill ${esc(again.outcome.tone)}">${esc(again.outcome.label)}</span>. This decision and what it did stay as they were.</div>` : ""}</div></li>`;
  });
  return list.length ? `<ul class="dr-watch">${list.join("")}</ul>` : '<p class="fine">This flow declares no assumptions.</p>';
}

function room(c, state) {
  const flow = state.flows.find((f) => f.flow === c.flow);
  const checks = stepsOf(c);
  const dissent = checks.dissent;
  const ledger = ledgerRows(c, dissent);
  const views = positions(c, flow);
  const gates = c.events.filter((e) => e.type === "gate_answered" || e.type === "card_reopened");
  const done = c.events.filter((e) => e.type === "executed");
  const reconsiders = c.data.reconsider && state.cases.find((x) => x.id === c.data.reconsider);
  const waiting = c.waiting?.kind === "person" ? c.waiting : null;
  return `
    <div class="dr-top">
      <div><h2>${esc(c.data.customer ?? c.title)} <span class="t-muted">· ${money(c.data.value)} a year</span></h2>
        <div class="meta"><span>proposed by ${esc(c.data.proposed_by ?? "?")}</span><span class="sep">·</span><span class="mono">case ${esc(c.id)}</span><span class="sep">·</span><span>${esc(stamp(c.openedAt))}</span>
        ${reconsiders ? `<span class="sep">·</span><span>decides again after <a class="caselink" href="#decisions/${esc(reconsiders.id)}">case ${esc(reconsiders.id)}</a>: ${esc(c.data.reconsider_reason ?? "")}</span>` : ""}</div></div>
      <div class="pf-actions"><span class="pill ${esc(c.outcome.tone)}">${esc(c.outcome.label)}</span>
        <a class="btn small" href="#${esc(c.id)}">${icon("doc")} Case</a><a class="btn small" href="#replay/${esc(c.id)}">${icon("reroute")} Walk through</a><a class="btn small accent" href="#proofs/${esc(c.id)}">${icon("lock")} Decision proof</a></div>
    </div>
    ${waiting ? `<div class="banner person">${icon("hand")}<span>Waiting on <b>${esc(waiting.approver ?? "a person")}</b> on a Switch card: ${esc(String(waiting.step).replace(/_/g, " "))}.</span></div>` : ""}
    <section class="dr-sec"><h3>${icon("code")} The alternatives, as code checked them</h3>
      <p class="fine">The margin is for the first contract year: a year of revenue after the discount, against a year of the GPU-hours and the one-off rollout team. Margins, capacity and rules are computed by code from the room's <code>policy</code>, <code>commitments</code> and <code>capacity</code> documents. Nothing an agent estimated is used. A proposal that breaks a rule is never offered on a card; only an alternative that passes is.</p>
      ${alternatives(c, checks)}</section>
    <section class="dr-sec"><h3>${icon("bot")} Four views, not a vote</h3>
      <div class="dr-views">${views.length ? views.map((v) => `<div class="dr-view"><div class="dr-view-head"><b>${esc(v.role)}</b><span class="mono t-muted">${esc(v.agent)}</span>${state.vendors?.[v.agent] ? `<span class="vendor v-${esc(state.vendors[v.agent])}">${esc(state.vendors[v.agent])}</span>` : ""}</div>
        ${v.value?.unavailable ? `<span class="pill stop">could not answer</span><p class="fine">${esc(v.value.reason ?? "")}</p>` : `<span class="pill ${v.value?.position === "accept" ? "act" : v.value?.position === "decline" ? "stop" : "person"}">${esc(v.value?.position ?? "?")}</span><p class="fine">${plural((v.value?.objections ?? []).length, "objection")}</p>`}</div>`).join("") : '<p class="fine">No view recorded yet.</p>'}</div></section>
    <section class="dr-sec"><h3>${icon("flag")} Dissent ledger</h3>
      <p class="fine">Code checks that each objection's quote is in the proposal, and marks where. That makes it grounded, not right: whether the objection holds is for the people who decide.</p>
      ${typeof c.data.text === "string" ? `<blockquote class="pf-text">${marked(c.data.text, ledger)}</blockquote>` : ""}
      <table class="pf-table dr-ledger"><thead><tr><th>from</th><th>objection</th><th>quote, where it is</th><th>weight</th><th>status</th></tr></thead><tbody>${ledger
        .map((l) => `<tr class="${l.from === "code" ? "code" : ""}"><td><b>${esc(l.from)}</b></td><td>${esc(l.claim)}</td><td>${l.quote ? `<code>${esc(l.quote)}</code> ${l.grounded ? `<span class="mono t-accent">${l.grounded.start}–${l.grounded.end}</span>` : '<span class="t-stop">not in the proposal</span>'}` : '<span class="t-muted">code</span>'}</td><td><span class="pill ${l.materiality === "binding" ? "stop" : l.materiality === "high" ? "person" : "neutral"}">${esc(l.materiality)}</span></td><td>${esc(l.status)}</td></tr>`)
        .join("") || '<tr><td colspan="5" class="fine">Not recorded yet.</td></tr>'}</tbody></table></section>
    <div class="dr-split">
      <section class="dr-sec"><h3>${icon("hand")} Authority</h3><ul class="dr-auth">${gates
        .map((e) => (e.type === "card_reopened" ? `<li class="bad">${icon("x")} an answer on <b>${esc(String(e.step).replace(/_/g, " "))}</b> was refused: four eyes</li>` : `<li>${icon("user")} <b>${esc(e.answeredBy)}</b> chose <span class="pill ${e.approved ? "act" : "stop"}">${esc(e.answer)}</span> on <b>${esc(String(e.step).replace(/_/g, " "))}</b> <span class="fine">${esc(stamp(e.at_iso))}</span></li>`))
        .join("") || '<li class="fine">Nobody has decided yet.</li>'}</ul></section>
      <section class="dr-sec"><h3>${icon("send")} What it did</h3><ul class="dr-auth">${done.map((e) => `<li>${icon("check", "t-act")} ${esc(e.receipt)} <span class="fine">${hx(e.hash, 12)}</span></li>`).join("") || '<li class="fine">Nothing yet: actions run only after both people sign.</li>'}</ul></section>
    </div>
    <section class="dr-sec"><h3>${icon("clock")} Assumption Watch</h3>${watch(c, flow, state.cases)}</section>`;
}

export function renderDecisions(state, ui) {
  if (!state.loaded) return `<div class="skeleton" style="height:420px"></div>`;
  const cases = state.cases.filter(isDecision).sort((a, b) => (b.openedAt ?? "").localeCompare(a.openedAt ?? ""));
  if (!cases.length) return `<div class="empty-state card">${icon("hand")}<h2>No decisions yet</h2><p>Send one with <code>npm run switchyard demo send contract-proposal</code>, or run <code>npm run demo:offline -- --serve</code>.</p></div>`;
  const c = cases.find((x) => x.id === ui.id) ?? cases[0];
  const items = cases
    .map((x) => {
      const d = stepsOf(x).dissent;
      return `<li><button class="pf-pick" data-decision="${esc(x.id)}" aria-current="${x.id === c.id}"><span class="t">${esc(x.data.customer ?? x.title)}${x.data.reconsider ? ' <span class="pill person">decided again</span>' : ""}</span><span class="s"><span class="pill ${esc(x.outcome.tone)}">${esc(x.outcome.label)}</span>${d ? `<span>${plural(d.open, "open objection")}</span>` : ""}<span class="mono">${esc(x.id)}</span></span></button></li>`;
    })
    .join("");
  return `<section class="lab-head"><h1>${icon("hand")} Decision Room</h1>
      <p class="fine">A consequential decision goes through the same controls as a payment: agents with separate jobs argue it, code checks it against the company's rules and what it has already promised, named people decide on Switch cards, the engine carries out exactly what they signed, and the decision is checked again when what it rested on changes.</p></section>
    <div class="pf-layout">
      <aside class="card pf-list"><h3>${icon("hand")} Decisions</h3><ol>${items}</ol></aside>
      <article class="card pf-main">${room(c, state)}</article>
    </div>`;
}

export function decisionClick(e, ui, rerender) {
  const pick = e.target.closest("[data-decision]");
  if (!pick) return;
  ui.id = pick.dataset.decision;
  setHash(`decisions/${ui.id}`);
  rerender();
}
