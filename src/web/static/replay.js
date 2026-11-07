// The guided walkthrough: one real case, stage by stage, from its recorded
// events. Stages 1-8 replay what the log holds, with the times they
// happened; stages 9 and 10 run now: the proof is built by the server and
// checked by `verifyProof` when the walkthrough reaches them.

import { esc, hx, icon } from "./icons.js";
import { api, checksOf, describe, mask, money, plural, seconds, stamp, tree } from "./views.js";

const STAGES = [
  { k: "Arrives", icon: "mail", what: "An email or an invoice opens a case", has: (e) => e.type === "opened" },
  { k: "Agents investigate", icon: "bot", what: "Agents read it, each in its own job", has: (e) => ["asked", "fanned_out", "partial", "answered", "reply_rejected", "failed_over"].includes(e.type) },
  { k: "Evidence extracted", icon: "doc", what: "Their quotes are found in the source, at offsets", has: (e) => e.type === "verified" && e.check === "agent_evidence" },
  { k: "Code checks", icon: "code", what: "Code checks every claim against the room's documents", has: (e) => e.type === "verified" && !["agent_evidence", "payee", "links"].includes(e.check) },
  { k: "Bank names the holder", icon: "user", what: "The bank says who holds the account", has: (e) => e.type === "verified" && e.check === "payee" },
  { k: "Across cases", icon: "link", what: "Other cases' facts about the same account", has: (e) => (e.type === "verified" && e.check === "links") || ["rewound", "flagged", "cleared"].includes(e.type) },
  { k: "People authorize", icon: "hand", what: "A named person decides on a Switch card", has: (e) => ["gate_opened", "gate_answered", "card_reopened", "reminded", "escalated"].includes(e.type) },
  { k: "Payment decision", icon: "send", what: "The engine does exactly what was approved, or stops", has: (e) => ["executed", "failed", "in_doubt", "done", "cancelled"].includes(e.type) },
  { k: "Proof generated", icon: "lock", what: "The whole record, digested and signed", live: true },
  { k: "Proof verified", icon: "check", what: "Checked with no model, no Switch and no bank", live: true },
];

let timer = null;
const stop = (ui) => {
  clearInterval(timer);
  timer = null;
  ui.playing = false;
};

function proofStage(c, ui, rerender) {
  if (ui.proof?.id === c.id) return;
  ui.proof = { id: c.id, loading: true };
  api(`/api/proof/${encodeURIComponent(c.id)}`)
    .then(async (proof) => {
      const check = await api("/api/verify-proof", { method: "POST", body: JSON.stringify(proof) });
      Object.assign(ui.proof, { loading: false, proof, findings: check.findings, pinned: check.pinned });
    })
    .catch((e) => Object.assign(ui.proof, { loading: false, error: e.message }))
    .finally(rerender);
}

