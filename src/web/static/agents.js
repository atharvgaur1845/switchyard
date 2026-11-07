// Agent intelligence: what each agent was asked, what it answered, how long
// it took, and what code and people did with it. Read from the event log;
// agents answer one fenced request in JSON with their tools switched off, so
// there are no tool calls to show, and no reasoning is recorded or shown.

import { esc, hx, icon } from "./icons.js";
import { receiptsOf, seconds, stamp, tree } from "./views.js";

const TABS = [
  ["agents", "Agents", "bot"],
  ["checks", "Deterministic checks", "code"],
  ["policy", "Payment policy", "hand"],
  ["yard", "@yard coordination", "yard"],
];

// Every request to an agent, with what came of it.
export function agentRuns(cases) {
  const runs = [];
  for (const c of cases) {
    const open = [];
    for (const e of c.events) {
      if (e.type === "asked") {
        const run = { caseId: c.id, caseTitle: c.title, flow: c.flow, step: e.step, agent: e.agent, attempt: e.attempt, tries: e.tries ?? 1, at: e.at_iso, docs: e.docs, status: "waiting" };
        runs.push(run);
        open.push(run);
        continue;
      }
      const take = (agent) => {
        const i = open.findIndex((r) => r.step === e.step && (!agent || r.agent === agent));
        return i < 0 ? undefined : open.splice(i, 1)[0];
      };
      const end = (run, status, value) => {
        if (!run) return;
        Object.assign(run, { status, value, done: e.at_iso, ms: new Date(e.at_iso) - new Date(run.at) });
      };
      if (e.type === "partial") end(take(e.agent), e.value?.unavailable ? "unavailable" : "answered", e.value);
      if (e.type === "answered" && !("agreed" in (e.value ?? {}))) end(take(), "answered", e.value);
      if (e.type === "reply_rejected") {
        const who = /^(@[\w.-]+):/.exec(e.error ?? "")?.[1];
        end(take(who), "rejected", { error: e.error });
      }
      if (e.type === "failed_over") end(take(e.from), "handed off", { to: e.to, reason: e.reason });
    }
  }
  return runs;
}

const median = (xs) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function agentsTab(state, ui) {
  const runs = agentRuns(state.cases);
  if (!runs.length) return `<p class="fine">No agent has been asked anything yet.</p>`;
  const roleOf = (r) => {
    const step = state.flows.find((f) => f.flow === r.flow)?.steps.find((s) => s.id === r.step);
    return step?.roles?.[r.agent] ?? (step ? `${step.label} step` : r.step);
  };
  const jobs = new Map();
  for (const r of runs) {
    const key = `${r.flow}|${r.step}|${r.agent}`;
    const j = jobs.get(key) ?? { key, flow: r.flow, step: r.step, agent: r.agent, role: roleOf(r), runs: [] };
    j.runs.push(r);
    jobs.set(key, j);
  }
  const list = [...jobs.values()].sort((a, b) => b.runs.length - a.runs.length);
  const sel = list.find((j) => j.key === ui.job) ?? list[0];
  const cards = list
    .map((j) => {
      const answered = j.runs.filter((r) => r.status === "answered");
      const med = median(answered.map((r) => r.ms).filter((x) => x >= 0));
      const vendor = state.vendors?.[j.agent];
      return `<button class="ag-job${j === sel ? " sel" : ""}" data-job="${esc(j.key)}">
        <span class="ag-job-head"><b>${esc(j.role)}</b>${vendor ? `<span class="vendor v-${esc(vendor)}">${esc(vendor)}</span>` : ""}</span>
        <span class="mono">${esc(j.agent)} · ${esc(j.flow)}/${esc(j.step)}</span>
        <span class="ag-stats"><span><b>${j.runs.length}</b> asked</span><span class="t-act"><b>${answered.length}</b> answered</span>${((n) => `<span class="${n ? "t-stop" : ""}"><b>${n}</b> refused, unavailable or handed off</span>`)(j.runs.filter((r) => r.status === "rejected" || r.status === "unavailable" || r.status === "handed off").length)}<span>median <b>${med === undefined ? "—" : seconds(med)}</b></span></span>
      </button>`;
    })
    .join("");
  const rows = sel.runs
    .slice()
    .reverse()
    .map((r) => {
      const tone = r.status === "answered" ? "act" : r.status === "waiting" ? "agent" : "stop";
      return `<details class="ag-run"><summary>
        <span class="pill ${tone}">${esc(r.status)}</span><span class="mono">${esc(stamp(r.at))}</span><span>${r.ms === undefined ? "" : seconds(r.ms)}</span><span>${r.tries > 1 ? `try ${r.tries}` : ""}</span>
        <a class="caselink" href="#${esc(r.caseId)}">${esc(r.caseTitle)}</a></summary>
        <div class="ag-run-body">
          ${r.docs ? `<p class="fine">Room documents when asked: ${Object.entries(r.docs).map(([d, h]) => `<span class="docref">${esc(d)} ${hx(h, 12)}</span>`).join(" ")}</p>` : ""}
          ${r.value ? `<h4>Structured output, as recorded</h4>${tree(r.value)}` : '<p class="fine">No answer recorded.</p>'}
        </div></details>`;
    })
    .join("");
  return `<div class="ag-jobs">${cards}</div>
    <section class="card ag-runs"><h3>${icon("bot")} ${esc(sel.role)} · every request</h3>${rows}</section>`;
}

