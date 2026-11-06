// The Investigations view: cases grouped by the accounts that connect them.
// Every edge is a recorded fact with its source, case, person and time; the
// page draws them and never scores them.

import { esc, icon } from "./icons.js";

const RELATION = {
  requested: { text: "requested", tone: "person", dash: "5 4" },
  pays: { text: "would pay", tone: "act", dash: "" },
  paid: { text: "paid", tone: "act", dash: "" },
  printed: { text: "printed on the invoice", tone: "muted", dash: "2 4" },
  blocked: { text: "blocked by a person", tone: "stop", dash: "" },
  cleared: { text: "cleared", tone: "act", dash: "5 4" },
  "on-file": { text: "on file for", tone: "muted", dash: "" },
};

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function graph(cluster, selectedEdge) {
  const cases = cluster.cases.map((c) => c.id);
  const accounts = [...new Set(cluster.evidence.flatMap((e) => [e.from, e.to]).filter((n) => n.kind === "account").map((n) => n.id))];
  const vendors = [...new Set(cluster.evidence.map((e) => e.to).filter((n) => n.kind === "vendor").map((n) => n.id))];
  const ROW = 62;
  const rows = Math.max(cases.length, accounts.length, vendors.length, 1);
  const H = rows * ROW + 24;
  const W = 900;
  const col = { case: 8, account: 470, vendor: 724 };
  const width = { case: 262, account: 150, vendor: 168 };
  const y = (list, id) => {
    const i = list.indexOf(id);
    const offset = ((rows - list.length) * ROW) / 2;
    return 12 + offset + i * ROW + ROW / 2;
  };
  const pos = (n) => {
    const list = n.kind === "case" ? cases : n.kind === "account" ? accounts : vendors;
    return { x: col[n.kind], y: y(list, n.id), w: width[n.kind] };
  };
  const blocked = new Set(cluster.evidence.filter((e) => e.relation === "blocked").map((e) => e.to.id));
  // Several facts can join the same two nodes (requested and blocked): fan
  // their curves out a little so each stays clickable.
  const pairs = new Map();
  const edges = cluster.evidence.map((e) => {
    const a = pos(e.from);
    const b = pos(e.to);
    const key = `${e.from.id}|${e.to.id}`;
    const k = pairs.get(key) ?? 0;
    pairs.set(key, k + 1);
    const bend = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 16;
    const x1 = a.x + a.w;
    const x2 = b.x;
    const mx = (x1 + x2) / 2;
    const d = `M${x1},${a.y} C${mx},${a.y + bend} ${mx},${b.y + bend} ${x2},${b.y}`;
    const r = RELATION[e.relation] ?? { text: e.relation, tone: "muted", dash: "" };
    const label = e.relation === "blocked" && e.by ? `blocked by ${e.by}` : r.text;
    // The label sits a third of the way along the curve, near its case,
    // so lines that meet at one account keep their labels apart.
    const t = 0.32;
    const bez = (p0, p1, p2, p3) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
    const lx = bez(x1, mx, mx, x2);
    const ly = bez(a.y, a.y + bend, b.y + bend, b.y) - 5;
    return `<g class="ig-edge t-${r.tone}${e.id === selectedEdge ? " sel" : ""}" data-ev="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(`${e.from.label} ${label} ${e.to.label}`)}">
      <path class="hit" d="${d}"/><path class="line" d="${d}" ${r.dash ? `stroke-dasharray="${r.dash}"` : ""}/>
      <text x="${lx}" y="${ly}" text-anchor="middle">${esc(short(label, 26))}</text></g>`;
  });
  const caseNodes = cluster.cases.map((c) => {
    const p = pos({ kind: "case", id: c.id });
    return `<a href="#${esc(c.id)}" class="ig-node ig-case"><rect x="${p.x}" y="${p.y - 22}" width="${p.w}" height="44" rx="8"/>
      <circle cx="${p.x + 14}" cy="${p.y}" r="5" class="tone-${esc(c.outcome.tone)}"/>
      <text x="${p.x + 26}" y="${p.y - 4}" class="t1">${esc(short(c.title, 32))}</text>
      <text x="${p.x + 26}" y="${p.y + 12}" class="t2">${esc(c.id)} · ${esc(short(c.outcome.label, 24))}</text></a>`;
  });
  const accountNodes = accounts.map((id) => {
    const p = pos({ kind: "account", id });
    return `<g class="ig-node ig-acct${blocked.has(id) ? " flagged" : ""}"><rect x="${p.x}" y="${p.y - 17}" width="${p.w}" height="34" rx="17"/>
      <text x="${p.x + p.w / 2}" y="${p.y + 4}" text-anchor="middle" class="mono">${esc(id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)}</text><title>${esc(id)}</title></g>`;
  });
  const vendorNodes = vendors.map((id) => {
    const p = pos({ kind: "vendor", id });
    return `<g class="ig-node ig-vnd"><rect x="${p.x}" y="${p.y - 17}" width="${p.w}" height="34" rx="6"/><text x="${p.x + 12}" y="${p.y + 4}">${esc(short(id, 22))}</text></g>`;
  });
  const head = `<text x="${col.case}" y="10" class="colhead">Cases</text><text x="${col.account}" y="10" class="colhead">Accounts</text>${vendors.length ? `<text x="${col.vendor}" y="10" class="colhead">On file for</text>` : ""}`;
  return `<svg class="ig-graph" viewBox="0 0 ${W} ${H + 8}" role="group" aria-label="Cases, accounts and the facts that connect them">${head}<g transform="translate(0,8)">${edges.join("")}${caseNodes.join("")}${accountNodes.join("")}${vendorNodes.join("")}</g></svg>`;
}

