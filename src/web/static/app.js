// The Switchyard dashboard. Read-only: it shows what happened in the rooms
// and never decides anything. Case data comes from outside the company, so
// every value is escaped before it touches the page.

const token = new URLSearchParams(location.search).get("token");
const api = (path) =>
  fetch(path + (token ? `?token=${encodeURIComponent(token)}` : "")).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FILTERS = [
  ["all", "All"],
  ["person", "Waiting on people"],
  ["agent", "Agents working"],
  ["done", "Done"],
  ["stopped", "Stopped"],
];

const INLET_ICON = { form: "▤", email: "✉", schedule: "◷", webhook: "⇄", frontdesk: "☏" };
const STEP_ICON = { agent: "✦", gate: "✋", outlet: "↗" };

const state = { flows: [], cases: [], filter: "all", query: "", selected: location.hash.slice(1) || null, view: "cases" };

// ---------- helpers ----------

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const initials = (handle) => esc(String(handle).replace(/^@/, "").slice(0, 2).toUpperCase());

function bucket(c) {
  if (c.status === "done") return "done";
  if (c.status === "failed" || c.status === "cancelled") return "stopped";
  return c.waiting?.kind === "person" ? "person" : "agent";
}

function statusPill(c) {
  const b = bucket(c);
  if (b === "done") return `<span class="pill act"><span class="dot"></span>Done</span>`;
  if (b === "stopped") return `<span class="pill stop"><span class="dot"></span>${c.status === "cancelled" ? "Cancelled" : "Stopped"}</span>`;
  if (b === "person") return `<span class="pill person"><span class="dot pulse"></span>${c.waiting?.escalated ? "Escalated" : "Needs a person"}</span>`;
  return `<span class="pill agent"><span class="dot pulse"></span>${esc(c.waiting?.who ?? "Working")}</span>`;
}

function flowOf(name) {
  // Includes flows that are not set up, so old cases still find their flow.
  return state.flows.find((f) => f.flow === name);
}

// ---------- KPIs ----------

function renderKpis() {
  const executed = state.cases.flatMap((c) => c.events.filter((e) => e.type === "executed"));
  const auto = state.cases.reduce((n, c) => n + autoApprovedSteps(c).length, 0);
  const tiles = [
    ["Open cases", state.cases.filter((c) => c.status === "open").length, "var(--yard)"],
    ["Waiting on people", state.cases.filter((c) => bucket(c) === "person").length, "var(--person)"],
    ["Agents working", state.cases.filter((c) => bucket(c) === "agent").length, "var(--agent)"],
    ["Completed", state.cases.filter((c) => c.status === "done").length, "var(--act)"],
    ["Actions executed", executed.length, "var(--act)"],
    ["Auto-approved by rule", auto, "var(--muted)"],
  ];
  document.getElementById("kpis").innerHTML = tiles
    .map(([label, value, color]) => `<div class="kpi card"><div class="label"><i style="background:${color}"></i>${label}</div><div class="value">${value}</div></div>`)
    .join("");
}

function autoApprovedSteps(c) {
  const gated = new Set(c.events.filter((e) => e.type === "gate_opened").flatMap((e) => Object.keys(e.hashes)));
  return c.events.filter((e) => e.type === "executed" && !gated.has(e.step));
}

// ---------- list ----------

function renderFilters() {
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === "all" ? state.cases.length : state.cases.filter((c) => bucket(c) === k).length]));
  document.getElementById("filters").innerHTML = FILTERS.map(
    ([key, label]) =>
      `<button class="chip" role="radio" data-filter="${key}" aria-checked="${state.filter === key}">${label}<span class="n">${counts[key]}</span></button>`,
  ).join("");
}

