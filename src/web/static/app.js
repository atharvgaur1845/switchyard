// The Switchyard dashboard. Read-only: it shows what happened in the rooms
// and never decides anything; decisions are made on Switch cards. Case data
// comes from outside the company, so every value is escaped before it
// touches the page.

const token = new URLSearchParams(location.search).get("token");
const api = (path) =>
  fetch(path + (token ? `?token=${encodeURIComponent(token)}` : "")).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- icons (Lucide paths, ISC licence) ----------

const PATHS = {
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  form: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9M12 12v3"/>',
  reroute: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  yard: '<path d="M3 21V14c0-3 2-5 5-5h13"/><path d="M3 14V3"/><path d="M17 5l4 4-4 4"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
};
const icon = (name, cls = "") =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;

const INLET_ICON = { form: "form", email: "mail", schedule: "calendar", webhook: "webhook", frontdesk: "message" };
const STEP_ICON = { agent: "bot", parallel: "fork", gate: "hand", outlet: "send", wait: "clock" };

// ---------- state ----------

const FILTERS = [
  ["all", "All"],
  ["person", "Needs a person"],
  ["agent", "Agents working"],
  ["wait", "Scheduled"],
  ["done", "Done"],
  ["stopped", "Stopped"],
];

const state = {
  flows: [],
  cases: [],
  people: {},
  vendors: {},
  filter: "all",
  query: "",
  selected: location.hash.slice(1) || null,
  view: "cases",
  signature: "",
};

// ---------- helpers ----------

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const when = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const initials = (handle) => esc(String(handle).replace(/^@/, "").slice(0, 2).toUpperCase());
const money = (n) => (typeof n === "number" ? n.toLocaleString("en", { maximumFractionDigits: 2 }) : esc(n));
const isMoneyField = (k) => /amount|total|unit|price|po_amount/i.test(k);

const flowOf = (name) => state.flows.find((f) => f.flow === name);
const stepOf = (c, id) => flowOf(c.flow)?.steps.find((s) => s.id === id);
const vendorBadge = (handle) => {
  const v = state.vendors[handle];
  return v ? `<span class="vendor v-${esc(v)}">${esc(v)}</span>` : "";
};

// Which role a person was acting in, from switchyard.yaml `people:`.
function asRole(handle, role) {
  if (!role || handle === role) return esc(handle);
  return `${esc(handle)} <span class="as">as ${esc(role)}</span>`;
}

function bucket(c) {
  if (c.status === "done") return "done";
  if (c.status === "failed" || c.status === "cancelled") return "stopped";
  if (c.waiting?.kind === "wait") return "wait";
  return c.waiting?.kind === "person" ? "person" : "agent";
}

function statusPill(c) {
  const { label, tone } = c.outcome;
  const live = c.status === "open" && tone !== "neutral";
  let text = label;
  if (c.waiting?.kind === "person" && c.waiting.approver) text = `${label} · ${c.waiting.approver}`;
  if (c.waiting?.kind === "agent") text = `${c.waiting.who}`;
  if (c.waiting?.kind === "wait") text = `Scheduled · ${new Date(c.waiting.until).toLocaleDateString()}`;
  return `<span class="pill ${tone}"><span class="dot${live ? " pulse" : ""}"></span>${esc(text)}</span>`;
}

// ---------- summary strip ----------

function renderKpis() {
  const executed = state.cases.reduce((n, c) => n + c.events.filter((e) => e.type === "executed").length, 0);
  const verified = state.cases.reduce((n, c) => n + receiptsOf(c).filter((r) => r.kind === "executed" && r.match !== false).length, 0);
  const held = state.cases.filter((c) => c.data.flagged).length;
  const tiles = [
    ["open", state.cases.filter((c) => c.status === "open").length, "yard"],
    ["need a person", state.cases.filter((c) => bucket(c) === "person").length, "person"],
    ["actions executed", executed, "act"],
    ["receipts match", `${verified}/${executed}`, "act"],
    ["injections held", held, "stop"],
  ];
  document.getElementById("kpis").innerHTML = tiles
    .map(([label, value, tone]) => `<div class="kpi"><span class="value t-${tone}">${value}</span><span class="label">${label}</span></div>`)
    .join("");
}

// ---------- list ----------

function renderFilters() {
  const count = (k) => (k === "all" ? state.cases.length : state.cases.filter((c) => bucket(c) === k).length);
  document.getElementById("filters").innerHTML = FILTERS.map(
    ([key, label]) =>
      `<button class="chip" role="radio" data-filter="${key}" aria-checked="${state.filter === key}">${label}<span class="n">${count(key)}</span></button>`,
  ).join("");
}

