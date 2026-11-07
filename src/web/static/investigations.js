// The Investigations view: cases grouped by the accounts that connect them.
// Every line is a recorded fact with its source, case, person and time; the
// page draws them and never scores them. A person's block is suspicion, and
// a similar name at the bank is unverified: neither is drawn as a fact about
// fraud.

import { esc, icon } from "./icons.js";

const RELATION = {
  requested: { text: "requested", tone: "person", dash: "5 4", kind: "claim", legend: "an email asked for this account" },
  pays: { text: "would pay", tone: "muted", dash: "", kind: "record", legend: "the vendor master's account" },
  paid: { text: "paid", tone: "act", dash: "", kind: "record", legend: "paid, read back from the bank" },
  printed: { text: "printed on the invoice", tone: "muted", dash: "2 4", kind: "claim", legend: "printed on an invoice, never paid" },
  blocked: { text: "blocked by a person", tone: "stop", dash: "", kind: "decision", legend: "a person blocked it: suspected, not proven" },
  cleared: { text: "cleared", tone: "act", dash: "5 4", kind: "decision", legend: "cleared after a callback and a second approver" },
  "on-file": { text: "on file for", tone: "muted", dash: "", kind: "record", legend: "on file in the vendor master" },
  "bank-match": { text: "bank: held by", tone: "act", dash: "", kind: "bank", legend: "verified: the bank confirms the holder" },
  "bank-mandate": { text: "bank: mandate holder", tone: "accent", dash: "", kind: "bank", legend: "verified holder, under an attested factoring mandate" },
  "bank-close": { text: "bank: similar name", tone: "person", dash: "6 3", kind: "bank", legend: "unverified: held under a similar name" },
  "bank-no-match": { text: "bank: not held by", tone: "stop", dash: "6 3", kind: "bank", legend: "the bank says the vendor does not hold it" },
  "bank-unknown": { text: "bank: no answer", tone: "person", dash: "1 4", kind: "bank", legend: "unverified: the bank could not say" },
};

const TIMELINE = [
  ["all", "All"],
  ["person", "Decisions"],
  ["stop", "Signals"],
  ["act", "Actions"],
  ["neutral", "Arrivals"],
];

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const nodeKey = (n) => `${n.kind}|${n.id}`;
const matches = (q, ...xs) => !q || xs.some((x) => String(x ?? "").toLowerCase().includes(q));
const labelOf = (e) => (e.relation === "blocked" && e.source.startsWith("callback") ? "supplier: not theirs" : e.relation === "blocked" && e.by ? `blocked by ${e.by}` : (RELATION[e.relation]?.text ?? e.relation));

function layout(cluster) {
  const cases = cluster.cases.map((c) => c.id);
  const accounts = [...new Set(cluster.evidence.flatMap((e) => [e.from, e.to]).filter((n) => n.kind === "account").map((n) => n.id))];
  const vendors = [...new Set(cluster.evidence.map((e) => e.to).filter((n) => n.kind === "vendor").map((n) => n.id))];
  const ROW = 64;
  const rows = Math.max(cases.length, accounts.length, vendors.length, 1);
  const H = rows * ROW + 40;
  const W = 960;
  const col = { case: 8, account: 486, vendor: 760 };
  const width = { case: 270, account: 150, vendor: 192 };
  const y = (list, id) => 28 + ((rows - list.length) * ROW) / 2 + list.indexOf(id) * ROW + ROW / 2;
  const pos = (n) => {
    const list = n.kind === "case" ? cases : n.kind === "account" ? accounts : vendors;
    return { x: col[n.kind], y: y(list, n.id), w: width[n.kind] };
  };
  return { cases, accounts, vendors, W, H, col, pos };
}