function visibleCases() {
  const q = state.query.toLowerCase();
  return state.cases
    .filter((c) => state.filter === "all" || bucket(c) === state.filter)
    .filter((c) => !q || `${c.id} ${c.flow} ${c.title}`.toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function renderList() {
  const list = document.getElementById("case-list");
  const cases = visibleCases();
  if (cases.length === 0) {
    list.innerHTML = `<li class="empty-state" style="padding:40px 12px"><p>${state.cases.length ? "No cases match." : "No cases yet. Submit a form or send an email to start one."}</p></li>`;
    return;
  }
  list.innerHTML = cases
    .map((c) => {
      const inlet = flowOf(c.flow)?.inlets[0]?.kind;
      const track = c.stations
        .map((s) => `<i class="${s.status}${s.status === "current" && s.kind === "agent" ? " agent" : ""}"></i>`)
        .join("");
      return `<li class="case-row" data-id="${esc(c.id)}" aria-current="${c.id === state.selected}" tabindex="0">
        <span class="glyph" aria-hidden="true">${INLET_ICON[inlet] ?? "•"}</span>
        <span><div class="t">${esc(c.title)}</div><div class="s">${esc(flowOf(c.flow)?.description ?? c.flow)} · <span class="mono">${esc(c.id)}</span></div></span>
        <span class="when">${statusPill(c)}<span class="mini-track">${track}</span></span>
      </li>`;
    })
    .join("");
}

// ---------- detail ----------

function renderDetail() {
  const el = document.getElementById("detail");
  const c = state.cases.find((x) => x.id === state.selected);
  if (!c) {
    el.innerHTML = document.getElementById("empty-detail").innerHTML;
    return;
  }
  const flow = flowOf(c.flow);
  const steps = new Map((flow?.steps ?? []).map((s) => [s.id, s]));
  const stations = c.stations
    .map((s) => {
      const step = steps.get(s.id);
      const label = { done: "done", skipped: "skipped", current: "in progress", todo: "not reached", stopped: "stopped here" }[s.status];
      return `<div class="station ${s.status}${s.status === "current" && s.kind === "agent" ? " agent" : ""}" title="${esc(s.id)}: ${label}">
        <div class="node">${s.status === "done" ? "✓" : s.status === "stopped" ? "!" : STEP_ICON[s.kind]}</div>
        <div class="name">${esc(s.id)}</div>
        <div class="who">${esc(step?.who ?? "")}${s.status === "skipped" ? " · skipped" : ""}</div>
      </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="d-head">
      <div>
        <h1>${esc(c.title)}</h1>
        <div class="meta">
          <span class="pill">${esc(flow?.description ?? c.flow)}</span>
          ${c.source ? `<span>from ${esc(c.source)}</span><span class="sep">·</span>` : ""}
          <span title="${esc(c.openedAt)}">opened ${ago(c.openedAt)}</span><span class="sep">·</span>
          <span class="mono">${esc(c.id)}</span><span class="sep">·</span><span>#${esc(flow?.room ?? "")}</span>
        </div>
      </div>
      ${statusPill(c)}
    </div>
    <div class="track" role="list" aria-label="Steps">${stations}</div>
    ${receipts(c)}
    <div class="grid2">
      <section class="panel"><h3>What happened</h3><ol class="timeline">${timeline(c)}</ol></section>
      <section class="panel">
        <h3>From outside the company</h3>
        <div class="quarantine">
          <div class="q-head"><span class="pill stop">Untrusted data</span><span class="meta">Agents see this only as quoted material, never as instructions.</span></div>
          ${c.data.flagged ? `<div class="flags">Screen flagged: ${(c.data.flags ?? []).map((f) => `<span class="pill stop">⚑ ${esc(f)}</span>`).join(" ")}</div>` : ""}
          <dl>${Object.entries(c.data).filter(([k]) => k !== "flagged" && k !== "flags").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join(", ") : v)}</dd>`).join("")}</dl>
        </div>
      </section>
    </div>`;
}

function timeline(c) {
  let lastAgent = null;
  const items = [];
  for (const e of c.events) {
    const at = `<time datetime="${esc(e.at_iso)}">${clock(e.at_iso)}</time>`;
    const row = (cls, actor, avatar, text, extra = "") =>
      items.push(`<li class="ev"><span class="avatar ${cls}">${avatar}</span><div><div class="line1"><span class="actor">${actor}</span><span class="body">${text}</span>${at}</div>${extra}</div></li>`);
    switch (e.type) {
      case "opened":
        row("", "Inlet", "IN", `opened the case from ${esc(c.source || "outside")}`);
        break;
      case "asked":
        lastAgent = e.agent;
        row("", "@yard", "Y", `asked <b>${esc(e.agent)}</b> for <b>${esc(e.step)}</b>${e.attempt > 1 ? ` <span class="pill">attempt ${e.attempt}</span>` : ""}`);
        break;
      case "answered":
        row("agent", esc(lastAgent ?? "agent"), initials(lastAgent ?? "ag"), `finished <b>${esc(e.step)}</b>`, result(e.value));
        break;
      case "reply_rejected":
        row("stop", esc(lastAgent ?? "agent"), initials(lastAgent ?? "ag"), `reply not accepted: ${esc(e.error)}`);
        break;
      case "failed_over":
        row("stop", "@yard", "Y", `moved <b>${esc(e.step)}</b> from ${esc(e.from)} to <b>${esc(e.to)}</b> <span class="meta">(${esc(e.reason)})</span>`);
        break;
      case "gate_opened":
        row("person", "@yard", "Y", `asked <b>${esc(e.approver)}</b> to decide <b>${esc(e.step)}</b> on an approval card`);
        break;
      case "reminded":
        row("person", "@yard", "Y", `reminded the approver of <b>${esc(e.step)}</b>`);
        break;
      case "escalated":
        row("person", "@yard", "Y", `escalated <b>${esc(e.step)}</b>${e.to ? ` to <b>${esc(e.to)}</b>` : ""}`);
        break;
      case "card_reopened":
        row("stop", "@yard", "Y", `refused an answer from someone who is not the approver and re-opened the card`);
        break;
      case "gate_answered":
        row("person", esc(e.answeredBy), initials(e.answeredBy), `chose <b>${esc(e.answer)}</b> for <b>${esc(e.step)}</b>`);
        break;
      case "executed":
        row("act", "@yard", "↗", `${esc(e.receipt)}`);
        break;
      case "failed":
        row("stop", "@yard", "!", `stopped at <b>${esc(e.step)}</b>: ${esc(e.reason)}`);
        break;
      case "cancelled":
        row("stop", esc(e.by), initials(e.by), "cancelled the case");
        break;
      case "done":
        row("act", "@yard", "✓", "closed the case");
        break;
    }
  }
  return items.join("");
}

function result(value) {
  if (!value || typeof value !== "object") return "";
  const rows = Object.entries(value)
    .map(([k, v]) => {
      const shown = Array.isArray(v) ? `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : esc(v);
      return `<dt>${esc(k)}</dt><dd>${shown}</dd>`;
    })
    .join("");
  return `<div class="result"><dl>${rows}</dl></div>`;
}