// Needs attention first: held for a person (soonest deadline first), then
// agents working, then scheduled, then finished (newest first).
const ORDER = { person: 0, agent: 1, wait: 2, stopped: 3, done: 4 };
function visibleCases() {
  const q = state.query.toLowerCase();
  return state.cases
    .filter((c) => state.filter === "all" || bucket(c) === state.filter)
    .filter((c) => !q || `${c.id} ${c.flow} ${c.title} ${JSON.stringify(c.data)}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const d = ORDER[bucket(a)] - ORDER[bucket(b)];
      if (d) return d;
      if (bucket(a) === "person") return (a.waiting?.deadlineAt ?? Infinity) - (b.waiting?.deadlineAt ?? Infinity);
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
}

function renderList() {
  const list = document.getElementById("case-list");
  const focused = document.activeElement?.closest?.(".case-row")?.dataset.id;
  const cases = visibleCases();
  if (cases.length === 0) {
    list.innerHTML = `<li class="empty-state small"><p>${state.cases.length ? "No cases match." : "No cases yet. Submit a form, send an email, or run <code>npm run switchyard demo send quote</code>."}</p></li>`;
    return;
  }
  list.innerHTML = cases
    .map((c) => {
      const inlet = flowOf(c.flow)?.inlets[0]?.kind;
      const track = c.stations.map((s) => `<i class="${s.status} k-${s.kind}"></i>`).join("");
      return `<li class="case-row" data-id="${esc(c.id)}" aria-current="${c.id === state.selected}" tabindex="0">
        <span class="glyph">${icon(INLET_ICON[inlet] ?? "form")}</span>
        <span class="row-main"><span class="t">${c.data.flagged ? icon("flag", "t-stop") : ""}${esc(c.title)}</span>
          <span class="s">${esc(flowOf(c.flow)?.description ?? c.flow)} · <span class="mono">${esc(c.id)}</span></span></span>
        <span class="when">${statusPill(c)}<span class="mini-track" aria-hidden="true">${track}</span></span>
      </li>`;
    })
    .join("");
  if (focused) list.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus();
}

// ---------- detail ----------

function renderDetail() {
  const el = document.getElementById("detail");
  const c = state.cases.find((x) => x.id === state.selected);
  if (!c) {
    el.innerHTML = state.selected
      ? `<div class="empty-state"><h2>No case <code>${esc(state.selected)}</code></h2><p>It may belong to another Switchyard, or the link is mistyped.</p></div>`
      : document.getElementById("empty-detail").innerHTML;
    return;
  }
  const flow = flowOf(c.flow);
  el.innerHTML = `
    <div class="d-head">
      <div>
        <h1>${esc(c.title)}</h1>
        <div class="meta">
          <span class="pill neutral">${esc(flow?.description ?? c.flow)}</span>
          ${c.source ? `<span>${/^(email|webhook|web|website|schedule|@)/.test(c.source) ? "" : "from "}${esc(c.source)}</span><span class="sep">·</span>` : ""}
          <span title="${esc(c.openedAt)}">opened ${ago(c.openedAt)}</span><span class="sep">·</span>
          <span class="mono">${esc(c.id)}</span><span class="sep">·</span><span>#${esc(flow?.room ?? "")}</span>
        </div>
      </div>
      ${statusPill(c)}
    </div>
    ${c.excerpt ? `<blockquote class="excerpt">${esc(c.excerpt)}</blockquote>` : ""}
    ${banners(c)}
    <div class="track" role="list" aria-label="Steps">${stationsHtml(c)}</div>
    ${receiptsHtml(c)}
    <div class="grid2">
      <section class="panel"><h3>What happened</h3><ol class="timeline">${timeline(c)}</ol></section>
      <section class="panel">
        <h3>From outside the company</h3>
        <div class="quarantine">
          <div class="q-head"><span class="pill stop">Untrusted data</span><span class="meta">Agents receive this fenced, as material to work on, never as instructions.</span></div>
          ${c.data.flagged ? `<div class="flags">${icon("flag")} Screen flagged: ${(c.data.flags ?? []).map((f) => `<span class="pill stop">${esc(f)}</span>`).join(" ")}</div>` : ""}
          <dl>${Object.entries(c.data).filter(([k]) => k !== "flagged" && k !== "flags").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${isMoneyField(k) ? money(v) : esc(Array.isArray(v) ? v.join(", ") : v)}</dd>`).join("")}</dl>
        </div>
      </section>
    </div>`;
}

function banners(c) {
  const out = [];
  if (c.data.flagged) {
    out.push(`<div class="banner stop">${icon("flag")}<span>The injection screen flagged <b>${(c.data.flags ?? []).length}</b> pattern${(c.data.flags ?? []).length === 1 ? "" : "s"}. The agent still saw the text only inside the fence, and nothing reaches the visitor without a person.</span></div>`);
  }
  const w = c.waiting;
  if (w?.kind === "person" && w.doubt) {
    out.push(`<div class="banner stop">${icon("alert")}<span>Switchyard stopped mid-action and cannot tell whether <b>${esc(w.step)}</b> happened. It will not repeat it on its own: the approver decides on a card.</span></div>`);
  } else if (w?.kind === "person" && w.deadlineAt) {
    const next = w.escalated ? "has been escalated" : w.escalateTo ? `escalates to <b>${esc(w.escalateTo)}</b> at ${when(w.deadlineAt)}` : `is overdue at ${when(w.deadlineAt)}`;
    out.push(`<div class="banner person">${icon("hand")}<span>Waiting on <b>${esc(w.approver)}</b> in Slack; reminder at ${when(w.remindAt)}, then it ${next}.</span></div>`);
  }
  if (w?.kind === "agent" && w.slaAt) {
    out.push(`<div class="banner agent">${icon("bot")}<span><b>${esc(w.who)}</b> is working on <b>${esc(w.step)}</b>; if it has not answered by ${clock(w.slaAt)}${w.bench ? `, the step moves to <b>${esc(w.bench)}</b> ${vendorBadge(w.bench)}` : ", a person takes over"}.</span></div>`);
  }
  for (const e of c.events.filter((e) => e.type === "failed_over")) {
    out.push(`<div class="banner agent">${icon("reroute")}<span><b>${esc(e.from)}</b> ${vendorBadge(e.from)} → <b>${esc(e.to)}</b> ${vendorBadge(e.to)} on <b>${esc(e.step)}</b>: ${esc(e.reason)}.</span></div>`);
  }
  return out.join("");
}

function stationsHtml(c) {
  return c.stations
    .map((s) => {
      const step = stepOf(c, s.id);
      const label = { done: "done", skipped: "skipped", current: "in progress", todo: "not reached", stopped: "stopped here" }[s.status];
      const who = step?.agents?.length > 1 ? step.agents.join(" + ") : (step?.who ?? "");
      const node = s.status === "done" ? icon("check") : s.status === "stopped" ? icon("x") : icon(STEP_ICON[s.kind]);
      return `<div class="station ${s.status} k-${s.kind}" role="listitem" title="${esc(s.id)}: ${label}">
        <div class="node">${node}</div>
        <div class="name">${esc(step?.label ?? s.id)}</div>
        <div class="who">${esc(who)}${s.status === "skipped" ? " · skipped" : ""}</div>
      </div>`;
    })
    .join("");
}

function timeline(c) {
  let lastAgent = null;
  const items = [];
  for (const e of c.events) {
    const at = `<time datetime="${esc(e.at_iso)}">${clock(e.at_iso)}</time>`;
    const row = (cls, actor, avatar, text, extra = "") =>
      items.push(`<li class="ev"><span class="avatar ${cls}">${avatar}</span><div><div class="line1"><span class="actor">${actor}</span><span class="body">${text}</span>${at}</div>${extra}</div></li>`);
    const step = e.step ? stepOf(c, e.step) : undefined;
    const name = esc(step?.label ?? e.step ?? "");
    switch (e.type) {
      case "opened":
        row("", "Inlet", icon(INLET_ICON[flowOf(c.flow)?.inlets[0]?.kind] ?? "form"), `opened the case: ${esc(c.source || "outside")}`);
        break;
      case "asked":
        if (!e.parallel) lastAgent = e.agent;
        if (!e.parallel || e.attempt > 1) row("", "@yard", icon("yard"), `asked <b>${esc(e.agent)}</b> ${vendorBadge(e.agent)} for <b>${name}</b>${e.tries > 1 ? ` <span class="pill neutral">retry ${e.tries}</span>` : ""}`);
        break;
      case "fanned_out":
        row("", "@yard", icon("fork"), `asked ${e.agents.map((a) => `<b>${esc(a)}</b> ${vendorBadge(a)}`).join(" and ")} to do <b>${name}</b> independently`);
        break;
      case "partial":
        row(e.value?.unavailable ? "stop" : "agent", esc(e.agent), initials(e.agent), e.value?.unavailable ? `could not check <b>${name}</b>: ${esc(e.value.reason)}` : `answered <b>${name}</b>`, e.value?.unavailable ? "" : result(e.value));
        break;
      case "answered":
        if (e.value && typeof e.value === "object" && "agreed" in e.value) {
          row(e.value.agreed ? "act" : "stop", "@yard", icon(e.value.agreed ? "check" : "alert"), e.value.agreed ? `the checkers <b>agreed</b> on ${name}` : `the checkers <b>did not agree</b> on ${name}, so a person decides`);
          break;
        }
        row("agent", esc(lastAgent ?? "agent"), initials(lastAgent ?? "ag"), `finished <b>${name}</b>`, result(e.value));
        break;
      case "reply_rejected":
        row("stop", esc(lastAgent ?? "agent"), initials(lastAgent ?? "ag"), `reply not accepted: ${esc(e.error)}`);
        break;
      case "failed_over":
        row("stop", "@yard", icon("reroute"), `moved <b>${name}</b> from ${esc(e.from)} to <b>${esc(e.to)}</b> ${vendorBadge(e.to)} <span class="meta">(${esc(e.reason)})</span>`);
        break;
      case "skipped":
        if (step?.when) row("", "@yard", icon("reroute"), `skipped <b>${name}</b>: <code>${esc(step.when)}</code> was false`);
        break;
      case "gate_opened":
        row("person", "@yard", icon("hand"), `put an approval card in front of <b>${esc(e.approver)}</b> for <b>${name}</b>`);
        break;
      case "reminded":
        row("person", "@yard", icon("clock"), `reminded the approver of <b>${name}</b>`);
        break;
      case "escalated":
        row("person", "@yard", icon("clock"), `escalated <b>${name}</b>${e.to ? ` to <b>${esc(e.to)}</b>` : ""}`);
        break;
      case "card_reopened":
        row("stop", "@yard", icon("x"), `refused an answer from someone who is not the approver, and re-opened the card`);
        break;
      case "gate_answered":
        row(e.approved ? "act" : "stop", asRole(e.answeredBy, step?.who), initials(e.answeredBy), `chose <b>${esc(e.answer)}</b> for <b>${name}</b>`);
        break;
      case "executing":
        break;
      case "executed":
        row("act", "@yard", icon("send"), esc(e.receipt));
        break;
      case "in_doubt":
        row("stop", "@yard", icon("alert"), `could not tell whether <b>${name}</b> happened, and asked a person`);
        break;
      case "doubt_resolved":
        row("person", esc(e.answeredBy), initials(e.answeredBy), `answered <b>${esc(e.answer)}</b>`);
        break;
      case "failed":
        row("stop", "@yard", icon("x"), `stopped at <b>${name}</b>: ${esc(e.reason)}`);
        break;
      case "cancelled":
        row("stop", esc(e.by), icon("x"), "cancelled the case");
        break;
      case "waiting":
        row("", "@yard", icon("clock"), `waiting until ${esc(new Date(e.until).toLocaleString())}`);
        break;
      case "waited":
        row("", e.by ? esc(e.by) : "@yard", e.by ? initials(e.by) : icon("clock"), e.by ? "ended the wait early" : "the wait is over");
        break;
      case "done":
        row("act", "@yard", icon("check"), "closed the case");
        break;
    }
  }
  return items.join("");
}

// Agent results: arrays of objects become tables, text keeps its line
// breaks, figures are formatted.
function result(value) {
  if (!value || typeof value !== "object") return "";
  return `<div class="result"><dl>${Object.entries(value).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${valueHtml(k, v)}</dd>`).join("")}</dl></div>`;
}

function valueHtml(key, v) {
  if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    const cols = [...new Set(v.flatMap((x) => Object.keys(x)))];
    const head = cols.map((c) => `<th class="${isMoneyField(c) || c === "qty" ? "num" : ""}">${esc(c)}</th>`).join("");
    const rows = v.map((x) => `<tr>${cols.map((c) => `<td class="${isMoneyField(c) || c === "qty" ? "num" : ""}">${isMoneyField(c) ? money(x[c]) : esc(x[c])}</td>`).join("")}</tr>`).join("");
    return `<table class="mini"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (Array.isArray(v)) return `<ul>${v.map((x) => `<li>${esc(typeof x === "object" ? JSON.stringify(x) : x)}</li>`).join("")}</ul>`;
  if (v && typeof v === "object") return result(v);
  if (typeof v === "number" && isMoneyField(key)) return `<span class="num">${money(v)}</span>`;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return `<span class="text">${esc(v)}</span>`;
}

