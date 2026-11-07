// The attack lab: the 20 held-out scenarios in lab/heldout, run on demand
// on the real engine and flows (POST /api/lab), under two configurations
// side by side. Every number on this page is counted from runs made here;
// nothing is stored or precomputed.

import { esc, icon } from "./icons.js";
import { api, describe, money, plural, seconds } from "./views.js";

const DEFAULTS = { a: { links: false, fooled: false, bank: "unavailable" }, b: { links: true, fooled: false, bank: "unavailable" } };
const keyOf = (id, cfg) => `${id}|${cfg.links}|${cfg.fooled}|${cfg.bank}`;

function init(ui, rerender) {
  if (ui.scenarios || ui.loading) return;
  ui.loading = true;
  ui.a ??= { ...DEFAULTS.a };
  ui.b ??= { ...DEFAULTS.b };
  ui.results ??= {};
  api("/api/lab")
    .then((s) => (ui.scenarios = s))
    .catch((e) => (ui.error = e.message))
    .finally(() => {
      ui.loading = false;
      rerender();
    });
}

async function run(ui, ids, rerender) {
  if (ui.running) return;
  ui.running = { done: 0, total: ids.length * 2 };
  rerender();
  try {
    for (const id of ids) {
      for (const side of ["a", "b"]) {
        const cfg = ui[side];
        const key = keyOf(id, cfg);
        if (!ui.results[key]) ui.results[key] = await api("/api/lab", { method: "POST", body: JSON.stringify({ id, ...cfg }) });
        ui.running.done++;
        rerender();
      }
    }
  } catch (e) {
    ui.error = e.message;
  } finally {
    ui.running = null;
    rerender();
  }
}

function controls(side, cfg, label) {
  const opt = (name, value, text) => `<label class="lab-opt"><input type="radio" name="${side}-${name}" data-cfg="${side}.${name}" value="${value}" ${String(cfg[name]) === String(value) ? "checked" : ""}> ${text}</label>`;
  return `<fieldset class="lab-cfg"><legend>${esc(label)}</legend>
    <div><span class="k">Links between cases</span>${opt("links", "false", "off")}${opt("links", "true", "on")}</div>
    <div><span class="k">Callbacks</span>${opt("fooled", "false", "reach the real supplier")}${opt("fooled", "true", "every one fooled")}</div>
    <div><span class="k">Bank's payee answers</span>${opt("bank", "unavailable", "none (unavailable)")}${opt("bank", "oracle", "from the scenario: upper bound")}</div>
  </fieldset>`;
}

function badge(r) {
  if (!r) return `<span class="lab-badge none">·</span>`;
  return `<span class="lab-badge ${r.run.pass ? "ok" : "bad"}" title="${r.run.pass ? "meets every expectation" : esc(r.run.failures.join("; "))}">${r.run.pass ? "pass" : "fail"}${r.run.toAttacker ? ` · ${money(r.run.toAttacker)}` : ""}</span>`;
}

function totals(ui, side) {
  const rs = ui.scenarios.map((s) => ({ s, r: ui.results[keyOf(s.id, ui[side])] })).filter((x) => x.r);
  const attacks = rs.filter((x) => x.s.kind === "attack");
  const benign = rs.filter((x) => x.s.kind === "benign");
  return {
    n: rs.length,
    pass: rs.filter((x) => x.r.run.pass).length,
    attacksStopped: attacks.filter((x) => x.r.run.toAttacker === 0).length,
    attacks: attacks.length,
    eur: rs.reduce((n, x) => n + x.r.run.toAttacker, 0),
    falsePositives: benign.filter((x) => !x.r.run.pass).length,
    benign: benign.length,
    cards: rs.reduce((n, x) => n + x.r.run.cards, 0),
    stale: rs.reduce((n, x) => n + x.r.run.stale, 0),
    refused: rs.reduce((n, x) => n + x.r.run.refused, 0),
    ms: rs.length ? rs.reduce((n, x) => n + x.r.ms, 0) / rs.length : 0,
  };
}