function checksTab(state) {
  const all = state.cases.flatMap((c) => c.events.filter((e) => e.type === "verified").map((e) => ({ ...e, caseId: c.id, caseTitle: c.title })));
  if (!all.length) return `<p class="fine">No code check has run yet.</p>`;
  const by = new Map();
  for (const e of all) by.set(e.check, [...(by.get(e.check) ?? []), e]);
  return [...by.entries()]
    .map(([check, runs]) => {
      const failed = runs.filter((r) => r.value?.ok === false).length;
      return `<section class="card ag-check"><div class="ag-check-head"><h3 class="mono">${esc(check)}</h3><span class="pill ${failed ? "stop" : "act"}">${runs.length} run${runs.length === 1 ? "" : "s"} · ${failed} failed</span></div>
        <table class="pf-table"><thead><tr><th></th><th>case</th><th>result</th><th>documents read</th><th>when</th></tr></thead><tbody>${runs
          .slice(-8)
          .reverse()
          .map((r) => `<tr><td>${r.value?.ok ? icon("check", "t-act") : icon("x", "t-stop")}</td><td><a class="caselink" href="#${esc(r.caseId)}">${esc(r.caseId)}</a></td><td>${esc(r.value?.detail ?? "")}</td><td>${Object.entries(r.docs ?? {}).map(([d, h]) => `<span class="docref">${esc(d.startsWith("links:") ? "links" : d)} ${hx(h, 10)}</span>`).join(" ")}</td><td class="mono nowrap">${esc(stamp(r.at_iso))}</td></tr>`)
          .join("")}</tbody></table></section>`;
    })
    .join("");
}