// ---------- receipts: what was approved, and what was done ----------

function receiptsOf(c) {
  const out = [];
  const approvals = {};
  let gate = null;
  for (const e of c.events) {
    if (e.type === "gate_opened") gate = e;
    if (e.type === "gate_answered" && gate) {
      for (const [step, hash] of Object.entries(gate.hashes)) approvals[step] = { hash, by: e.answeredBy, answer: e.answer, approved: e.approved, gate: e.step, payload: gate.payloads?.[step] };
      if (!e.approved) for (const [step, hash] of Object.entries(gate.hashes)) out.push({ kind: "declined", step, hash, ...approvals[step] });
    }
    if (e.type === "executed") {
      const a = approvals[e.step];
      out.push({ kind: "executed", step: e.step, approval: a, hash: e.hash, receipt: e.receipt, payload: e.payload, match: a ? a.hash === e.hash : undefined, rule: stepOf(c, e.step)?.autoRule });
    }
    if (e.type === "failed" && /approved/.test(e.reason)) out.push({ kind: "blocked", step: e.step, reason: e.reason });
  }
  return out;
}

function receiptsHtml(c) {
  const cards = receiptsOf(c).map((r) => {
    const label = esc(stepOf(c, r.step)?.label ?? r.step);
    if (r.kind === "declined") {
      return `<div class="receipt neutral"><h4>${icon("hand")} ${label}: nothing was done</h4>
        <p>${asRole(r.by, stepOf(c, r.gate)?.who)} chose <b>${esc(r.answer)}</b> on the card for approval <code>${esc(r.hash)}</code>.</p></div>`;
    }
    if (r.kind === "blocked") {
      return `<div class="receipt bad"><h4>${icon("x")} ${label}: blocked</h4><p>${esc(r.reason)}. Nothing was sent.</p></div>`;
    }
    const approved = r.approval
      ? `<div class="hash"><div class="k">Approved by ${asRole(r.approval.by, stepOf(c, r.approval.gate)?.who)}</div><code>${esc(r.approval.hash)}</code></div>`
      : `<div class="hash"><div class="k">Rule</div><code class="rule">${esc(r.rule === true ? "always" : (r.rule ?? "auto"))}</code></div>`;
    const sign = r.approval ? (r.match ? icon("lock", "t-act") : icon("x", "t-stop")) : icon("reroute", "t-muted");
    return `<div class="receipt ${r.match === false ? "bad" : ""}">
      <h4>${icon(r.match === false ? "x" : "check")} ${label}: ${esc(r.receipt)}</h4>
      <div class="hashes">${approved}<span class="eq" aria-label="${r.match ? "matches" : r.match === false ? "does not match" : "by rule"}">${sign}</span>
        <div class="hash"><div class="k">Executed</div><code>${esc(r.hash)}</code></div></div>
      ${r.approval ? `<p class="fine">${r.match ? "The executed action hashes to exactly what the approver saw on the card." : "The hashes differ: this should never happen, and Switchyard would have refused it."}</p>` : ""}
    </div>`;
  });
  return cards.length ? `<section class="receipts" aria-label="Receipts">${cards.join("")}</section>` : "";
}

