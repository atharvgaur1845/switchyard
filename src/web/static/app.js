// The Switchyard dashboard. Read-only: it shows what happened in the rooms
// and never decides anything; decisions are made on Switch cards. Case data
// comes from outside the company, so every value is escaped before it
// touches the page.

import { renderAgents } from "./agents.js";
import { renderCommand } from "./command.js";
import { diagram, left } from "./diagram.js";
import { esc, icon, INLET_ICON, STEP_ICON, hx, sameHash } from "./icons.js";
import { renderInvestigations, wireInvestigations } from "./investigations.js";
import { labClick, renderLab } from "./lab.js";
import { proofClick, proofDrop, renderProofs } from "./proofs.js";
import { renderReplay, replayChange, replayClick } from "./replay.js";
import { api, receiptsOf as receipts, token } from "./views.js";

// Every view, by the hash that opens it. A bare case id opens that case.
const VIEWS = ["command", "cases", "investigations", "agents", "proofs", "lab", "flows", "replay"];
const routeOf = (hash) => {
  const [view, arg] = hash.replace(/^#/, "").split("/");
  return VIEWS.includes(view) ? { view, arg } : view ? { view: "cases", arg: view } : { view: "command" };
};

// How to read a flow's diagram, under each one.
const LEGEND = `<ul class="legend" aria-label="Legend">
  <li><i class="sw agent"></i>agent</li><li><i class="sw person"></i>a person decides</li><li><i class="sw act"></i>executed</li>
  <li><i class="sw stop"></i>stopped or refused</li><li><i class="sw code"></i>checked by code</li><li><i class="sw cond"></i>condition</li>
  <li><i class="sw arc"></i>approval bound to an exact action</li></ul>`;

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
  selected: routeOf(location.hash).view === "cases" ? (routeOf(location.hash).arg ?? null) : null,
  investigations: { clusters: [], totals: {} },
  ig: { cluster: null, edge: null, node: null, query: "", tone: "all", zoom: null },
  // Per-view state the views keep between redraws.
  ui: { command: {}, agents: {}, proofs: {}, lab: {}, replay: {} },
  proof: null,
  loaded: false,
  view: "command",
  tab: "story",
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

function statusPill(c, compact = false) {
  const { label, tone } = c.outcome;
  const live = c.status === "open" && tone !== "neutral";
  let text = label;
  if (c.waiting?.kind === "person" && c.waiting.approver) {
    // In the list the colour already says "a person"; the row names who and how long.
    text = compact ? c.waiting.approver : `${label} · ${c.waiting.approver}`;
    if (c.waiting.deadlineAt && !c.waiting.escalated) text += ` · ${left(c.waiting.deadlineAt)}${compact ? "" : " left"}`;
  }
  if (c.waiting?.kind === "agent") text = `${c.waiting.who}`;
  if (c.waiting?.kind === "wait") text = `Scheduled · ${new Date(c.waiting.until).toLocaleDateString()}`;
  return `<span class="pill ${tone}"><span class="dot${live ? " pulse" : ""}"></span>${esc(text)}</span>`;
}

// ---------- summary strip ----------

function renderKpis() {
  // Only what is proven counts: a payment matches when the bank's own copy
  // hashes to the approved action, not when a rule ran and nothing was read.
  const payments = state.cases.flatMap((c) => receiptsOf(c).filter((r) => r.kind === "executed" && r.payload?.pay));
  const proven = payments.filter((r) => r.readback !== undefined && sameHash(r.readback, r.hash)).length;
  const stopped = state.cases.filter((c) => /^(Blocked|Held|Callback failed)/.test(c.outcome?.label ?? "")).length;
  const tiles = [
    ["open", state.cases.filter((c) => c.status === "open").length, "yard"],
    ["need a person", state.cases.filter((c) => bucket(c) === "person").length, "person"],
    ["payments sent", payments.length, "act"],
    ["bank copy = approval", `${proven}/${payments.length}`, "act"],
    ["stopped before money moved", stopped, "stop"],
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
        <span class="when">${statusPill(c, true)}<span class="mini-track" aria-hidden="true">${track}</span></span>
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
    ${linkedHtml(c)}
    <div class="diagram" id="diagram">${flow ? diagram(flow, c, state.vendors) : ""}</div>
    ${LEGEND}
    ${receiptsHtml(c)}
    <div class="dtabs" role="tablist" aria-label="Case views">
      <button role="tab" data-tab="story" aria-selected="${state.tab === "story"}">Story</button>
      <button role="tab" data-tab="raw" aria-selected="${state.tab === "raw"}">Raw log <span class="n">${c.events.length}</span></button>
    </div>
    ${state.tab === "raw" ? rawLog(c) : `<div class="grid2">
      <section class="panel"><h3>What happened</h3><ol class="timeline">${timeline(c)}</ol></section>
      <section class="panel">
        <h3>From outside the company</h3>
        <div class="quarantine">
          <div class="q-head"><span class="pill stop">Untrusted data</span><span class="meta">Agents receive this fenced, as material to work on, never as instructions.</span></div>
          ${c.data.flagged ? `<div class="flags">${icon("flag")} Screen flagged: ${(c.data.flags ?? []).map((f) => `<span class="pill stop">${esc(f)}</span>`).join(" ")}</div>` : ""}
          <dl>${Object.entries(c.data).filter(([k]) => k !== "flagged" && k !== "flags").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${isMoneyField(k) ? money(v) : esc(Array.isArray(v) ? v.join(", ") : v)}</dd>`).join("")}</dl>
        </div>
      </section>
    </div>`}`;
}

function banners(c) {
  const out = [];
  // When code overrules what the agents said, say so first: it is why a
  // person was asked. The latest result of each check counts (re-checks).
  const checks = new Map();
  for (const e of c.events) if (e.type === "verified") checks.set(e.step, e);
  const failed = [...checks.values()].filter((e) => e.value?.ok === false);
  if (failed.length) {
    const answered = c.events.find((e) => e.type === "answered" && e.value && typeof e.value === "object" && e.value.agreed === true);
    const roles = answered && stepOf(c, answered.step)?.roles;
    const lead = !answered ? "Code found" : roles ? "Code checked what the agents said, and found" : "The checkers agreed, but code found";
    const then = c.status === "open" ? "so nothing runs on a rule: a person decides" : "so nothing ran on a rule: a person decided";
    out.push(`<div class="banner stop">${icon("code")}<span>${lead}: ${failed.map((e) => `<b>${esc(e.value.detail)}</b>`).join("; ")}; ${then}.</span></div>`);
  }
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

function timeline(c) {
  let lastAgent = null;
  const items = [];
  for (const e of c.events) {
    const at = `<time datetime="${esc(e.at_iso)}">${clock(e.at_iso)}</time>`;
    const row = (cls, actor, avatar, text, extra = "") =>
      items.push(`<li class="ev"><span class="avatar ${cls}">${avatar}</span><div><div class="line1"><span class="actor">${actor}</span><span class="body">${caseLinks(text)}</span>${at}</div>${extra}</div></li>`);
    const step = e.step ? stepOf(c, e.step) : undefined;
    const name = esc(step?.label ?? e.step ?? "");
    switch (e.type) {
      case "opened":
        row("", "Inlet", icon(INLET_ICON[flowOf(c.flow)?.inlets[0]?.kind] ?? "form"), `opened the case: ${esc(c.source || "outside")}`);
        break;
      case "asked":
        if (!e.parallel) lastAgent = e.agent;
        if (!e.parallel || e.attempt > 1) row("", "@yard", icon("yard"), `asked <b>${esc(e.agent)}</b> ${vendorBadge(e.agent)} for <b>${name}</b>${e.tries > 1 ? ` <span class="pill neutral">retry ${e.tries}</span>` : ""}`, docRefs(e.docs));
        break;
      case "verified":
        row(e.value?.ok ? "act" : "stop", "code", icon("code"), `checked <b>${name}</b> (${esc(e.check)}): ${esc(e.value?.detail ?? "")}${e.docs ? ` ${Object.entries(e.docs).map(([d, h]) => (d.startsWith("links:") ? `<span class="docref">${icon("link")}links on ${esc(d.slice(6))}: <b>${esc(h === "none" ? "none" : h)}</b></span>` : `<span class="docref">${icon("doc")}${esc(d)}${e.rows?.[d] ? ` (${esc(e.rows[d])}'s row)` : ""} ${hx(h, 12)}</span>`)).join(" ")}` : ""}`);
        break;
      case "fanned_out":
        row("", "@yard", icon("fork"), `asked ${e.agents.map((a) => `<b>${esc(a)}</b> ${vendorBadge(a)}`).join(" and ")} to do <b>${name}</b> independently`);
        break;
      case "partial":
        row(e.value?.unavailable ? "stop" : "agent", esc(e.agent), initials(e.agent), e.value?.unavailable ? `could not check <b>${name}</b>: ${esc(e.value.reason)}` : `answered <b>${name}</b>`, e.value?.unavailable ? "" : result(e.value));
        break;
      case "answered":
        if (e.value && typeof e.value === "object" && "agreed" in e.value && stepOf(c, e.step)?.roles) {
          const jobs = Object.entries(stepOf(c, e.step).roles).map(([a, t]) => `${esc(a)} as <b>${esc(t)}</b>`).join(" and ");
          row(e.value.complete ? "act" : "stop", "@yard", icon(e.value.complete ? "check" : "alert"), e.value.complete ? `${jobs} both answered on ${name}; code checks what they said next` : `an agent could not answer on ${name}, so a person decides`);
        } else if (e.value && typeof e.value === "object" && "agreed" in e.value) {
          row(e.value.agreed ? "act" : "stop", "@yard", icon(e.value.agreed ? "check" : "alert"), e.value.agreed ? `the checkers <b>agreed</b> on ${name}` : `the checkers <b>did not agree</b> on ${name}, so a person decides`);
          break;
        }
        row("agent", esc(lastAgent ?? "agent"), initials(lastAgent ?? "ag"), `finished <b>${name}</b>`, result(e.value));
        break;
      case "reply_rejected": {
        // In a parallel step the error names the agent ("@checker: ...").
        const who = /^(@[\w.-]+):\s*/.exec(e.error ?? "");
        const agent = who?.[1] ?? lastAgent ?? "agent";
        row("stop", esc(agent), initials(agent), `reply not accepted: ${esc(who ? e.error.slice(who[0].length) : e.error)}`);
        break;
      }
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
      case "rewound":
        row("stop", "@yard", icon("reroute"), `would not act on <b>${name}</b>: ${Object.entries(e.docs ?? {}).map(([d, [was, now]]) => (d.startsWith("links:") ? `the links on <b>${esc(d.slice(6))}</b> went from <b>${esc(was)}</b> to <b>${esc(now)}</b>` : `<b>${esc(d)}</b> changed ${hx(was, 12)} → ${hx(now, 12)}`)).join(", ")} after the checks read it, so the checks run again and any earlier approval no longer counts`);
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

// Which version of each room document an agent was working from.
function docRefs(docs) {
  if (!docs || !Object.keys(docs).length) return "";
  return `<div class="docrefs">${Object.entries(docs).map(([d, h]) => `<span class="docref">${icon("doc")}${esc(d)} ${hx(h, 12)}</span>`).join("")}</div>`;
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

// ---------- raw log: the events exactly as stored ----------

// Every event of the case in storage order. `seq` is the log's own
// autoincrement key, so gaps would show and order cannot be rewritten.
function rawLog(c) {
  const rows = c.events
    .map((e) => {
      const { seq, at_iso, type, step, ...rest } = e;
      const json = JSON.stringify(rest);
      const body = json === "{}" ? "" : json.length > 140 ? `<details><summary><code>${esc(json.slice(0, 140))}…</code></summary><pre>${esc(JSON.stringify(rest, null, 2))}</pre></details>` : `<code>${esc(json)}</code>`;
      return `<tr><td class="num mono">${seq}</td><td class="mono">${esc(String(at_iso).replace("T", " ").replace(/\.\d+Z$/, "Z"))}</td><td><span class="evt t-${esc(type)}">${esc(type)}</span></td><td class="mono">${esc(step ?? "")}</td><td class="raw-body">${body}</td></tr>`;
    })
    .join("");
  return `<section class="raw" aria-label="Raw event log">
    <div class="raw-head"><p>The case's append-only log, as stored. Its state anywhere on this page is a fold of these rows.</p>
      <span><button class="btn small" data-export="${esc(c.id)}">${icon("doc")} Export case-${esc(c.id)}.jsonl</button>
      <a class="btn small" href="/api/proof/${encodeURIComponent(c.id)}${token ? `?token=${encodeURIComponent(token)}` : ""}" download>${icon("lock")} Download signed proof</a></span></div>
    <div class="raw-scroll"><table class="rawtable"><thead><tr><th class="num">seq</th><th>recorded (UTC)</th><th>type</th><th>step</th><th>body</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function exportCase(id) {
  const c = state.cases.find((x) => x.id === id);
  if (!c) return;
  const blob = new Blob([c.events.map((e) => JSON.stringify(e)).join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `case-${id}.jsonl` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- receipts: what was approved, and what was done ----------

// "case 1c5cc185" in any story line becomes a link when that case is here.
function caseLinks(html) {
  return html.replace(/\bcase ([0-9a-f]{8})\b/g, (m, id) => (state.cases.some((x) => x.id === id) ? `<a class="caselink" href="#${id}">case ${id}</a>` : m));
}

// Cases this one is linked to through an account, from its links check.
function linkedHtml(c) {
  const links = c.events.filter((e) => e.type === "verified" && e.check === "links").at(-1)?.value?.links ?? [];
  if (!links.length) return "";
  const items = links.map((l) => {
    const other = l.caseId && state.cases.find((x) => x.id === l.caseId);
    const target = other ? `<a class="caselink" href="#${other.id}">${esc(other.title)}</a> <span class="pill ${other.outcome?.tone ?? "neutral"}">${esc(other.outcome?.label ?? "")}</span>` : "";
    return `<li><code>${esc(l.iban)}</code> ${l.role === "printed" ? "(printed on the invoice, never paid)" : ""}: ${caseLinks(esc(l.detail))}${target ? `<div>${target}</div>` : ""}</li>`;
  });
  return `<section class="linked" aria-label="Linked cases"><h4>${icon("link")} Linked across cases, by code</h4><ul>${items.join("")}</ul><p class="fine">A link never blocks a payment by itself: it sends the case to a person, and an approval given before a link appeared no longer counts.</p></section>`;
}

const receiptsOf = (c) => receipts(c, stepOf);

function receiptsHtml(c) {
  const cards = receiptsOf(c).map((r) => {
    const label = esc(stepOf(c, r.step)?.label ?? r.step);
    if (r.kind === "declined") {
      return `<div class="receipt neutral"><h4>${icon("hand")} ${label}: nothing was done</h4>
        <p>${asRole(r.by, stepOf(c, r.gate)?.who)} chose <b>${esc(r.answer)}</b> on the card for approval ${hx(r.hash)}.</p></div>`;
    }
    if (r.kind === "blocked") {
      return `<div class="receipt bad"><h4>${icon("x")} ${label}: blocked</h4><p>${esc(r.reason)}. Nothing was sent.</p></div>`;
    }
    const approved = r.approval
      ? `<div class="hash"><div class="k">Approved by ${asRole(r.approval.by, stepOf(c, r.approval.gate)?.who)}</div>${hx(r.approval.hash)}</div>`
      : `<div class="hash"><div class="k">Rule</div><code class="rule">${esc(r.rule === true ? "always" : (r.rule ?? "auto"))}</code></div>`;
    const sign = r.approval ? (r.match ? icon("lock", "t-act") : icon("x", "t-stop")) : icon("reroute", "t-muted");
    // Where the money went, next to where the invoice asked for it to go.
    const pay = r.payload?.pay;
    const asked = typeof c.data.iban === "string" && c.data.iban.trim() ? c.data.iban.replace(/\s+/g, "").toUpperCase() : null;
    const where = pay
      ? `<div class="where">
          <div><div class="k">The invoice asked for</div><code>${esc(asked ?? "no account printed")}</code></div>
          <div><div class="k">Paid to${sameHash(r.readback, r.hash) ? ", as the bank holds it" : ""}</div><code>${esc(pay.to)}</code> <span class="pill act">vendor master</span></div>
          ${asked && asked !== pay.to ? `<p class="fine">The invoice's account was not used: payments go only to the account on file.</p>` : ""}
        </div>`
      : "";
    return `<div class="receipt ${r.match === false ? "bad" : ""}">
      <h4>${icon(r.match === false ? "x" : "check")} ${label}: ${esc(r.receipt)}</h4>
      ${where}
      <div class="hashes">${approved}<span class="eq" aria-label="${r.match ? "matches" : r.match === false ? "does not match" : "by rule"}">${sign}</span>
        <div class="hash"><div class="k">Sent</div>${hx(r.hash)}</div>
        ${r.readback ? `<span class="eq">${sameHash(r.readback, r.hash) ? icon("lock", "t-act") : icon("x", "t-stop")}</span><div class="hash"><div class="k">Read back from the bank <span class="pill neutral">sandbox</span></div>${hx(r.readback)}</div>` : ""}</div>
      ${r.approval || r.readback ? `<p class="fine">${r.match ? `${r.approval ? "What was sent hashes to exactly what the approver saw on the card" : "What was sent matched the rule"}${r.readback ? ", and the bank's own copy of the payment hashes the same" : ""}.` : "The hashes differ: Switchyard treats this as in doubt and asks a person."}</p>` : ""}
    </div>`;
  });
  const proof = `<p class="fine">${icon("lock")} <a href="/api/proof/${encodeURIComponent(c.id)}${token ? `?token=${encodeURIComponent(token)}` : ""}" download>Download this case's signed proof</a>: its evidence, decisions and actions in one file. Check it with no model, Switch or bank: <code>npm run switchyard verify-proof &lt;file&gt;</code>.</p>`;
  return cards.length ? `<section class="receipts" aria-label="Receipts">${cards.join("")}${proof}</section>` : "";
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
        <div class="fc-meta">
        <div class="fc-head"><h2>${esc(f.description)}</h2>${f.running ? '<span class="pill act"><span class="dot"></span>Running</span>' : ""}</div>
        <div class="room"><span class="mono">${esc(f.flow)}</span> · #${esc(f.room)}${schedule?.next ? ` · next run ${new Date(schedule.next).toLocaleString()}` : ""}</div>
        <div class="inlets">${inletText}</div>
        <details class="step-list"><summary>Steps as a list</summary><ol class="steps">${steps}</ol></details>
        ${f.running ? `<div class="links"><a href="#" data-flow-filter="${esc(f.flow)}">${counts.open} open · ${counts.done} done · ${counts.stopped} stopped</a>${links}</div>` : off}
        </div>
        <div class="diagram">${diagram(f, null, state.vendors)}</div>
        ${LEGEND}
      </article>`;
    })
    .join("");
}

// ---------- wiring ----------

function render() {
  renderIgCount();
  const view = (id) => document.getElementById(`view-${id}`);
  if (state.view === "cases") {
    renderKpis();
    renderFilters();
    renderList();
    renderDetail();
  } else if (state.view === "command") {
    state.ui.command.hero = hero(state.cases);
    view("command").innerHTML = renderCommand(state, state.ui.command);
  } else if (state.view === "investigations") {
    view("investigations").innerHTML = renderInvestigations(state.investigations, state.ig, state.cases);
  } else if (state.view === "agents") {
    view("agents").innerHTML = renderAgents(state, state.ui.agents);
  } else if (state.view === "proofs") {
    view("proofs").innerHTML = renderProofs(state, state.ui.proofs, render);
  } else if (state.view === "lab") {
    view("lab").innerHTML = renderLab(state.ui.lab, render);
  } else if (state.view === "replay") {
    state.ui.replay.id ??= hero(state.cases);
    view("replay").innerHTML = renderReplay(state, state.ui.replay, render);
  } else {
    renderFlows();
  }
}

async function refresh() {
  const live = document.getElementById("live");
  try {
    const [overview, cases, investigations] = await Promise.all([api("/api/overview"), api("/api/cases"), api("/api/investigations")]);
    live.className = "live on";
    document.getElementById("live-text").textContent = `Live · ${cases.length} case${cases.length === 1 ? "" : "s"}`;
    document.body.classList.remove("offline");
    // Only redraw when something changed, so selections, focus and scroll
    // positions survive polling.
    const signature = JSON.stringify([overview, cases, investigations]);
    if (signature === state.signature) return;
    state.signature = signature;
    Object.assign(state, { flows: overview.flows, schedules: overview.schedules, vendors: overview.vendors, people: overview.people, proof: overview.proof, cases, investigations, loaded: true });
    if (!state.selected && cases.length) state.selected = hero(cases) ?? visibleCases()[0]?.id ?? null;
    render();
  } catch (error) {
    live.className = "live off";
    document.getElementById("live-text").textContent = `Disconnected (${error.message}): showing the last data`;
    document.body.classList.add("offline");
  }
}

// The case a first-time visitor sees: the payment story first (an approval
// that stopped counting, then a bank check), since it shows the most at once.
function hero(cases) {
  const newest = (list) => list.sort((a, b) => (b.openedAt ?? "").localeCompare(a.openedAt ?? ""))[0]?.id;
  const invoices = cases.filter((c) => c.flow === "invoice-check");
  return (
    newest(invoices.filter((c) => c.events.some((e) => e.type === "rewound"))) ??
    newest(invoices.filter((c) => c.events.some((e) => e.type === "verified" && e.check === "vendor_bank"))) ??
    newest(cases.filter((c) => c.flow === "bank-change")) ??
    newest(invoices.filter((c) => c.events.some((e) => e.type === "fanned_out")))
  );
}

function select(id) {
  if (!id) return;
  state.selected = id;
  history.replaceState(null, "", `#${id}${location.search}`);
  if (state.view !== "cases") return showView("cases");
  render();
  if (matchMedia("(max-width: 900px)").matches) document.getElementById("detail").scrollIntoView({ block: "start" });
}

document.getElementById("filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  render();
});
document.getElementById("detail").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    renderDetail();
  }
  const exp = e.target.closest("[data-export]");
  if (exp) exportCase(exp.dataset.export);
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

function showView(view, arg) {
  state.view = view;
  if (view === "cases") {
    if (arg) state.selected = arg;
    history.replaceState(null, "", state.selected ? `#${state.selected}${location.search}` : `#cases${location.search}`);
  } else history.replaceState(null, "", `#${view}${arg ? `/${arg}` : ""}${location.search}`);
  if (view === "proofs" && arg) state.ui.proofs.id = arg;
  if (view === "replay") state.ui.replay.id = arg ?? state.ui.replay.id ?? hero(state.cases);
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view || (view === "replay" && b.dataset.view === "command"))));
  for (const v of VIEWS) document.getElementById(`view-${v}`).hidden = v !== view;
  document.getElementById("kpis").hidden = view !== "cases";
  render();
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-view]");
  if (tab) showView(tab.dataset.view);
});
// A link to #<case id> opens that case; #<view>/<arg> opens a view on a case.
window.addEventListener("hashchange", () => {
  const { view, arg } = routeOf(location.hash);
  showView(view, arg);
});

{
  const { view, arg } = routeOf(location.hash);
  showView(view, arg);
}

document.getElementById("view-command").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-stream]");
  if (!chip) return;
  state.ui.command.stream = chip.dataset.stream;
  render();
});
document.getElementById("view-proofs").addEventListener("click", (e) => proofClick(e, state, state.ui.proofs, render));
document.getElementById("view-proofs").addEventListener("change", (e) => proofDrop(e, state.ui.proofs, render));
document.getElementById("view-proofs").addEventListener("drop", (e) => proofDrop(e, state.ui.proofs, render));
document.getElementById("view-proofs").addEventListener("dragover", (e) => e.preventDefault());
document.getElementById("view-lab").addEventListener("click", (e) => labClick(e, state.ui.lab, render));
document.getElementById("view-lab").addEventListener("input", (e) => labClick(e, state.ui.lab, render));
document.getElementById("view-replay").addEventListener("click", (e) => replayClick(e, state, state.ui.replay, render));
document.getElementById("view-replay").addEventListener("change", (e) => replayChange(e, state.ui.replay, render));
document.getElementById("view-agents").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-ag]");
  const job = e.target.closest("[data-job]");
  if (tab) state.ui.agents.tab = tab.dataset.ag;
  if (job) state.ui.agents.job = job.dataset.job;
  if (tab || job) render();
});

// Investigations: groups, nodes, lines, search, filters, zoom and pan.
wireInvestigations(document.getElementById("view-investigations"), state, render);

function renderIgCount() {
  const n = state.investigations.clusters.length;
  const el = document.getElementById("ig-count");
  el.hidden = n === 0;
  el.textContent = String(n);
}

refresh();
setInterval(refresh, 2500);
// The clocks move even when no event arrives: redraw just the diagram.
setInterval(() => {
  const c = state.cases.find((x) => x.id === state.selected);
  const el = document.getElementById("diagram");
  if (c?.status === "open" && el && flowOf(c.flow)) el.innerHTML = diagram(flowOf(c.flow), c, state.vendors);
  if (state.view === "cases") renderList();
}, 30_000);