function stageBody(i, c, events, ui) {
  const checks = checksOf(c);
  const none = `<p class="fine">Nothing in this case at this stage${i === 2 ? ": no invoice text to ground quotes in" : ""}.</p>`;
  if (i === 0) {
    const d = c.data;
    const text = typeof d.text === "string" ? d.text : typeof d.body === "string" ? d.body : null;
    return `<dl class="rp-dl">${Object.entries(d).filter(([k]) => !["text", "body", "auth"].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}</dl>
      ${text ? `<blockquote class="pf-text">${esc(text)}</blockquote><p class="fine">${icon("alert")} Outside text: agents get it fenced as data, never as instructions.</p>` : ""}`;
  }
  if (i === 1) {
    const answers = events.filter((e) => e.type === "partial" || (e.type === "answered" && !("agreed" in (e.value ?? {}))));
    const asked = events.filter((e) => e.type === "asked");
    const roles = (step, agent) => ui.flows.find((f) => f.flow === c.flow)?.steps.find((s) => s.id === step)?.roles?.[agent];
    return `<ul class="rp-agents">${asked
      .map((a) => {
        const ans = answers.find((x) => x.step === a.step && (x.agent ?? a.agent) === a.agent && x.seq > a.seq);
        return `<li><div class="rp-agent-head"><b>${esc(a.agent)}</b>${roles(a.step, a.agent) ? `<span class="pill agent">${esc(roles(a.step, a.agent))}</span>` : `<span class="pill neutral">${esc(a.step)}</span>`}<span class="fine">${ans ? `answered after ${seconds(new Date(ans.at_iso) - new Date(a.at_iso))}` : "no answer recorded"}</span></div>${ans ? tree(ans.value) : ""}</li>`;
      })
      .join("")}</ul>${events.filter((e) => e.type === "reply_rejected" || e.type === "failed_over").map((e) => `<p class="rp-warn">${icon("alert")} ${esc(describe(e).text)}</p>`).join("")}`;
  }
  if (i === 2) {
    const v = checks.agent_evidence;
    if (!v) return none;
    const text = c.data.text;
    const quotes = [...(v.quotes ?? []), ...(v.findings ?? [])].filter((q) => q.in === "text").sort((a, b) => a.start - b.start);
    let html = "";
    let at = 0;
    if (typeof text === "string") {
      for (const q of quotes) {
        if (q.start < at) continue;
        html += esc(text.slice(at, q.start)) + `<mark>${esc(text.slice(q.start, q.end))}</mark>`;
        at = q.end;
      }
      html += esc(text.slice(at));
    }
    return `${html ? `<blockquote class="pf-text">${html}</blockquote>` : ""}<ul class="pf-quotes">${[...(v.quotes ?? []), ...(v.findings ?? [])].map((q) => `<li><code>${esc(q.quote)}</code> <span class="mono">${q.in === "text" ? `${q.start}–${q.end}` : esc(q.in)}</span></li>`).join("")}</ul>
      <p class="${v.ok ? "rp-ok" : "rp-warn"}">${icon(v.ok ? "check" : "alert")} ${esc(v.detail ?? "")}</p>`;
  }
  if (i === 7) {
    const ex = events.filter((e) => e.type === "executed");
    const stopped = events.filter((e) => e.type === "failed" || e.type === "in_doubt");
    return `${ex.map((e) => `<div class="rp-exec">${icon("send")} <b>${esc(e.receipt)}</b><div class="pf-hashes"><span>sent ${hx(e.hash)}</span>${e.readback ? `<span>bank read back ${hx(e.readback)}</span>` : ""}${e.rule ? `<span>released by rule: <code>${esc(e.rule.when)}</code></span>` : ""}</div></div>`).join("")}
      ${stopped.map((e) => `<p class="rp-warn">${icon("x")} ${esc(describe(e).text)}</p>`).join("")}
      ${!ex.length && !stopped.length ? `<p class="fine">No action ran: ${esc(c.outcome.label)}.</p>` : ""}`;
  }
  if (i === 8 || i === 9) {
    const p = ui.proof;
    if (!p || p.loading) return `<div class="skeleton" style="height:80px"></div><p class="fine">${i === 8 ? "Building the proof on the server…" : "Checking it…"}</p>`;
    if (p.error) return `<div class="notice error">${esc(p.error)}</div>`;
    if (i === 8) {
      return `<dl class="rp-dl"><dt>sections</dt><dd>${plural(Object.keys(p.proof.sections).length, "section")} + the flow + the log (${plural(p.proof.log.length, "event")})</dd><dt>root</dt><dd><code title="${esc(p.proof.root)}">${esc(p.proof.root.slice(0, 32))}…</code></dd>
        <dt>signature</dt><dd>${p.proof.signature ? `Ed25519 by key <code title="${esc(p.proof.signature.fingerprint)}">${esc(p.proof.signature.fingerprint.slice(0, 16))}…</code>` : "unsigned: no key loaded"}</dd></dl>`;
    }
    const bad = p.findings.filter((f) => !f.ok);
    return `<div class="pf-verdict ${bad.length ? "bad" : "ok"}">${icon(bad.length ? "x" : "lock")}<b>${bad.length ? `${plural(bad.length, "check")} of ${p.findings.length} fail` : `All ${p.findings.length} checks hold`}</b></div>
      <ul class="rp-findings">${[...p.findings].sort((a, b) => Number(a.ok) - Number(b.ok) || Number(/digest/.test(a.what)) - Number(/digest/.test(b.what))).map((f) => `<li class="${f.ok ? "ok" : "bad"}">${icon(f.ok ? "check" : "x")} ${esc(f.what)}</li>`).join("")}</ul>
      <p class="fine">Pinned: ${p.pinned ? esc(p.pinned.from) : "none"}. <a href="#proofs/${esc(c.id)}">Open it in the Proof Explorer</a>.</p>`;
  }
  // Stages 4-7: each event as a line, with its detail.
  if (!events.length) return none;
  if (i === 4) {
    const v = checks.payee;
    const tone = v.result === "match" || v.result === "mandate" ? "act" : v.result === "no_match" ? "stop" : "person";
    return `<div class="rp-payee tone-${tone}"><span class="k">the bank's answer <span class="tag sandbox">sandbox</span></span><b>${esc(String(v.result).replace(/_/g, " "))}</b><span>${esc(v.detail ?? "")}</span>${v.iban ? `<code>${esc(v.iban)}</code>` : ""}</div>`;
  }
  return `<ul class="rp-lines">${events
    .map((e) => ({ e, d: describe(e) }))
    .filter((x) => x.d)
    .map(({ e, d }) => `<li class="t-${d.tone}"><time>${esc(stamp(e.at_iso))}</time><span class="who">${esc(d.who ?? "")}</span><span>${esc(d.text)}</span>${e.type === "verified" && e.docs ? `<span class="docs">${Object.entries(e.docs).map(([n, h]) => `<span class="docref">${esc(n.startsWith("links:") ? `links on ${mask(n.slice(6))}` : n)} ${hx(h, 10)}</span>`).join(" ")}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

export function renderReplay(state, ui, rerender) {
  if (!state.loaded) return `<div class="skeleton" style="height:420px"></div>`;
  ui.flows = state.flows;
  const c = state.cases.find((x) => x.id === ui.id) ?? state.cases[0];
  if (!c) return `<div class="empty-state card"><h2>No cases to walk through</h2></div>`;
  if (ui.shown !== c.id) {
    stop(ui);
    Object.assign(ui, { shown: c.id, stage: 0, proof: null });
  }
  const per = STAGES.map((s) => (s.live ? [] : c.events.filter(s.has)));
  if (ui.stage >= 8) proofStage(c, ui, rerender);
  const rail = STAGES.map((s, i) => {
    const status = i < ui.stage ? "done" : i === ui.stage ? "current" : "todo";
    const empty = !s.live && !per[i].length;
    const at = per[i][0]?.at_iso;
    return `<li class="rp-stage ${status}${empty ? " empty" : ""}"><button data-stage="${i}"><span class="rp-num">${i + 1}</span><span class="rp-k">${icon(s.icon)} ${esc(s.k)}</span><span class="rp-at">${s.live ? "runs now" : empty ? "not in this case" : esc(stamp(at))}</span></button></li>`;
  }).join("");
  const s = STAGES[ui.stage];
  const options = state.cases
    .slice()
    .sort((a, b) => (b.openedAt ?? "").localeCompare(a.openedAt ?? ""))
    .map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(x.id)} · ${esc(x.title)} · ${esc(x.outcome.label)}</option>`)
    .join("");
  const pay = c.events.find((e) => e.type === "executed" && e.payload?.pay)?.payload.pay;
  return `<section class="rp-head">
      <div><h1>${icon("reroute")} Walk through a case</h1><p class="fine">A replay of case <span class="mono">${esc(c.id)}</span>'s recorded events, with the times they happened. The last two stages run now, on the server.</p></div>
      <label class="rp-pick">Case <select data-replay-case>${options}</select></label>
    </section>
    <div class="rp-layout">
      <ol class="rp-rail card">${rail}</ol>
      <article class="card rp-main">
        <div class="rp-stage-head"><span class="rp-big">${String(ui.stage + 1).padStart(2, "0")}</span><div><h2>${icon(s.icon)} ${esc(s.k)}</h2><p>${esc(s.what)}</p></div>
          <span class="rp-case"><b>${esc(c.title)}</b><span class="pill ${esc(c.outcome.tone)}">${esc(c.outcome.label)}</span>${pay ? `<span class="mono">${money(Number(pay.amount))} ${esc(pay.currency ?? "")} → ${esc(mask(pay.to))}</span>` : ""}</span></div>
        <div class="rp-body">${stageBody(ui.stage, c, per[ui.stage], ui)}</div>
        <div class="rp-controls">
          <button class="btn small" data-rp="restart">${icon("reroute")} Restart</button>
          <button class="btn small" data-rp="prev" ${ui.stage === 0 ? "disabled" : ""}>Back</button>
          <button class="btn small accent" data-rp="play">${ui.playing ? "Pause" : ui.stage === STAGES.length - 1 ? "Replay" : "Play"}</button>
          <button class="btn small" data-rp="next" ${ui.stage === STAGES.length - 1 ? "disabled" : ""}>Next</button>
          <a class="btn small" href="#${esc(c.id)}">${icon("doc")} Open the case</a>
        </div>
      </article>
    </div>`;
}