function compare(ui) {
  const A = totals(ui, "a");
  const B = totals(ui, "b");
  if (!A.n && !B.n) return `<p class="fine">Run a scenario, or all 20, to compare the two configurations. Each run takes a fraction of a second.</p>`;
  const metric = (label, a, b, fmt = String, lowerIsBetter = false, max) => {
    const top = max ?? Math.max(a, b, 1);
    const better = a === b ? "" : (lowerIsBetter ? b < a : b > a) ? "b" : "a";
    return `<div class="lab-metric"><span class="k">${esc(label)}</span>
      <div class="lab-bars"><span class="bar a${better === "a" ? " better" : ""}" style="--w:${(a / top) * 100}%"><i></i><b>${fmt(a)}</b></span><span class="bar b${better === "b" ? " better" : ""}" style="--w:${(b / top) * 100}%"><i></i><b>${fmt(b)}</b></span></div></div>`;
  };
  return `<div class="lab-compare">
    <div class="lab-legend"><span class="sw a"></span>A <span class="sw b"></span>B · over ${plural(Math.min(A.n, B.n) || Math.max(A.n, B.n), "scenario")} run under each</div>
    ${metric("meet every expectation", A.pass, B.pass, String, false, Math.max(A.n, B.n))}
    ${metric(`attacks with nothing paid to the attacker (of ${Math.max(A.attacks, B.attacks)})`, A.attacksStopped, B.attacksStopped, String, false, Math.max(A.attacks, B.attacks, 1))}
    ${metric("EUR paid to attacker accounts", A.eur, B.eur, (n) => money(n), true)}
    ${metric(`benign scenarios not completed: false positives (of ${Math.max(A.benign, B.benign)})`, A.falsePositives, B.falsePositives, String, true, Math.max(A.benign, B.benign, 1))}
    ${metric("cards shown to people", A.cards, B.cards, String, true)}
    ${metric("approvals voided after a re-check", A.stale, B.stale)}
    ${metric("answers refused (wrong person, or four eyes)", A.refused, B.refused)}
    ${metric("mean run time, engine and sandbox bank", A.ms, B.ms, (n) => seconds(n), true)}
  </div>`;
}

function trace(r) {
  return r.run.cases
    .map((c) => `<details class="lab-case"><summary><span class="pill ${esc(c.outcome.tone)}">${esc(c.outcome.label)}</span> ${c.label ? `<b>${esc(c.label)}</b> · ` : ""}${esc(c.title)}</summary>
      <ol class="lab-events">${c.events
        .map((e) => ({ e, d: describe(e) }))
        .filter((x) => x.d)
        .map(({ e, d }) => `<li class="t-${d.tone}"><span class="mono">${esc(e.seq)}</span><span class="who">${esc(d.who ?? "")}</span><span>${esc(d.text)}</span></li>`)
        .join("")}</ol></details>`)
    .join("");
}