function graph(cluster, ui, q) {
  const { accounts, vendors, W, H, col, pos } = layout(cluster);
  const touching = (n) => cluster.evidence.filter((e) => nodeKey(e.from) === n || nodeKey(e.to) === n).map((e) => e.id);
  const lit = ui.node ? new Set(touching(ui.node)) : null;
  const blocked = new Set(cluster.evidence.filter((e) => e.relation === "blocked" || e.relation === "bank-no-match").map((e) => (e.relation === "blocked" ? e.to.id : e.from.id)));
  const verified = new Set(cluster.evidence.filter((e) => e.relation === "bank-match" || e.relation === "bank-mandate").map((e) => e.from.id));
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
    const r = RELATION[e.relation] ?? { tone: "muted", dash: "" };
    const label = labelOf(e);
    // Labels sit a third of the way along a case's line, and past the middle
    // of an account's line to a vendor, so lines that meet keep them apart.
    const t = e.from.kind === "account" ? 0.6 : 0.32;
    const bez = (p0, p1, p2, p3) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
    const lx = bez(x1, mx, mx, x2);
    const ly = bez(a.y, a.y + bend, b.y + bend, b.y) - 5;
    const dim = (lit && !lit.has(e.id)) || (q && !matches(q, e.from.label, e.to.label, e.from.id, e.to.id, e.source, e.by));
    return `<g class="ig-edge t-${r.tone}${e.id === ui.edge ? " sel" : ""}${dim ? " dim" : ""}" data-ev="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(`${e.from.label} ${label} ${e.to.label}`)}">
      <path class="hit" d="${d}"/><path class="line" d="${d}" ${r.dash ? `stroke-dasharray="${r.dash}"` : ""}/>
      <text x="${lx}" y="${ly}" text-anchor="middle">${esc(short(label, 26))}</text></g>`;
  });
  const hit = (n, ...xs) => (q && matches(q, ...xs) ? " hit" : "") + (ui.node === n ? " sel" : "") + (q && !matches(q, ...xs) ? " dim" : "");
  const caseNodes = cluster.cases.map((c) => {
    const p = pos({ kind: "case", id: c.id });
    const n = `case|${c.id}`;
    return `<g class="ig-node ig-case${hit(n, c.id, c.title, c.outcome.label)}" data-node="${esc(n)}" tabindex="0" role="button" aria-label="case ${esc(c.title)}"><rect x="${p.x}" y="${p.y - 22}" width="${p.w}" height="44" rx="8"/>
      <circle cx="${p.x + 14}" cy="${p.y}" r="5" class="tone-${esc(c.outcome.tone)}"/>
      <text x="${p.x + 26}" y="${p.y - 4}" class="t1">${esc(short(c.title, 34))}</text>
      <text x="${p.x + 26}" y="${p.y + 12}" class="t2">${esc(c.id)} · ${esc(short(c.outcome.label, 26))}</text></g>`;
  });
  const accountNodes = accounts.map((id) => {
    const p = pos({ kind: "account", id });
    const n = `account|${id}`;
    return `<g class="ig-node ig-acct${blocked.has(id) ? " flagged" : verified.has(id) ? " verified" : ""}${hit(n, id)}" data-node="${esc(n)}" tabindex="0" role="button" aria-label="account ${esc(id)}"><rect x="${p.x}" y="${p.y - 17}" width="${p.w}" height="34" rx="17"/>
      <text x="${p.x + p.w / 2}" y="${p.y + 4}" text-anchor="middle" class="mono">${esc(id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)}</text><title>${esc(id)}</title></g>`;
  });
  const vendorNodes = vendors.map((id) => {
    const p = pos({ kind: "vendor", id });
    const n = `vendor|${id}`;
    return `<g class="ig-node ig-vnd${hit(n, id)}" data-node="${esc(n)}" tabindex="0" role="button" aria-label="${esc(id)}"><rect x="${p.x}" y="${p.y - 17}" width="${p.w}" height="34" rx="6"/><text x="${p.x + 12}" y="${p.y + 4}">${esc(short(id, 26))}</text><title>${esc(id)}</title></g>`;
  });
  const head = `<text x="${col.case}" y="14" class="colhead">Cases</text><text x="${col.account}" y="14" class="colhead">Accounts</text>${vendors.length ? `<text x="${col.vendor}" y="14" class="colhead">Vendors and holders</text>` : ""}`;
  const vb = ui.zoom?.cluster === cluster.id ? ui.zoom.box : [0, 0, W, H];
  return `<svg class="ig-graph" data-full="0 0 ${W} ${H}" viewBox="${vb.join(" ")}" role="group" aria-label="Cases, accounts and the facts that connect them">${head}${edges.join("")}${caseNodes.join("")}${accountNodes.join("")}${vendorNodes.join("")}</svg>`;
}