// Moves to the next stage that has something to show (live stages always do).
function next(state, ui) {
  const c = state.cases.find((x) => x.id === ui.shown);
  for (let i = ui.stage + 1; i < STAGES.length; i++) {
    if (STAGES[i].live || c.events.some(STAGES[i].has)) return i;
  }
  return ui.stage;
}

export function replayClick(e, state, ui, rerender) {
  const st = e.target.closest("[data-stage]");
  if (st) {
    stop(ui);
    ui.stage = Number(st.dataset.stage);
    return rerender();
  }
  const b = e.target.closest("[data-rp]");
  if (!b) return;
  const act = b.dataset.rp;
  if (act === "restart") {
    stop(ui);
    ui.stage = 0;
  } else if (act === "prev") {
    stop(ui);
    ui.stage = Math.max(0, ui.stage - 1);
  } else if (act === "next") {
    stop(ui);
    ui.stage = next(state, ui);
  } else if (act === "play") {
    if (ui.playing) stop(ui);
    else {
      if (ui.stage === STAGES.length - 1) ui.stage = 0;
      ui.playing = true;
      timer = setInterval(() => {
        if (document.getElementById("view-replay").hidden) return stop(ui);
        const n = next(state, ui);
        if (n === ui.stage) stop(ui);
        else ui.stage = n;
        rerender();
      }, 2600);
    }
  }
  rerender();
}

export function replayChange(e, ui, rerender) {
  const sel = e.target.closest("[data-replay-case]");
  if (!sel) return;
  ui.id = sel.value;
  history.replaceState(null, "", `#replay/${ui.id}${location.search}`);
  rerender();
}
