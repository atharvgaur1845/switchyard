// The Commitment Graph: what the company has promised, to whom, out of which
// resources, and which decisions made or ran into each promise. Read from
// the event log: the rows and capacity the latest commitments check read,
// the rows decisions wrote, and the promises each proposal ran into. It is
// the room's documents as code last saw them, not a live copy.

import { esc, icon } from "./icons.js";
import { isDecision } from "./decisions.js";
import { plural, stamp, stepsOf } from "./views.js";

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cells = (row) => {
  const [id = "", kind = "", to = "", resource = "", amount = "", until = "", decided_by = "", basis = ""] = row;
  return { id, kind, to, resource, amount: Number(String(amount).replace(/[,\s]/g, "")), until, decided_by, basis };
};

export function commitmentFacts(state) {
  // The newest reading of the documents: a commitments check, or Assumption
  // Watch checking one again.
  const reads = state.cases
    .flatMap((c) => c.events.filter((e) => (e.type === "verified" && e.check === "commitments") || (e.type === "assumption_broken" && e.value?.commitments)).map((e) => ({ e, v: e.value })))
    .sort((a, b) => (a.e.seq ?? 0) - (b.e.seq ?? 0));
  const latest = reads.at(-1);
  if (!latest) return null;
  const rows = new Map((latest.v.commitments ?? []).map((r) => [r.id, { ...r, source: "in the room's commitments document" }]));
  const decisions = state.cases.filter(isDecision);
  // Rows decisions wrote: a check that excluded its own case's rows still
  // shows them here, from the action that wrote them.
  for (const c of decisions) {
    for (const e of c.events.filter((x) => x.type === "executed" && x.payload?.document?.name === "commitments")) {
      const r = cells(e.payload.document.row);
      rows.set(r.id, { ...r, source: `written by case ${c.id}`, caseId: c.id });
    }
  }
  const capacity = latest.v.capacity ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const resources = [...new Set([...capacity.map((c) => c.resource), ...[...rows.values()].map((r) => r.resource)])].map((resource) => {
    const cap = capacity.find((c) => c.resource === resource);
    const active = [...rows.values()].filter((r) => r.resource === resource && r.until >= today);
    const held = active.reduce((n, r) => n + r.amount, 0);
    return { resource, available: cap?.available, unit: cap?.unit ?? "", held, free: cap ? cap.available - held : undefined, active };
  });
  return { rows: [...rows.values()], capacity, resources, decisions, readAt: latest.e.at_iso };
}