function inspector(cluster, ui, cases) {
  if (!ui.node) return `<p class="fine">Select a case, an account or a vendor to see every fact about it. Drag to pan, scroll or use the buttons to zoom.</p>`;
  const [kind, id] = [ui.node.slice(0, ui.node.indexOf("|")), ui.node.slice(ui.node.indexOf("|") + 1)];
  const facts = cluster.evidence.filter((e) => nodeKey(e.from) === ui.node || nodeKey(e.to) === ui.node);
  const c = kind === "case" ? cases.find((x) => x.id === id) : null;
  const head =
    kind === "case"
      ? `<h4>${icon("doc")} Case <span class="mono">${esc(id)}</span></h4><p><b>${esc(c?.title ?? "")}</b> <span class="pill ${esc(c?.outcome.tone ?? "neutral")}">${esc(c?.outcome.label ?? "")}</span></p><p class="ig-actions"><a class="btn small" href="#${esc(id)}">Open case</a> <a class="btn small" href="#replay/${esc(id)}">Walk through</a> <a class="btn small" href="#proofs/${esc(id)}">Proof</a></p>`
      : kind === "account"
        ? `<h4>${icon("lock")} Account</h4><p><code>${esc(id)}</code></p>`
        : `<h4>${icon("user")} ${esc(id)}</h4>`;
  return `${head}<ul class="ig-facts">${facts
    .map((e) => {
      const r = RELATION[e.relation] ?? { tone: "muted" };
      return `<li data-ev="${esc(e.id)}"><span class="pill ${r.tone === "muted" ? "neutral" : r.tone}">${esc(labelOf(e))}</span> <b>${esc(e.from.label)}</b> → <b>${esc(e.to.label)}</b><div class="fine">${esc(e.source)}${e.by ? `, by ${esc(e.by)}` : ""} · ${esc(when(e.at))}${e.caseId ? ` · <a class="caselink" href="#${esc(e.caseId)}">case ${esc(e.caseId)}</a>` : ""}</div><div class="ig-status">${esc(e.status)}</div></li>`;
    })
    .join("")}</ul>`;
}

function evidenceTable(cluster, ui, q) {
  const rows = cluster.evidence
    .filter((e) => matches(q, e.from.label, e.to.label, e.from.id, e.to.id, e.source, e.by, e.status))
    .map((e) => {
      const r = RELATION[e.relation] ?? { text: e.relation, tone: "muted" };
      const ends = (n) => (n.kind === "case" ? `<a class="caselink" href="#${esc(n.id)}">case ${esc(n.id)}</a>` : n.kind === "account" ? `<code>${esc(n.id)}</code>` : esc(n.label));
      return `<tr data-ev="${esc(e.id)}" class="${e.id === ui.edge ? "sel" : ""}">
      <td>${ends(e.from)}</td><td><span class="pill ${r.tone === "muted" ? "neutral" : r.tone}">${esc(labelOf(e))}</span></td><td>${ends(e.to)}</td>
      <td>${esc(e.source)}</td><td>${e.by ? esc(e.by) : '<span class="muted">code</span>'}</td><td class="nowrap">${esc(when(e.at))}</td><td>${esc(e.status)}</td></tr>`;
    });
  return `<div class="ig-scroll"><table class="ig-table"><thead><tr><th>From</th><th>Fact</th><th>To</th><th>Evidence</th><th>Who</th><th>When</th><th>Status</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="7" class="fine">No fact matches the search.</td></tr>'}</tbody></table></div>`;
}