// ---------- flows ----------

function renderFlows() {
  const sorted = [...state.flows].sort((a, b) => Number(b.running) - Number(a.running));
  document.getElementById("flow-grid").innerHTML = sorted
    .map((f) => {
      const schedule = state.schedules?.find((s) => s.flow === f.flow);
      const counts = { open: 0, done: 0, stopped: 0 };
      for (const c of state.cases.filter((c) => c.flow === f.flow)) counts[c.status === "open" ? "open" : c.status === "done" ? "done" : "stopped"]++;
      const links = f.inlets
        .map(({ kind }) => (kind === "form" ? `<a href="/f/${esc(f.flow)}" target="_blank" rel="noopener">Open form ↗</a>` : kind === "frontdesk" ? `<a href="/chat" target="_blank" rel="noopener">Open chat widget ↗</a>` : ""))
        .join("");
      const inletText = f.inlets
        .map(({ kind, spec }) => {
          const detail = kind === "email" ? spec.to : kind === "schedule" ? spec.cron : kind === "webhook" ? `POST /in/${f.flow}` : "";
          return `<span class="inlet">${icon(INLET_ICON[kind] ?? "form")} ${esc(kind)}${detail ? ` <span class="mono">${esc(detail)}</span>` : ""}</span>`;
        })
        .join("");
      const steps = f.steps
        .map((s) => {
          const who = s.agents?.length > 1 ? s.agents.map((a) => `${esc(a)} ${vendorBadge(a)}`).join(" + ") : `${esc(s.who ?? "")} ${s.who ? vendorBadge(s.who) : ""}`;
          const notes = [s.sla && `SLA ${s.sla}`, s.deadline && `deadline ${s.deadline}`, s.backup && `→ ${esc(s.backup)} ${vendorBadge(s.backup)}`, s.autoRule && "auto rule", s.when && "conditional"].filter(Boolean).join(" · ");
          return `<li><span class="k ${s.kind}">${icon(STEP_ICON[s.kind])}</span><span><b>${esc(s.label)}</b> <span class="note">${who}</span></span><span class="note">${notes}</span></li>`;
        })
        .join("");
      const off = `<div class="setup"><span class="pill neutral">Not set up</span><code>npm run switchyard setup-local ${esc(f.flow)}</code></div>`;
      return `<article class="flow-card card${f.running ? "" : " off"}">
        <div class="fc-head"><h2>${esc(f.description)}</h2>${f.running ? '<span class="pill act"><span class="dot"></span>Running</span>' : ""}</div>
        <div class="room"><span class="mono">${esc(f.flow)}</span> · #${esc(f.room)}${schedule?.next ? ` · next run ${new Date(schedule.next).toLocaleString()}` : ""}</div>
        <div class="inlets">${inletText}</div>
        <ol class="steps">${steps}</ol>
        ${f.running ? `<div class="links"><a href="#" data-flow-filter="${esc(f.flow)}">${counts.open} open · ${counts.done} done · ${counts.stopped} stopped</a>${links}</div>` : off}
      </article>`;
    })
    .join("");
}