function policyTab(state) {
  const stepOf = (c, id) => state.flows.find((f) => f.flow === c.flow)?.steps.find((s) => s.id === id);
  const flows = state.flows.filter((f) => f.running && f.steps.some((s) => s.kind === "outlet"));
  const rules = flows
    .map((f) => {
      const outlets = f.steps.filter((s) => s.kind === "outlet");
      return `<section class="card ag-policy"><h3>${esc(f.description)} <span class="mono t-muted">${esc(f.flow)}</span></h3>
        <table class="pf-table"><thead><tr><th>action</th><th>runs only when</th><th>who may release it</th></tr></thead><tbody>${outlets
          .map((s) => {
            const gates = f.steps.filter((g) => g.kind === "gate" && (g.approves ?? []).includes(s.id));
            const release = [
              ...gates.map((g) => `<span class="pill person">${esc(g.who)}</span> on <b>${esc(g.label)}</b> (${(g.options ?? []).map(esc).join(" / ")})`),
              s.autoRule === true ? `<span class="pill act">no approval</span> once the condition holds` : s.autoRule ? `<span class="pill act">rule</span> <code>${esc(s.autoRule)}</code>` : "",
            ].filter(Boolean);
            return `<tr><td><b class="mono">${esc(s.id)}</b> <span class="pill neutral">${esc(s.who)}</span></td><td>${s.when ? `<code>${esc(s.when)}</code>` : '<span class="t-muted">always</span>'}</td><td>${release.join("<br>") || '<span class="t-stop">nobody: lint refuses this</span>'}</td></tr>`;
          })
          .join("")}</tbody></table></section>`;
    })
    .join("");
  const executed = state.cases.flatMap((c) => receiptsOf(c, stepOf).filter((r) => r.kind === "executed").map((r) => ({ ...r, c })));
  const log = executed.length
    ? `<table class="pf-table"><thead><tr><th>case</th><th>action</th><th>released by</th><th>what it rested on</th></tr></thead><tbody>${executed
        .slice(-14)
        .reverse()
        .map((r) => `<tr><td><a class="caselink" href="#${esc(r.c.id)}">${esc(r.c.id)}</a></td><td class="mono">${esc(r.step)}</td><td>${r.approval ? `<span class="pill person">${esc(r.approval.by)}</span> chose ${esc(r.approval.answer)}` : `<span class="pill act">rule</span>`}</td><td>${r.approval ? `approved hash ${hx(r.approval.hash, 12)} = sent ${hx(r.hash, 12)}` : r.ruleInputs ? Object.entries(r.ruleInputs).map(([k, v]) => `<code>${esc(k)}=${esc(JSON.stringify(v))}</code>`).join(" ") : r.rule === true ? "its condition held" : '<span class="t-muted">recorded before rule inputs were kept</span>'}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="fine">No action has run yet.</p>`;
  return `${rules}<section class="card ag-policy"><h3>${icon("send")} How each action was released</h3>${log}</section>`;
}

const YARD = [
  ["fanned_out", "asked agents in parallel"],
  ["asked", "requests to agents"],
  ["reply_rejected", "replies refused (wrong shape, wrong token, a person replying)"],
  ["failed_over", "steps handed to a backup agent"],
  ["gate_opened", "approval cards opened"],
  ["card_reopened", "answers refused, cards re-opened"],
  ["reminded", "reminders"],
  ["escalated", "escalations"],
  ["rewound", "approvals voided after a re-check"],
  ["in_doubt", "actions in doubt, put to a person"],
  ["executed", "actions carried out"],
];

function yardTab(state) {
  const events = state.cases.flatMap((c) => c.events.map((e) => ({ ...e, caseId: c.id })));
  return `<section class="card ag-yard"><h3>${icon("yard")} What @yard did</h3>
    <p class="fine">@yard is Switchyard's own agent in the room: it runs the flow, asks the agents, opens the cards and carries out approved actions. It writes nothing of its own judgement.</p>
    <ul class="ag-yard-list">${YARD.map(([t, label]) => `<li><b>${events.filter((e) => e.type === t).length}</b><span>${esc(label)}</span></li>`).join("")}</ul></section>`;
}

export function renderAgents(state, ui) {
  if (!state.loaded) return `<div class="skeleton" style="height:420px"></div>`;
  const tab = ui.tab ?? "agents";
  const body = tab === "checks" ? checksTab(state) : tab === "policy" ? policyTab(state) : tab === "yard" ? yardTab(state) : agentsTab(state, ui);
  return `<div class="ag-head">
      <div class="seg-tabs" role="tablist">${TABS.map(([k, l, i]) => `<button role="tab" data-ag="${k}" aria-selected="${tab === k}">${icon(i)} ${esc(l)}</button>`).join("")}</div>
      <p class="fine">${icon("lock")} Agents get one fenced request and answer in JSON, with their tools switched off. Shown here: what they were asked about, what they answered, and when. No reasoning is recorded or shown.</p>
    </div>
    <div class="ag-body ag-${tab}">${body}</div>`;
}