function timelineHtml(cluster, ui, q) {
  const tone = ui.tone ?? "all";
  const caseOnly = ui.node?.startsWith("case|") ? ui.node.slice(5) : null;
  const items = cluster.timeline.filter((t) => (tone === "all" || t.tone === tone) && (!caseOnly || t.caseId === caseOnly) && matches(q, t.text, t.caseId, t.by));
  return `<div class="ig-tl-tools"><div class="chips" role="radiogroup" aria-label="Show">${TIMELINE.map(([k, l]) => `<button class="chip" role="radio" data-tone="${k}" aria-checked="${tone === k}">${l}</button>`).join("")}</div>${caseOnly ? `<span class="fine">only case ${esc(caseOnly)}</span>` : ""}</div>
    <ol class="ig-timeline">${items.map((t) => `<li class="t-${esc(t.tone)}"><span class="when">${esc(when(t.at))}</span><a class="caselink" href="#${esc(t.caseId)}">${esc(t.caseId)}</a> <span>${esc(t.text)}</span>${t.by ? ` <b>${esc(t.by)}</b>` : ""}</li>`).join("") || '<li class="fine">Nothing of this kind.</li>'}</ol>`;
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

function legend(cluster) {
  const used = new Set(cluster.evidence.map((e) => e.relation));
  return `<ul class="ig-legend">${Object.entries(RELATION)
    .filter(([k]) => used.has(k))
    .map(([, r]) => `<li class="t-${r.tone}"><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" ${r.dash ? `stroke-dasharray="${r.dash}"` : ""}/></svg>${esc(r.legend)}</li>`)
    .join("")}</ul>`;
}

export function renderInvestigations(data, ui, cases = []) {
  const { clusters, totals } = data;
  if (!clusters.length) {
    return `<div class="empty-state card ig-empty">${icon("link")}<h2>No linked cases</h2><p>Cases appear here when code finds a fact that connects them: an account a person blocked that another case names, or an account on file for two vendors.</p></div>`;
  }
  const q = (ui.query ?? "").trim().toLowerCase();
  const shown = clusters.filter((c) => matches(q, c.title, ...c.accounts, ...c.cases.flatMap((x) => [x.id, x.title]), ...c.evidence.flatMap((e) => [e.from.label, e.to.label])));
  const selected = shown.find((c) => c.id === ui.cluster) ?? shown[0] ?? clusters[0];
  const list = shown
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
      <input type="search" class="ig-search" data-ig-query placeholder="Search accounts, vendors, cases, people" aria-label="Search the investigations" value="${esc(ui.query ?? "")}">
    </section>
    <div class="ig-layout">
      <aside class="card ig-list"><h3>Linked groups</h3><ol>${list || '<li class="fine">No group matches.</li>'}</ol>
        <p class="fine">Each line is a recorded fact: who decided, in which case, when. A block is a person's suspicion, not proof of fraud; a similar name at the bank is unverified. Nothing here is a score.</p></aside>
      <article class="card ig-main">
        <h2>${esc(selected.title)}</h2>
        <div class="ig-graph-head"><h3>${icon("link")} How the cases connect</h3>
          <span class="ig-zoom"><button class="btn small" data-zoom="in" aria-label="Zoom in">+</button><button class="btn small" data-zoom="out" aria-label="Zoom out">−</button><button class="btn small" data-zoom="reset">Fit</button></span></div>
        <div class="ig-graph-wrap" data-pan>${graph(selected, ui, q)}</div>
        ${legend(selected)}
        ${edge ? `<div class="banner ${RELATION[edge.relation]?.tone === "stop" ? "stop" : "person"} ig-edge-detail">${icon("doc")}<span><b>${esc(edge.from.label)}</b> → ${esc(labelOf(edge))} → <b>${esc(edge.to.label)}</b>. ${esc(edge.source)}${edge.by ? `, by ${esc(edge.by)}` : ""}, ${esc(when(edge.at))}. <i>${esc(edge.status)}</i>.${edge.caseId ? ` <a class="caselink" href="#${esc(edge.caseId)}">Open case ${esc(edge.caseId)}</a>` : ""}</span></div>` : ""}
        <div class="ig-split">
          <section class="ig-inspector"><h3>${icon("user")} Inspector</h3>${inspector(selected, ui, cases)}</section>
          <section><h3>${icon("hand")} Impact</h3>${impactHtml(selected)}</section>
        </div>
        <h3>${icon("doc")} Evidence</h3>
        ${evidenceTable(selected, ui, q)}
        <h3>${icon("clock")} Timeline</h3>
        ${timelineHtml(selected, ui, q)}
      </article>
    </div>`;
}