function result(r, label) {
  if (!r) return `<div class="lab-result empty"><h4>${esc(label)}</h4><p class="fine">Not run under this configuration.</p></div>`;
  const run = r.run;
  return `<div class="lab-result ${run.pass ? "ok" : "bad"}"><h4>${esc(label)} ${run.pass ? '<span class="pill act">meets every expectation</span>' : '<span class="pill stop">does not</span>'}</h4>
    <dl class="lab-dl"><dt>to the attacker</dt><dd class="${run.toAttacker ? "t-stop" : "t-act"}">${money(run.toAttacker)} EUR</dd><dt>cards</dt><dd>${run.cards}</dd><dt>approvals voided</dt><dd>${run.stale}</dd><dt>answers refused</dt><dd>${run.refused}</dd><dt>run time</dt><dd>${seconds(r.ms)}</dd></dl>
    ${run.failures.length ? `<ul class="lab-fails">${run.failures.map((f) => `<li>${icon("x")} ${esc(f)}</li>`).join("")}</ul>` : ""}
    <ul class="lab-outcomes">${Object.entries(run.outcomes).map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(v)}</li>`).join("")}</ul>
    <h5>Trace: every case this run opened</h5>${trace(r)}</div>`;
}

export function renderLab(ui, rerender) {
  init(ui, rerender);
  if (ui.error && !ui.scenarios) return `<div class="notice error">Could not load the scenarios: ${esc(ui.error)}</div>`;
  if (!ui.scenarios) return `<div class="skeleton" style="height:420px"></div>`;
  const q = (ui.query ?? "").toLowerCase();
  const kind = ui.kind ?? "all";
  const shown = ui.scenarios.filter((s) => (kind === "all" || s.kind === kind) && (!q || `${s.id} ${s.family} ${s.title}`.toLowerCase().includes(q)));
  ui.sel = ui.scenarios.some((s) => s.id === ui.sel) ? ui.sel : ui.scenarios[0].id;
  const s = ui.scenarios.find((x) => x.id === ui.sel);
  const list = shown
    .map((x) => `<li><button class="lab-pick" data-scenario="${esc(x.id)}" aria-current="${x.id === s.id}"><span class="mono">${esc(x.id)}</span><span class="t">${esc(x.title)}</span><span class="s"><span class="pill ${x.kind === "attack" ? "stop" : "neutral"}">${esc(x.kind)}</span><span>${esc(x.family)}</span>${badge(ui.results[keyOf(x.id, ui.a)])}${badge(ui.results[keyOf(x.id, ui.b)])}</span></button></li>`)
    .join("");
  const busy = ui.running ? `<span class="lab-progress"><i style="width:${(ui.running.done / ui.running.total) * 100}%"></i></span><span class="fine">${ui.running.done}/${ui.running.total} runs</span>` : "";
  const expect = Object.entries(s.expect).map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(typeof v === "object" ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(", ") : `${v}`)}</li>`).join("");
  return `
  <section class="lab-head">
    <div><h1>${icon("alert")} Attack lab · 20 held-out scenarios</h1>
      <p class="fine">Simulated: fixture agents answer what each scenario says the model read, the bank is the sandbox, and people are scripted to do their job (the first option on each card; the callback reaches the real supplier, who confirms only their own account, unless every callback is fooled). The scenarios were written blind from <code>lab/FORMAT.md</code> and frozen (<code>lab/heldout/FROZEN.sha256</code>) before their first run. That run found two bugs, now fixed, so these are regression results, not a detection rate.</p></div>
  </section>
  <section class="lab-config card">
    ${controls("a", ui.a, "A · baseline")}
    ${controls("b", ui.b, "B · enhanced")}
    <div class="lab-run">
      <button class="btn accent" data-run="one" ${ui.running ? "disabled" : ""}>${icon("send")} Run ${esc(s.id)} under A and B</button>
      <button class="btn" data-run="all" ${ui.running ? "disabled" : ""}>${icon("fork")} Run all 20</button>
      ${busy}
    </div>
  </section>
  <div class="lab-layout">
    <aside class="card lab-list">
      <div class="lab-tools"><input type="search" data-lab-query placeholder="Search scenarios" aria-label="Search scenarios" value="${esc(ui.query ?? "")}">
        <div class="chips" role="radiogroup">${["all", "attack", "benign"].map((k) => `<button class="chip" role="radio" data-kind="${k}" aria-checked="${kind === k}">${k}</button>`).join("")}</div></div>
      <ol>${list || '<li class="fine">No scenario matches.</li>'}</ol>
    </aside>
    <div class="lab-main">
      <section class="card lab-summary"><h3>${icon("check")} A against B</h3>${compare(ui)}</section>
      <section class="card lab-scenario">
        <h2><span class="mono">${esc(s.id)}</span> ${esc(s.title)}</h2>
        <div class="meta"><span class="pill ${s.kind === "attack" ? "stop" : "neutral"}">${esc(s.kind)}</span><span>${esc(s.family)}</span><span class="sep">·</span><span>${plural(s.steps.length, "step")}: ${s.steps.map(esc).join(" → ")}</span></div>
        ${s.notes ? `<p class="lab-notes">${esc(s.notes)}</p>` : ""}
        <h4>Expected, as written before the first run</h4><ul class="lab-outcomes">${expect}</ul>
        <div class="lab-results">${result(ui.results[keyOf(s.id, ui.a)], "A")}${result(ui.results[keyOf(s.id, ui.b)], "B")}</div>
      </section>
    </div>
  </div>`;
}

export function labClick(e, ui, rerender) {
  if (e.type === "input") {
    if (e.target.matches("[data-lab-query]")) {
      ui.query = e.target.value;
      rerender();
      const box = document.querySelector("[data-lab-query]");
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    }
    if (e.target.matches("[data-cfg]")) {
      const [side, name] = e.target.dataset.cfg.split(".");
      ui[side] = { ...ui[side], [name]: name === "bank" ? e.target.value : e.target.value === "true" };
      rerender();
    }
    return;
  }
  const pick = e.target.closest("[data-scenario]");
  if (pick) {
    ui.sel = pick.dataset.scenario;
    return rerender();
  }
  const kind = e.target.closest("[data-kind]");
  if (kind) {
    ui.kind = kind.dataset.kind;
    return rerender();
  }
  const go = e.target.closest("[data-run]");
  if (go) run(ui, go.dataset.run === "all" ? ui.scenarios.map((s) => s.id) : [ui.sel], rerender);
}
