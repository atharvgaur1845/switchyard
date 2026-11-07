// The Company view: AsterCompute, the sandbox company Switchyard runs inside.
// Every department's records as the room's documents hold them now, one deal
// traced through them, and what the controls did, counted from the log
// (GET /api/company).

import { esc, icon } from "./icons.js";
import { api } from "./views.js";

export function loadCompany(ui, rerender) {
  if (ui.loading) return;
  ui.loading = true;
  api("/api/company")
    .then((c) => (ui.data = c))
    .catch((e) => (ui.error = e.message))
    .finally(() => {
      ui.loading = false;
      rerender();
    });
}

const table = (t, max = 8) =>
  t.rows.length
    ? `<div class="co-scroll"><table class="pf-table"><thead><tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows
        .slice(0, max)
        .map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? "mono" : ""}">${esc(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>${t.rows.length > max ? `<p class="fine">${t.rows.length - max} more rows in the document</p>` : ""}`
    : `<p class="fine">No rows yet.</p>`;

function trace(c) {
  const deal = c.departments[0].records.rows.find((r) => r[1] === "Tailspin Analytics" && !/deciding again/.test(r[3]));
  if (!deal) return "";
  const id = deal[0];
  const gpu = c.departments[2].records.rows.find((r) => r[0] === `D-${id}-gpu`);
  const eng = c.departments[2].records.rows.find((r) => r[0] === `D-${id}-eng`);
  const again = c.departments[0].records.rows.find((r) => r[3].includes(id));
  const steps = [
    ["Sales", `Tailspin Analytics proposes ₹${deal[2]} a year`, `case ${id}`],
    ["Compliance", "Breaks 4 company rules; only the counteroffer is offered", "policy document"],
    ["Infrastructure", gpu ? `${gpu[4]} GPU-hours a month reserved until ${gpu[5]}` : "400 GPU-hours held for the decision", gpu ? gpu[0] : "reservation"],
    ["Engineering", eng ? `${eng[4]} engineers committed until ${eng[5]}` : "3 engineers held", eng ? eng[0] : "reservation"],
    ["Finance and Compliance", "CFO chose, a different person (CTO) co-signed", "four eyes"],
    ["Operations", again ? `Capacity dropped: decision re-opened as case ${again[0]}` : "Commitments written back to the room", again ? "Assumption Watch" : "commitments document"],
  ];
  return `<section class="card co-trace"><h3>${icon("reroute")} One deal, through the whole company</h3><ol>${steps
    .map(([d, what, ref]) => `<li><span class="co-dept">${esc(d)}</span><span>${esc(what)}</span><span class="mono t-muted">${esc(ref)}</span></li>`)
    .join("")}</ol></section>`;
}

export function renderCompany(ui) {
  if (ui.error) return `<div class="notice error">Could not load the company: ${esc(ui.error)}</div>`;
  const c = ui.data;
  if (!c) return `<div class="skeleton" style="height:420px"></div>`;
  return `
  <section class="lab-head"><h1>${icon("fork")} ${esc(c.company)}</h1><p class="fine">${esc(c.tagline)} Switchyard sits between every department and every consequential action.</p></section>
  <section class="co-outcomes">${c.outcomes.map((o) => `<div class="card co-out"><b>${o.n}</b><span>${esc(o.label)}</span><small>${esc(o.from)}</small></div>`).join("")}</section>
  ${trace(c)}
  <section class="co-grid">${c.departments
    .map((d) => `<article class="card co-dept-card"><h3>${esc(d.name)}</h3><p class="fine">${esc(d.what)}</p>${table(d.records)}${d.holds?.length ? `<p class="fine"><b>Held right now by open decisions:</b> ${d.holds.map((h) => `${esc(h.amount)} ${esc(h.resource)} for ${esc(h.to)} (case ${esc(h.case)})`).join("; ")}</p>` : ""}</article>`)
    .join("")}</section>`;
}
