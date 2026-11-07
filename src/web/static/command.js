// The Command Center: what Switchyard is protecting right now, counted from
// the event log. Every number links to the cases it counts.

import { esc, icon } from "./icons.js";
import { checksOf, describe, money, paymentsOf, plural, stamp } from "./views.js";

const STREAM = [
  ["all", "All"],
  ["agent", "Agents"],
  ["code", "Code"],
  ["person", "People"],
  ["action", "Actions"],
];

const isStopped = (c) => /^(Blocked|Held|Callback failed|Rejected|Disputed)/.test(c.outcome?.label ?? "");

export function commandFacts(state) {
  const cases = state.cases;
  const events = cases.flatMap((c) => c.events.map((e) => ({ ...e, caseId: c.id })));
  const verified = events.filter((e) => e.type === "verified");
  const payee = cases.map((c) => ({ c, v: checksOf(c).payee })).filter((x) => x.v);
  const payments = cases.flatMap(paymentsOf);
  const evidence = verified.filter((e) => e.check === "agent_evidence");
  return {
    cases,
    events,
    open: cases.filter((c) => c.status === "open"),
    waiting: cases.filter((c) => c.status === "open" && c.waiting?.kind === "person"),
    stopped: cases.filter(isStopped),
    payee,
    mismatches: payee.filter((x) => !["match", "mandate"].includes(x.v.result)),
    payments,
    proven: payments.filter((p) => p.proven),
    proofs: cases.filter((c) => c.events.some((e) => e.type === "executed")),
    chain: [
      { k: "Arrives", icon: "mail", n: cases.length, sub: `${plural(cases.length, "case")} from email, webhooks and forms`, view: "#cases" },
      { k: "Agents read", icon: "bot", n: events.filter((e) => e.type === "partial" || (e.type === "answered" && !("agreed" in (e.value ?? {})))).length, sub: `answers · ${events.filter((e) => e.type === "reply_rejected" || e.value?.unavailable).length} refused or unavailable`, view: "#agents" },
      { k: "Quotes grounded", icon: "doc", n: evidence.reduce((n, e) => n + (e.value?.quotes?.length ?? 0) + (e.value?.findings?.length ?? 0), 0), sub: `quotes at their offsets · ${evidence.reduce((n, e) => n + (e.value?.dropped?.length ?? 0), 0)} dropped`, view: "#agents" },
      { k: "Code checks", icon: "code", n: verified.length, sub: `${verified.filter((e) => e.value?.ok === false).length} failed`, view: "#agents" },
      { k: "Bank names holder", icon: "user", n: payee.length, sub: `${payee.filter((x) => x.v.result === "match" || x.v.result === "mandate").length} confirmed · ${payee.length - payee.filter((x) => x.v.result === "match" || x.v.result === "mandate").length} not`, view: "#investigations", sandbox: true },
      { k: "Promises and other cases", icon: "link", n: verified.filter((e) => (e.check === "links" || e.check === "commitments") && e.value?.ok === false).length, sub: `conflicts found · ${events.filter((e) => e.type === "rewound").length} approvals voided`, view: "#commitments" },
      { k: "People decide", icon: "hand", n: events.filter((e) => e.type === "gate_answered").length, sub: `answers on Switch cards · ${events.filter((e) => e.type === "card_reopened").length} refused`, view: "#cases" },
      { k: "Bank executes", icon: "send", n: payments.length, sub: `payments · ${payments.filter((p) => p.proven).length} read back equal`, view: "#proofs", sandbox: true },
      { k: "Signed proof", icon: "lock", n: cases.filter((c) => c.events.some((e) => e.type === "executed")).length, sub: "cases with actions, each with a proof", view: "#proofs" },
    ],
  };
}

function tile(label, value, tone, sub, href) {
  return `<a class="cc-tile tone-${tone}" href="${href}"><span class="cc-v">${value}</span><span class="cc-l">${esc(label)}</span><span class="cc-s">${sub}</span></a>`;
}