// ---------- wiring ----------

function render() {
  renderKpis();
  if (state.view === "cases") {
    renderFilters();
    renderList();
    renderDetail();
  } else {
    renderFlows();
  }
}

async function refresh() {
  const live = document.getElementById("live");
  try {
    const [overview, cases] = await Promise.all([api("/api/overview"), api("/api/cases")]);
    live.className = "live on";
    document.getElementById("live-text").textContent = `Live · ${cases.length} case${cases.length === 1 ? "" : "s"}`;
    document.body.classList.remove("offline");
    // Only redraw when something changed, so selections, focus and scroll
    // positions survive polling.
    const signature = JSON.stringify([overview, cases]);
    if (signature === state.signature) return;
    state.signature = signature;
    Object.assign(state, { flows: overview.flows, schedules: overview.schedules, vendors: overview.vendors, people: overview.people, cases });
    if (!state.selected && cases.length) state.selected = visibleCases()[0]?.id ?? null;
    render();
  } catch (error) {
    live.className = "live off";
    document.getElementById("live-text").textContent = `Disconnected (${error.message}): showing the last data`;
    document.body.classList.add("offline");
  }
}

function select(id) {
  if (!id) return;
  state.selected = id;
  history.replaceState(null, "", `#${id}${location.search}`);
  render();
  if (matchMedia("(max-width: 900px)").matches) document.getElementById("detail").scrollIntoView({ block: "start" });
}

document.getElementById("filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  render();
});
document.getElementById("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderList();
});
const list = document.getElementById("case-list");
list.addEventListener("click", (e) => select(e.target.closest(".case-row")?.dataset.id));
list.addEventListener("keydown", (e) => {
  const row = e.target.closest(".case-row");
  if (!row) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select(row.dataset.id);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling)?.focus();
  }
});
document.getElementById("flow-grid").addEventListener("click", (e) => {
  const link = e.target.closest("[data-flow-filter]");
  if (!link) return;
  e.preventDefault();
  state.query = link.dataset.flowFilter;
  document.getElementById("search").value = state.query;
  showView("cases");
});

function showView(view) {
  state.view = view;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  document.getElementById("view-cases").hidden = view !== "cases";
  document.getElementById("view-flows").hidden = view !== "flows";
  document.getElementById("kpis").hidden = view !== "cases";
  render();
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-view]");
  if (tab) showView(tab.dataset.view);
});
// A link to #<case id> opens that case.
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id) select(id) || showView("cases");
});

refresh();
setInterval(refresh, 2500);