// The "what you approved is what was sent" panel.
function receipts(c) {
  const approvals = {};
  let lastGate = null;
  for (const e of c.events) {
    if (e.type === "gate_opened") lastGate = e;
    if (e.type === "gate_answered" && lastGate) {
      for (const [step, hash] of Object.entries(lastGate.hashes)) approvals[step] = { hash, by: e.answeredBy, answer: e.answer };
    }
  }
  const cards = [];
  for (const e of c.events) {
    if (e.type === "executed") {
      const a = approvals[e.step];
      const how = a ? `Approved by <b>${esc(a.by)}</b>` : "Auto-approved by the flow's rule";
      cards.push(`<div class="receipt">
        <h4><span class="pill act">✓ Executed</span> ${esc(e.step)}</h4>
        <p>${how}. ${esc(e.receipt)}.</p>
        <div class="hashes">
          <div class="hash"><div class="k">${a ? "Approved" : "Rule matched"}</div><code>${esc(a?.hash ?? "—")}</code></div>
          <span class="eq" aria-label="matches">${a ? "=" : "→"}</span>
          <div class="hash"><div class="k">Executed</div><code>${esc(e.hash)}</code></div>
        </div>
      </div>`);
    }
    if (e.type === "failed" && /approved/.test(e.reason)) {
      cards.push(`<div class="receipt bad"><h4><span class="pill stop">Blocked</span> ${esc(e.step)}</h4><p>${esc(e.reason)}. Nothing was sent.</p></div>`);
    }
  }
  return cards.length ? `<section class="receipts">${cards.join("")}</section>` : "";
}