function graph(f, ui) {
  const decisions = f.decisions;
  const rows = f.rows;
  const resources = f.resources;
  const ROW = 58;
  const n = Math.max(decisions.length, rows.length, resources.length, 1);
  const H = n * ROW + 40;
  const W = 980;
  const col = { decision: 8, commitment: 340, resource: 740 };
  const width = { decision: 250, commitment: 300, resource: 232 };
  const y = (list, i) => 28 + ((n - list.length) * ROW) / 2 + i * ROW + ROW / 2;
  const pos = { decision: (id) => y(decisions, decisions.findIndex((d) => d.id === id)), commitment: (id) => y(rows, rows.findIndex((r) => r.id === id)), resource: (id) => y(resources, resources.findIndex((r) => r.resource === id)) };
  const sel = ui.node;
  const edges = [];
  const edge = (from, to, x1, y1, x2, y2, tone, label, dash = "") => {
    const mx = (x1 + x2) / 2;
    const lit = !sel || sel === from || sel === to;
    edges.push(`<g class="ig-edge t-${tone}${lit ? "" : " dim"}"><path class="line" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" ${dash ? `stroke-dasharray="${dash}"` : ""}/><text x="${x1 + (x2 - x1) * 0.5}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${esc(label)}</text></g>`);
  };
  for (const r of rows) {
    if (!resources.some((x) => x.resource === r.resource)) continue;
    edge(`c|${r.id}`, `r|${r.resource}`, col.commitment + width.commitment, pos.commitment(r.id), col.resource, pos.resource(r.resource), r.caseId ? "act" : "muted", `holds ${r.amount}`);
  }
  for (const d of decisions) {
    const fit = stepsOf(d).fit;
    for (const id of new Set((fit?.conflicts ?? []).map((k) => k.id))) {
      if (rows.some((r) => r.id === id)) edge(`d|${d.id}`, `c|${id}`, col.decision + width.decision, pos.decision(d.id), col.commitment, pos.commitment(id), "stop", "in its way", "5 4");
    }
    for (const r of rows.filter((x) => x.caseId === d.id)) edge(`d|${d.id}`, `c|${r.id}`, col.decision + width.decision, pos.decision(d.id), col.commitment, pos.commitment(r.id), "act", "created");
  }
  const node = (key) => (ui.node === key ? " sel" : "");
  const dNodes = decisions.map((d) => {
    const yy = pos.decision(d.id);
    const broken = d.events.some((e) => e.type === "assumption_broken");
    return `<g class="ig-node ig-case${node(`d|${d.id}`)}" data-cnode="d|${esc(d.id)}" tabindex="0" role="button"><rect x="${col.decision}" y="${yy - 22}" width="${width.decision}" height="44" rx="8"/>
      <circle cx="${col.decision + 14}" cy="${yy}" r="5" class="tone-${broken ? "person" : esc(d.outcome.tone)}"/>
      <text x="${col.decision + 26}" y="${yy - 4}" class="t1">${esc(short(`${d.data.customer ?? d.title}${d.data.reconsider ? " (again)" : ""}`, 30))}</text>
      <text x="${col.decision + 26}" y="${yy + 12}" class="t2">${esc(d.id)} · ${esc(short(d.outcome.label, 26))}</text></g>`;
  });
  const cNodes = rows.map((r) => {
    const yy = pos.commitment(r.id);
    return `<g class="ig-node ig-vnd${r.caseId ? " made" : ""}${node(`c|${r.id}`)}" data-cnode="c|${esc(r.id)}" tabindex="0" role="button"><rect x="${col.commitment}" y="${yy - 22}" width="${width.commitment}" height="44" rx="6"/>
      <text x="${col.commitment + 12}" y="${yy - 4}" class="t1">${esc(short(`${r.id} · ${r.to}`, 40))}</text>
      <text x="${col.commitment + 12}" y="${yy + 12}" class="t2">${esc(short(`${r.kind} · ${r.amount} ${r.resource} · until ${r.until} · ${r.decided_by}`, 46))}</text><title>${esc(r.basis)}</title></g>`;
  });
  const rNodes = resources.map((r) => {
    const yy = pos.resource(r.resource);
    const pct = r.available ? Math.min(1, r.held / r.available) : 0;
    const over = r.free !== undefined && r.free < 0;
    return `<g class="ig-node ig-acct${over ? " flagged" : ""}${node(`r|${r.resource}`)}" data-cnode="r|${esc(r.resource)}" tabindex="0" role="button"><rect x="${col.resource}" y="${yy - 22}" width="${width.resource}" height="44" rx="8"/>
      <text x="${col.resource + 12}" y="${yy - 5}" class="t1">${esc(r.resource)}</text>
      <text x="${col.resource + width.resource - 12}" y="${yy - 5}" text-anchor="end" class="t2">${r.available === undefined ? "promised" : `${r.held} held of ${r.available}`}</text>
      ${r.available === undefined ? `<text x="${col.resource + 12}" y="${yy + 13}" class="t2">not drawn from a capacity</text>` : `<rect x="${col.resource + 12}" y="${yy + 7}" width="${width.resource - 24}" height="6" rx="3" class="cg-track"/><rect x="${col.resource + 12}" y="${yy + 7}" width="${(width.resource - 24) * pct}" height="6" rx="3" class="cg-fill${over ? " over" : ""}"/>`}</g>`;
  });
  const head = `<text x="${col.decision}" y="14" class="colhead">Decisions</text><text x="${col.commitment}" y="14" class="colhead">Commitments</text><text x="${col.resource}" y="14" class="colhead">Resources</text>`;
  return `<svg class="ig-graph" viewBox="0 0 ${W} ${H}" role="group" aria-label="Decisions, the commitments they made or ran into, and the resources those hold">${head}${edges.join("")}${dNodes.join("")}${cNodes.join("")}${rNodes.join("")}</svg>`;
}

function inspector(f, ui) {
  if (!ui.node) return `<p class="fine">Select a decision, a commitment or a resource to see what it is tied to.</p>`;
  const [kind, id] = [ui.node.slice(0, 1), ui.node.slice(2)];
  if (kind === "r") {
    const r = f.resources.find((x) => x.resource === id);
    return `<h4>${icon("fork")} ${esc(id)}</h4><p>${r.available === undefined ? "Promised, not drawn from a capacity." : `${r.available} ${esc(r.unit)} available; ${r.held} held by promises still running; <b class="${r.free < 0 ? "t-stop" : "t-act"}">${r.free} free</b>.`}</p>
      <ul class="ig-facts">${r.active.map((c) => `<li><b>${esc(c.id)}</b> ${esc(c.to)}: ${c.amount} until ${esc(c.until)}, decided by ${esc(c.decided_by)} <div class="fine">${esc(c.source)}</div></li>`).join("")}</ul>`;
  }
  if (kind === "c") {
    const c = f.rows.find((x) => x.id === id);
    const hit = f.decisions.filter((d) => (stepsOf(d).fit?.conflicts ?? []).some((k) => k.id === id));
    return `<h4>${icon("lock")} ${esc(c.id)}</h4><p>${esc(c.kind)} to <b>${esc(c.to)}</b>: ${c.amount} ${esc(c.resource)} until ${esc(c.until)}. Decided by ${esc(c.decided_by)}; ${esc(c.basis)}.</p><p class="fine">${esc(c.source)}${c.caseId ? ` · <a class="caselink" href="#decisions/${esc(c.caseId)}">open the decision</a>` : ""}</p>
      ${hit.length ? `<p>In the way of: ${hit.map((d) => `<a class="caselink" href="#decisions/${esc(d.id)}">${esc(d.data.customer ?? d.title)} (${esc(d.id)})</a>`).join(", ")}</p>` : ""}`;
  }
  const d = f.decisions.find((x) => x.id === id);
  return `<h4>${icon("hand")} ${esc(d.data.customer ?? d.title)}</h4><p><span class="pill ${esc(d.outcome.tone)}">${esc(d.outcome.label)}</span></p><p class="ig-actions"><a class="btn small" href="#decisions/${esc(d.id)}">Decision Room</a> <a class="btn small" href="#proofs/${esc(d.id)}">Proof</a></p>`;
}