export function renderCommand(state, ui) {
  if (!state.loaded) return `<div class="cc-loading"><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:320px"></div></div>`;
  const f = commandFacts(state);
  const ig = state.investigations.totals ?? {};
  const paidSum = f.payments.reduce((n, p) => n + p.amount, 0);
  const byResult = (r) => f.payee.filter((x) => x.v.result === r).length;
  const decisions = f.cases.filter((c) => c.events.some((e) => e.type === "verified" && e.check === "dissent"));
  const openObjections = decisions.filter((c) => c.status === "open").reduce((n, c) => n + (checksOf(c).dissent?.open ?? 0), 0);
  const broken = f.events.filter((e) => e.type === "assumption_broken");
  const tiles = [
    tile("Waiting on a person", f.waiting.length, "person", f.waiting.length ? f.waiting.slice(0, 2).map((c) => esc(c.waiting.approver ?? "a person")).join(", ") + (f.waiting.length > 2 ? "…" : "") : "nobody is waiting", "#cases"),
    tile("Open objections", openObjections, openObjections ? "person" : "act", `on ${plural(decisions.filter((c) => c.status === "open").length, "open decision")}`, "#decisions"),
    tile("Broken assumptions", broken.length, broken.length ? "person" : "act", broken.length ? `decided again in ${broken.map((e) => esc(e.reopened)).join(", ")}` : "every carried-out decision still holds", "#commitments"),
    tile("Active investigations", ig.clusters ?? 0, "stop", `${plural(ig.open ?? 0, "open case")} touching them`, "#investigations"),
    tile("Beneficiary mismatches", f.mismatches.length, f.mismatches.length ? "person" : "act", `${byResult("close_match")} close · ${byResult("no_match")} no match · ${byResult("unavailable")} no answer`, "#investigations"),
    tile("Stopped before money moved", f.stopped.length, "stop", "blocked, held, refused or disputed", "#cases"),
    tile("Verified payments", `${f.proven.length}<small>/${f.payments.length}</small>`, "act", `${money(paidSum)} EUR · bank copy = approved action`, "#proofs"),
    tile("Signed proofs", f.proofs.length, "accent", state.proof ? `key ${esc(state.proof.fingerprint.slice(0, 12))}…` : "unsigned: no key loaded", "#proofs"),
  ];

  const chain = f.chain
    .map((s, i) => `<a class="cc-stage" href="${s.view}"><span class="cc-step">${String(i + 1).padStart(2, "0")}</span>${icon(s.icon)}<b>${esc(s.k)}</b><span class="cc-n">${s.n}</span><span class="cc-sub">${esc(s.sub)}</span>${s.sandbox ? '<span class="tag sandbox">sandbox</span>' : ""}</a>`)
    .join('<span class="cc-arrow" aria-hidden="true"></span>');

  const kind = ui.stream ?? "all";
  const stream = f.events
    .map((e) => ({ e, d: describe(e) }))
    .filter(({ d }) => d && (kind === "all" || d.kind === kind))
    .sort((a, b) => (b.e.at_iso ?? "").localeCompare(a.e.at_iso ?? "") || (b.e.seq ?? 0) - (a.e.seq ?? 0))
    .slice(0, 60);
  const streamHtml = stream.length
    ? stream.map(({ e, d }) => `<li class="t-${d.tone}"><time>${esc(stamp(e.at_iso))}</time><span class="dot"></span><span class="who">${esc(d.who ?? "")}</span><span class="what">${esc(d.text)}</span><a class="caselink mono" href="#${esc(e.caseId)}">${esc(e.caseId)}</a></li>`).join("")
    : `<li class="cc-empty">Nothing of this kind yet.</li>`;

  // Outcomes, by the tone the case list uses.
  const outcomes = new Map();
  for (const c of f.cases) {
    const k = c.outcome?.label ?? "Unknown";
    const o = outcomes.get(k) ?? { n: 0, tone: c.outcome?.tone ?? "neutral" };
    o.n++;
    outcomes.set(k, o);
  }
  const total = f.cases.length || 1;
  const sorted = [...outcomes.entries()].sort((a, b) => b[1].n - a[1].n);
  const bar = sorted.map(([label, o]) => `<span class="seg tone-${o.tone}" style="flex:${o.n}" title="${esc(label)}: ${o.n}"></span>`).join("");
  const legend = sorted.map(([label, o]) => `<li><i class="tone-${o.tone}"></i>${esc(label)}<b>${o.n}</b><span>${Math.round((o.n / total) * 100)}%</span></li>`).join("");
  const flows = [...new Set(f.cases.map((c) => c.flow))].map((fl) => `<li><span class="mono">${esc(fl)}</span><b>${f.cases.filter((c) => c.flow === fl).length}</b></li>`).join("");

  const answers = f.events
    .filter((e) => e.type === "gate_answered")
    .sort((a, b) => (b.at_iso ?? "").localeCompare(a.at_iso ?? ""))
    .slice(0, 8)
    .map((e) => `<li><span class="pill ${e.approved ? (e.answer === "block" || e.answer === "hold" ? "stop" : "act") : "stop"}">${esc(e.answer)}</span><span><b>${esc(e.answeredBy)}</b> on ${esc(String(e.step).replace(/_/g, " "))}</span><a class="caselink mono" href="#${esc(e.caseId)}">${esc(e.caseId)}</a></li>`)
    .join("");

  const count = (t) => f.events.filter((e) => e.type === t).length;
  const last = f.events.map((e) => e.at_iso).sort().at(-1);
  const health = [
    ["Flows running", state.flows.filter((x) => x.running).length, "act"],
    ["Agent hand-offs to a backup", count("failed_over"), count("failed_over") ? "person" : "act"],
    ["Agent replies refused", count("reply_rejected"), count("reply_rejected") ? "person" : "act"],
    ["Actions in doubt", f.cases.filter((c) => c.waiting?.doubt).length, f.cases.some((c) => c.waiting?.doubt) ? "stop" : "act"],
    ["Escalations", count("escalated"), count("escalated") ? "person" : "act"],
  ];
  const agents = Object.entries(state.vendors ?? {});

  return `
  <section class="cc-hero">
    <div>
      <h1>Company decisions and payments, carried out only with proof.</h1>
      <p>Agents investigate and argue, each with its own job. Code checks every claim against the company's rules, what it has already promised, and the bank. Named people decide on Switch cards, and the engine does exactly what they signed. It checks again when the facts a decision rested on change, and signs the whole record.</p>
      <p class="fine">${icon("alert")} The bank, its payee answers, the suppliers, the customer and the company's capacity are sandbox data. Switch, the agents and the people are real when this runs live.</p>
    </div>
    <div class="cc-hero-side">
      <div class="cc-ctas">${(() => {
        const d = decisions.find((c) => c.events.some((e) => e.type === "executed"));
        return d ? `<a class="btn accent" href="#replay/${esc(d.id)}">${icon("reroute")} Walk through a decision</a>` : "";
      })()}<a class="btn" href="#replay/${esc(ui.hero ?? "")}" ${ui.hero ? "" : 'aria-disabled="true"'}>${icon("reroute")} Walk through a payment</a></div>
      <div class="cc-key">${state.proof ? `<span>${icon("lock")} Proofs signed by key <code title="${esc(state.proof.fingerprint)}">${esc(state.proof.fingerprint.slice(0, 16))}…</code></span><span class="fine">pinned: ${esc(state.proof.from)}</span>` : `<span>${icon("lock")} No signing key loaded: proofs are unsigned</span>`}</div>
    </div>
  </section>
  <section class="cc-tiles" aria-label="Summary">${tiles.join("")}</section>
  <section class="card cc-chain-card" aria-label="How a payment is controlled">
    <h3>How a payment is controlled · counted from the log</h3>
    <div class="cc-chain">${chain}</div>
  </section>
  <div class="cc-grid">
    <section class="card cc-stream">
      <div class="cc-head"><h3>${icon("clock")} Event stream</h3>
        <div class="chips" role="radiogroup" aria-label="Show events">${STREAM.map(([k, l]) => `<button class="chip" role="radio" data-stream="${k}" aria-checked="${kind === k}">${l}</button>`).join("")}</div></div>
      <ol class="cc-events">${streamHtml}</ol>
    </section>
    <div class="cc-side">
      <section class="card cc-panel"><h3>${icon("fork")} Case outcomes</h3>
        <div class="cc-bar">${bar}</div><ul class="cc-legend">${legend}</ul>
        <h4>By flow</h4><ul class="cc-flows">${flows}</ul></section>
      <section class="card cc-panel"><h3>${icon("hand")} Recent answers on cards</h3>${answers ? `<ul class="cc-decisions">${answers}</ul>` : '<p class="fine">No one has answered a card yet.</p>'}</section>
      <section class="card cc-panel"><h3>${icon("check")} Operational health</h3>
        <ul class="cc-health">${health.map(([l, v, t]) => `<li><span>${esc(l)}</span><b class="t-${t}">${v}</b></li>`).join("")}
          <li><span>Last event</span><b>${esc(last ? stamp(last) : "none")}</b></li></ul>
        ${agents.length ? `<h4>Agents Switchyard runs</h4><ul class="cc-agents">${agents.map(([h, v]) => `<li><span class="mono">${esc(h)}</span><span class="vendor v-${esc(v)}">${esc(v)}</span></li>`).join("")}</ul>` : ""}
      </section>
    </div>
  </div>`;
}