// Clicks, search, zoom and pan. Zoom and pan move the SVG's viewBox in
// place, so dragging stays smooth; the box is kept for the next redraw.
export function wireInvestigations(view, state, render) {
  const ui = state.ig;
  const svg = () => view.querySelector(".ig-graph");
  const box = () => svg()?.getAttribute("viewBox").split(" ").map(Number);
  const setBox = (b) => {
    svg()?.setAttribute("viewBox", b.join(" "));
    ui.zoom = { cluster: ui.cluster ?? state.investigations.clusters[0]?.id, box: b };
  };
  const zoom = (factor, cx, cy) => {
    const b = box();
    if (!b) return;
    const full = svg().dataset.full.split(" ").map(Number);
    const w = Math.min(full[2] * 1.5, Math.max(full[2] / 5, b[2] * factor));
    const h = (b[3] / b[2]) * w;
    const px = cx ?? b[0] + b[2] / 2;
    const py = cy ?? b[1] + b[3] / 2;
    setBox([px - ((px - b[0]) * w) / b[2], py - ((py - b[1]) * h) / b[3], w, h]);
  };
  view.addEventListener("click", (e) => {
    if (view.dataset.dragged === "1") return;
    const pick = e.target.closest("[data-cluster]");
    if (pick) Object.assign(ui, { cluster: pick.dataset.cluster, edge: null, node: null, zoom: null });
    const ev = e.target.closest("[data-ev]");
    if (ev) Object.assign(ui, { cluster: ui.cluster ?? state.investigations.clusters[0]?.id ?? null, edge: ui.edge === ev.dataset.ev ? null : ev.dataset.ev });
    const node = e.target.closest("[data-node]");
    if (node) ui.node = ui.node === node.dataset.node ? null : node.dataset.node;
    const tone = e.target.closest("[data-tone]");
    if (tone) ui.tone = tone.dataset.tone;
    const z = e.target.closest("[data-zoom]");
    if (z) {
      if (z.dataset.zoom === "reset") {
        ui.zoom = null;
        svg()?.setAttribute("viewBox", svg().dataset.full);
      } else zoom(z.dataset.zoom === "in" ? 0.8 : 1.25);
      return;
    }
    if (pick || ev || node || tone) render();
  });
  view.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("[data-ev],[data-node]")) {
      e.preventDefault();
      e.target.closest("[data-ev],[data-node]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  view.addEventListener("input", (e) => {
    if (!e.target.matches("[data-ig-query]")) return;
    ui.query = e.target.value;
    render();
    const input = view.querySelector("[data-ig-query]");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  view.addEventListener(
    "wheel",
    (e) => {
      const s = e.target.closest?.(".ig-graph");
      if (!s) return;
      e.preventDefault();
      const r = s.getBoundingClientRect();
      const b = box();
      zoom(e.deltaY < 0 ? 0.88 : 1.14, b[0] + ((e.clientX - r.left) / r.width) * b[2], b[1] + ((e.clientY - r.top) / r.height) * b[3]);
    },
    { passive: false },
  );
  let drag = null;
  view.addEventListener("pointerdown", (e) => {
    const s = e.target.closest?.(".ig-graph");
    if (!s || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, b: box(), r: s.getBoundingClientRect(), moved: false };
    view.dataset.dragged = "0";
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    view.dataset.dragged = "1";
    setBox([drag.b[0] - (dx / drag.r.width) * drag.b[2], drag.b[1] - (dy / drag.r.height) * drag.b[3], drag.b[2], drag.b[3]]);
  });
  window.addEventListener("pointerup", () => {
    drag = null;
    setTimeout(() => (view.dataset.dragged = "0"), 0);
  });
}