export function renderCommitments(state, ui) {
  if (!state.loaded) return `<div class="skeleton" style="height:420px"></div>`;
  const f = commitmentFacts(state);
  if (!f) return `<div class="empty-state card">${icon("lock")}<h2>No commitments read yet</h2><p>The graph is drawn from what a decision's checks read in the room. Send a proposal with <code>npm run switchyard demo send contract-proposal</code>.</p></div>`;
  const broken = f.decisions.flatMap((d) => d.events.filter((e) => e.type === "assumption_broken").map((e) => ({ d, e })));
  return `<section class="lab-head"><h1>${icon("lock")} Commitment Graph</h1>
      <p class="fine">What the company has already promised, out of which resources, and which decisions made or ran into each promise. A decision made yesterday constrains the one being made today: code checks every proposal against these rows before anyone is asked. As the room's documents were last read by code, ${esc(stamp(f.readAt))}.</p></section>
    ${broken.map(({ d, e }) => `<div class="banner person">${icon("alert")}<span><b>Assumption broken</b> on <a class="caselink" href="#decisions/${esc(d.id)}">${esc(d.data.customer ?? d.title)} (${esc(d.id)})</a>: ${esc(e.title)}. ${esc(e.detail)}. Decided again in <a class="caselink" href="#decisions/${esc(e.reopened)}">case ${esc(e.reopened)}</a>.</span></div>`).join("")}
    <section class="card cg-main">
      <div class="ig-graph-wrap">${graph(f, ui)}</div>
      <ul class="ig-legend"><li class="t-muted"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4"/></svg>a promise in the room holds part of a resource</li><li class="t-act"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4"/></svg>a decision created this promise</li><li class="t-stop"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke-dasharray="5 4"/></svg>this promise stood in a proposal's way</li></ul>
      <div class="ig-split"><section class="ig-inspector"><h3>${icon("user")} Inspector</h3>${inspector(f, ui)}</section>
        <section><h3>${icon("fork")} Capacity</h3><table class="pf-table"><thead><tr><th>resource</th><th>available</th><th>held now</th><th>free</th></tr></thead><tbody>${f.resources
          .filter((r) => r.available !== undefined)
          .map((r) => `<tr><td>${esc(r.resource)}</td><td>${r.available} ${esc(r.unit)}</td><td>${r.held} <span class="fine">(${plural(r.active.length, "promise")})</span></td><td class="${r.free < 0 ? "t-stop" : "t-act"}"><b>${r.free}</b></td></tr>`)
          .join("")}</tbody></table><p class="fine">A promise has an end date and no start date, so every promise not yet ended counts as held, as the commitments check counts it: on the cautious side.</p></section></div>
      <h3>${icon("doc")} Every commitment</h3>
      <div class="ig-scroll"><table class="pf-table"><thead><tr><th>id</th><th>kind</th><th>to</th><th>holds</th><th>until</th><th>decided by</th><th>basis</th><th>where it came from</th></tr></thead><tbody>${f.rows
        .map((r) => `<tr><td class="mono"><b>${esc(r.id)}</b></td><td>${esc(r.kind)}</td><td>${esc(r.to)}</td><td>${r.amount} ${esc(r.resource)}</td><td class="mono">${esc(r.until)}</td><td>${esc(r.decided_by)}</td><td>${esc(r.basis)}</td><td>${r.caseId ? `<a class="caselink" href="#decisions/${esc(r.caseId)}">${esc(r.source)}</a>` : esc(r.source)}</td></tr>`)
        .join("")}</tbody></table></div>
    </section>`;
}

export function commitmentClick(e, ui, rerender) {
  const n = e.target.closest("[data-cnode]");
  if (!n) return;
  ui.node = ui.node === n.dataset.cnode ? null : n.dataset.cnode;
  rerender();
}