// ---------- flows ----------

function renderFlows() {
  const sorted = [...state.flows].sort((a, b) => Number(b.running) - Number(a.running));
  document.getElementById("flow-grid").innerHTML = sorted
    .map((f) => {
      const schedule = state.schedules?.find((s) => s.flow === f.flow);
      const links = f.inlets
        .map(({ kind }) => {
          if (kind === "form") return `<a href="/f/${esc(f.flow)}" target="_blank" rel="noopener">Open form ↗</a>`;
          if (kind === "frontdesk") return `<a href="/chat" target="_blank" rel="noopener">Open chat widget ↗</a>`;
          return "";
        })
        .join("");
      const inletText = f.inlets
        .map(({ kind, spec }) => {
          const detail = kind === "email" ? spec.to : kind === "schedule" ? spec.cron : kind === "webhook" ? `POST /in/${f.flow}` : "";
          return `<span class="pill">${INLET_ICON[kind] ?? ""} ${esc(kind)}${detail ? ` · <span class="mono">${esc(detail)}</span>` : ""}</span>`;
        })
        .join("");
      const steps = f.steps
        .map(
          (s) => `<li><span class="k ${s.kind}">${STEP_ICON[s.kind]}</span><span><b>${esc(s.id)}</b> <span class="note">${esc(s.who)}${s.backup ? ` → ${esc(s.backup)}` : ""}</span></span>
          <span class="note">${s.auto ? "auto-rule" : s.conditional ? "when…" : ""}</span></li>`,
        )
        .join("");
      const off = f.running ? "" : `<div class="setup"><span class="pill">Not set up</span><code>npm run switchyard setup-local ${esc(f.flow)}</code></div>`;
      return `<article class="flow-card card${f.running ? "" : " off"}">
        <div class="fc-head"><h2>${esc(f.description)}</h2>${f.running ? '<span class="pill act"><span class="dot"></span>Running</span>' : ""}</div>
        <div class="room" style="margin-top:-8px"><span class="mono">${esc(f.flow)}</span> · #${esc(f.room)}${schedule?.next ? ` · next run ${new Date(schedule.next).toLocaleString()}` : ""}</div>
        <div class="inlets">${inletText}</div>
        <ol class="steps">${steps}</ol>
        ${f.running ? `<div class="links">${links}</div>` : off}
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
    state.flows = overview.flows;
    state.schedules = overview.schedules;
    state.cases = cases;
    if (!state.selected && cases.length) state.selected = visibleCases()[0]?.id ?? null;
    live.className = "live on";
    document.getElementById("live-text").textContent = `Live · ${cases.length} case${cases.length === 1 ? "" : "s"}`;
    render();
  } catch (error) {
    live.className = "live off";
    document.getElementById("live-text").textContent = `Can't reach Switchyard (${error.message})`;
  }
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
const select = (row) => {
  if (!row) return;
  state.selected = row.dataset.id;
  history.replaceState(null, "", `#${state.selected}${location.search}`);
  render();
};
document.getElementById("case-list").addEventListener("click", (e) => select(e.target.closest(".case-row")));
document.getElementById("case-list").addEventListener("keydown", (e) => {
  if (e.key === "Enter") select(e.target.closest(".case-row"));
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
  if (!id) return;
  state.selected = id;
  showView("cases");
});

refresh();
setInterval(refresh, 2500);