function evidenceTable(cluster, selectedEdge) {
  const rows = cluster.evidence.map((e) => {
    const r = RELATION[e.relation] ?? { text: e.relation, tone: "muted" };
    const ends = (n) => (n.kind === "case" ? `<a class="caselink" href="#${esc(n.id)}">case ${esc(n.id)}</a>` : n.kind === "account" ? `<code>${esc(n.id)}</code>` : esc(n.label));
    return `<tr data-ev="${esc(e.id)}" class="${e.id === selectedEdge ? "sel" : ""}">
      <td>${ends(e.from)}</td><td><span class="pill ${r.tone === "muted" ? "neutral" : r.tone}">${esc(r.text)}</span></td><td>${ends(e.to)}</td>
      <td>${esc(e.source)}</td><td>${e.by ? esc(e.by) : '<span class="muted">code</span>'}</td><td class="nowrap">${esc(when(e.at))}</td><td>${esc(e.status)}</td></tr>`;
  });
  return `<div class="ig-scroll"><table class="ig-table"><thead><tr><th>From</th><th>Fact</th><th>To</th><th>Evidence</th><th>Who</th><th>When</th><th>Status</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function timelineHtml(cluster) {
  return `<ol class="ig-timeline">${cluster.timeline
    .map((t) => `<li class="t-${esc(t.tone)}"><span class="when">${esc(when(t.at))}</span><a class="caselink" href="#${esc(t.caseId)}">${esc(t.caseId)}</a> <span>${esc(t.text)}</span>${t.by ? ` <b>${esc(t.by)}</b>` : ""}</li>`)
    .join("")}</ol>`;
}

function impactHtml(cluster) {
  const i = cluster.impact;
  const paid = i.paid.reduce((n, p) => n + p.amount, 0);
  const tiles = [
    ["invoiced in these cases", i.asked.toLocaleString("en"), "yard"],
    ["paid", paid.toLocaleString("en"), "act"],
    ["still open", i.open, "person"],
    ["approvals that stopped counting", i.stale, "stop"],
    ["held or blocked", i.held, "stop"],
  ];
  const payments = i.paid.length
    ? `<ul class="ig-paid">${i.paid.map((p) => `<li>${icon("check", "t-act")} ${p.amount.toLocaleString("en")} EUR to <code>${esc(p.to)}</code> (${esc(p.reference)}, <a class="caselink" href="#${esc(p.caseId)}">case ${esc(p.caseId)}</a>)</li>`).join("")}</ul>`
    : `<p class="fine">No money moved in these cases.</p>`;
  const waiting = cluster.cases.filter((c) => c.waiting);
  return `<div class="ig-impact">${tiles.map(([l, v, t]) => `<div class="kpi"><span class="value t-${t}">${esc(v)}</span><span class="label">${esc(l)}</span></div>`).join("")}</div>
    ${payments}
    ${waiting.length ? `<ul class="ig-waiting">${waiting.map((c) => `<li>${icon("hand", "t-person")} <a class="caselink" href="#${esc(c.id)}">${esc(c.title)}</a>: waiting on ${esc(c.waiting)}</li>`).join("")}</ul>` : ""}`;
}

export function renderInvestigations(data, ui) {
  const { clusters, totals } = data;
  if (!clusters.length) {
    return `<div class="empty-state card ig-empty">${icon("link")}<h2>No linked cases</h2><p>Cases appear here when code finds a fact that connects them: an account a person blocked that another case names, or an account on file for two vendors.</p></div>`;
  }
  const selected = clusters.find((c) => c.id === ui.cluster) ?? clusters[0];
  const list = clusters
    .map((c) => `<li><button class="ig-pick" data-cluster="${esc(c.id)}" aria-current="${c.id === selected.id}">${icon(c.evidence.some((e) => e.relation === "blocked") ? "flag" : "link")}<span><b>${esc(c.title)}</b><span class="meta">${c.cases.length} cases · ${c.impact.open} open · ${c.impact.stale} approvals stopped counting</span></span></button></li>`)
    .join("");
  const edge = selected.evidence.find((e) => e.id === ui.edge);
  return `<section class="ig-head">
      <div class="kpis ig-totals">
        <div class="kpi"><span class="value t-stop">${totals.clusters}</span><span class="label">linked group${totals.clusters === 1 ? "" : "s"}</span></div>
        <div class="kpi"><span class="value t-stop">${totals.blocked}</span><span class="label">account${totals.blocked === 1 ? "" : "s"} a person blocked</span></div>
        <div class="kpi"><span class="value t-person">${totals.open}</span><span class="label">open cases touching them</span></div>
        <div class="kpi"><span class="value t-stop">${totals.stale}</span><span class="label">approvals that stopped counting</span></div>
      </div>
      <p class="fine">Each line in the graph is a recorded fact: who decided, in which case, when. A block is a person's suspicion, not proof of fraud, and nothing here is a score.</p>
    </section>
    <div class="ig-layout">
      <aside class="card ig-list"><h3>Linked groups</h3><ol>${list}</ol></aside>
      <article class="card ig-main">
        <h2>${esc(selected.title)}</h2>
        <h3>${icon("link")} How the cases connect</h3>
        <div class="ig-graph-wrap">${graph(selected, ui.edge)}</div>
        ${edge ? `<div class="banner ${RELATION[edge.relation]?.tone === "stop" ? "stop" : "person"} ig-edge-detail">${icon("doc")}<span><b>${esc(edge.from.label)}</b> → ${esc(RELATION[edge.relation]?.text ?? edge.relation)} → <b>${esc(edge.to.label)}</b>. ${esc(edge.source)}${edge.by ? `, by ${esc(edge.by)}` : ""}, ${esc(when(edge.at))}. <i>${esc(edge.status)}</i>.${edge.caseId ? ` <a class="caselink" href="#${esc(edge.caseId)}">Open case ${esc(edge.caseId)}</a>` : ""}</span></div>` : `<p class="fine">Click a line for its evidence, or a case to open it.</p>`}
        <h3>${icon("hand")} Impact</h3>
        ${impactHtml(selected)}
        <h3>${icon("doc")} Evidence</h3>
        ${evidenceTable(selected, ui.edge)}
        <h3>${icon("clock")} Timeline</h3>
        ${timelineHtml(selected)}
      </article>
    </div>`;
}
