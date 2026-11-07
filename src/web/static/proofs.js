// The Proof Explorer: a case's signed proof, as the file holds it. The proof
// is the one /api/proof/<id> hands out (the same file `switchyard proof`
// writes), and every verdict on this page comes from `verifyProof` on the
// server, run on the exact bytes the browser sends: the downloaded proof, an
// edited copy, or a file a person drops in.

import { esc, hx, icon } from "./icons.js";
import { api, money, plural, setHash, stamp, tree, withToken } from "./views.js";

const SECTIONS = [
  ["source", "What arrived", "mail", "a digest of the case's data and text, the sender, the mail gateway's results"],
  ["agents", "What the agents answered", "bot", "each agent's structured answer, as recorded"],
  ["evidence", "Quotes, grounded in the invoice", "doc", "each quote at its character offsets in the invoice text"],
  ["checks", "Deterministic checks", "code", "every code check, with the room-document versions it read"],
  ["beneficiary", "Who the bank says holds the account", "user", "the payee check's answer (sandbox bank)"],
  ["links", "Links to other cases", "link", "accounts this case shares with blocked or other-vendor cases"],
  ["stale_approvals", "Approvals that stopped counting", "reroute", "re-checks after a document the checks read changed"],
  ["dissent", "Dissent ledger", "flag", "a decision's objections, each with its quote and status, and what code found binding"],
  ["decisions", "People's decisions", "hand", "each answer on a Switch card, with the person, role and action hashes"],
  ["executions", "Actions and the bank's receipts", "send", "what was sent, its hash, the bank's read-back, the rule it ran on"],
  ["assumptions", "Assumptions that broke", "alert", "Assumption Watch: what a carried-out decision rested on that stopped holding, and the case deciding again"],
  ["flow", "The flow it ran under", "fork", "the flow file as it was when the proof was made"],
  ["log", "The event log", "clock", "every event of the case, in recorded order"],
];

// How the verifier's findings group, by what they talk about.
const GROUPS = [
  ["Signature and key", /signature|signer|fingerprint|format is/],
  ["Digests", /digest|root/],
  ["The log", /sections are exactly|recorded order|flow inside/],
  ["Quotes", /in the invoice text/],
  ["Actions and rules", /./],
];

function load(id, ui, rerender) {
  const entry = { loading: true };
  ui.cache[id] = entry;
  api(`/api/proof/${encodeURIComponent(id)}`)
    .then(async (proof) => {
      const text = JSON.stringify(proof);
      const check = await api("/api/verify-proof", { method: "POST", body: text });
      Object.assign(entry, { loading: false, proof, text, findings: check.findings, pinned: check.pinned });
    })
    .catch((error) => Object.assign(entry, { loading: false, error: error.message }))
    .finally(rerender);
}

function findingsHtml(findings) {
  const left = [...findings];
  return GROUPS.map(([name, re]) => {
    const mine = left.filter((f) => re.test(f.what));
    for (const f of mine) left.splice(left.indexOf(f), 1);
    if (!mine.length) return "";
    const bad = mine.filter((f) => !f.ok).length;
    return `<div class="pf-group"><h4>${esc(name)} <span class="pill ${bad ? "stop" : "act"}">${bad ? `${bad} fail` : `${mine.length} hold`}</span></h4>
      <ul>${mine.map((f) => `<li class="${f.ok ? "ok" : "bad"}">${icon(f.ok ? "check" : "x")}<span>${esc(f.what)}</span></li>`).join("")}</ul></div>`;
  }).join("");
}

const verdict = (findings) => {
  const bad = findings.filter((f) => !f.ok).length;
  return bad
    ? `<div class="pf-verdict bad">${icon("x")}<b>${plural(bad, "check")} of ${findings.length} fail</b></div>`
    : `<div class="pf-verdict ok">${icon("lock")}<b>All ${findings.length} checks hold</b></div>`;
};

// The invoice text with each grounded quote marked at its offsets.
function marked(text, quotes) {
  const spans = quotes.filter((q) => q.in === "text" && Number.isInteger(q.start)).sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const q of spans) {
    if (q.start < at) continue;
    out += esc(text.slice(at, q.start)) + `<mark title="${esc(`${q.start}–${q.end}`)}">${esc(text.slice(q.start, q.end))}</mark>`;
    at = q.end;
  }
  return out + esc(text.slice(at));
}

function sectionBody(key, value, proof) {
  if (value === undefined || value === null || (Array.isArray(value) && !value.length)) return `<p class="fine">Nothing recorded in this case.</p>`;
  if (key === "evidence") {
    const text = proof.log.find((e) => e.type === "opened")?.data?.text;
    const quotes = [...(value.quotes ?? []), ...(value.findings ?? [])];
    return `<p class="fine">Grounding: <b>${esc(value.grounding ?? "")}</b>${value.dropped?.length ? ` · ${plural(value.dropped.length, "quote")} dropped as not in the source` : ""}</p>
      ${typeof text === "string" ? `<blockquote class="pf-text">${marked(text, quotes)}</blockquote>` : ""}
      <ul class="pf-quotes">${quotes.map((q) => `<li><code>${esc(q.quote)}</code> <span class="mono">${q.in === "text" ? `${q.start}–${q.end}` : esc(q.in)}</span></li>`).join("")}</ul>`;
  }
  if (key === "checks") {
    return `<table class="pf-table"><thead><tr><th>step</th><th>check</th><th></th><th>result</th><th>documents read</th></tr></thead><tbody>${value
      .map((c) => `<tr><td class="mono">${esc(c.step)}</td><td class="mono">${esc(c.check)}</td><td>${c.ok ? icon("check", "t-act") : icon("x", "t-stop")}</td><td>${esc(c.detail ?? "")}</td><td>${Object.entries(c.documents ?? {}).map(([d, h]) => `<span class="docref">${esc(d)} ${hx(h, 10)}</span>`).join(" ")}</td></tr>`)
      .join("")}</tbody></table>`;
  }
  if (key === "dissent") {
    return `<p class="fine">${esc(value.detail ?? "")}</p><table class="pf-table"><thead><tr><th>from</th><th>objection</th><th>quote</th><th>weight</th><th>status</th></tr></thead><tbody>${(value.ledger ?? [])
      .map((l) => `<tr><td>${esc(l.from)}</td><td>${esc(l.claim)}</td><td>${l.quote ? `<code>${esc(l.quote)}</code> ${l.grounded ? `<span class="mono">${l.grounded.start}–${l.grounded.end}</span>` : ""}` : ""}</td><td>${esc(l.materiality)}</td><td>${esc(l.status)}</td></tr>`)
      .join("")}</tbody></table>`;
  }
  if (key === "decisions") {
    return `<table class="pf-table"><thead><tr><th>who</th><th>as</th><th>answer</th><th>when</th><th>approves</th></tr></thead><tbody>${value
      .map((d) => `<tr><td>${esc(d.by)}</td><td>${esc(d.role ?? "")}</td><td><span class="pill ${d.approved ? "act" : "stop"}">${esc(d.answer)}</span></td><td>${esc(stamp(d.at))}</td><td>${Object.entries(d.approves ?? {}).map(([s, h]) => `<span class="docref">${esc(s)} ${hx(h, 12)}</span>`).join(" ")}</td></tr>`)
      .join("")}</tbody></table>`;
  }
  if (key === "executions") {
    return value
      .map((x) => {
        const pay = x.payload?.pay;
        return `<div class="pf-exec"><div class="pf-exec-head"><b class="mono">${esc(x.step)}</b> <span class="pill neutral">${esc(x.kind ?? "")}</span> <span>${esc(x.receipt ?? "")}</span></div>
          ${pay ? `<div class="pf-pay"><span>${money(Number(pay.amount))} ${esc(pay.currency ?? "")}</span><span>to <code>${esc(pay.to)}</code></span><span>payee ${esc(pay.payee ?? "")}</span><span>ref ${esc(pay.reference ?? "")}</span></div>` : ""}
          <div class="pf-hashes"><span>sent ${hx(x.hash)}</span>${x.readback ? `<span>bank read back ${hx(x.readback)}</span>` : ""}</div>
          ${x.rule !== undefined ? `<div class="pf-rule"><span class="k">${x.rule === true ? "Sent once its condition held; no approval needed" : "No person approved it; sent on the rule"}</span>${x.rule === true ? "" : `<code>${esc(x.rule)}</code>`}
            ${x.rule_inputs && Object.keys(x.rule_inputs).length ? `<table class="pf-table"><thead><tr><th>the rule read</th><th>value</th></tr></thead><tbody>${Object.entries(x.rule_inputs).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(JSON.stringify(v))}</td></tr>`).join("")}</tbody></table>` : ""}</div>` : ""}</div>`;
      })
      .join("");
  }
  if (key === "log") {
    return `<div class="pf-scroll"><table class="pf-table"><thead><tr><th>seq</th><th>recorded</th><th>type</th><th>step</th></tr></thead><tbody>${value
      .map((e) => `<tr><td class="mono">${esc(e.seq)}</td><td class="mono">${esc(String(e.at_iso ?? "").replace("T", " ").replace(/\.\d+Z$/, "Z"))}</td><td class="mono">${esc(e.type)}</td><td class="mono">${esc(e.step ?? "")}</td></tr>`)
      .join("")}</tbody></table></div>`;
  }
  if (key === "flow") return `<p class="fine"><b class="mono">${esc(value.flow)}</b> · ${plural(value.steps?.length ?? 0, "step")} · room #${esc(value.room ?? "")}</p>${tree(value)}`;
  return tree(value);
}

const count = (key, value) => {
  if (value === undefined || value === null) return "none";
  if (key === "evidence") return plural((value.quotes?.length ?? 0) + (value.findings?.length ?? 0), "quote");
  if (key === "beneficiary") return esc(value.result ?? "");
  if (key === "dissent") return plural(value.ledger?.length ?? 0, "entry", "entries");
  if (key === "links") return plural(value.links?.length ?? 0, "link");
  if (key === "flow") return plural(value.steps?.length ?? 0, "step");
  if (Array.isArray(value)) return plural(value.length, key === "log" ? "event" : "item");
  return "recorded";
};

function explorer(c, entry, ui) {
  if (!entry || entry.loading) return `<div class="pf-loading"><div class="skeleton" style="height:80px"></div><div class="skeleton" style="height:420px"></div></div>`;
  if (entry.error) return `<div class="notice error">Could not load this case's proof: ${esc(entry.error)}</div>`;
  const p = entry.proof;
  const href = withToken(`/api/proof/${encodeURIComponent(c.id)}`);
  const open = ui.open ?? new Set(["evidence", "executions"]);
  const blocks = SECTIONS.map(([key, title, ico, what]) => {
    const value = key === "flow" ? p.flow : key === "log" ? p.log : p.sections[key];
    const isOpen = open.has(key);
    return `<li class="pf-block${isOpen ? " open" : ""}">
      <button class="pf-block-head" data-section="${key}" aria-expanded="${isOpen}">
        <span class="pf-ico">${icon(ico)}</span>
        <span class="pf-title"><b>${esc(title)}</b><span>${esc(what)}</span></span>
        <span class="pf-count">${count(key, value)}</span>
        <span class="pf-digest" title="${esc(p.digests[key] ?? "")}"><span class="k">sha-256</span>${esc((p.digests[key] ?? "").slice(0, 12))}</span>
      </button>
      ${isOpen ? `<div class="pf-block-body">${sectionBody(key, value, p)}</div>` : ""}</li>`;
  }).join("");
  const sig = p.signature;
  const sigOk = entry.findings.find((f) => /signature over the root is valid/.test(f.what))?.ok;
  const pinOk = entry.findings.find((f) => /signer is the pinned key|key is pinned/.test(f.what))?.ok;
  return `
    <div class="pf-top">
      <div><h2>${esc(c.title)}</h2><div class="meta"><span class="mono">${esc(p.format)}</span><span class="sep">·</span><span class="mono">case ${esc(c.id)}</span><span class="sep">·</span><span>${esc(p.case.flow)}</span><span class="sep">·</span><span>opened ${esc(stamp(p.case.opened_at))}</span></div></div>
      <div class="pf-actions">
        <a class="btn small" href="#${esc(c.id)}">${icon("doc")} Open case</a>
        <a class="btn small" href="#replay/${esc(c.id)}">${icon("reroute")} Walk through</a>
        <a class="btn small accent" href="${href}" download="${esc(c.id)}.proof.json">${icon("lock")} Download proof</a>
      </div>
    </div>
    <div class="pf-grid">
      <div>
        <ol class="pf-chain">${blocks}</ol>
      </div>
      <aside class="pf-seal">
        <div class="pf-seal-step"><span class="k">${Object.keys(p.digests).length} digests</span><span>one SHA-256 per section, over its canonical JSON</span></div>
        <div class="pf-seal-step"><span class="k">root</span><code title="${esc(p.root)}">${esc(p.root.slice(0, 24))}…</code></div>
        <div class="pf-seal-step ${sig ? (sigOk ? "ok" : "bad") : "bad"}"><span class="k">Ed25519 signature</span>${sig ? `<code title="${esc(sig.value)}">${esc(sig.value.slice(0, 24))}…</code><span>key <code title="${esc(sig.fingerprint)}">${esc(sig.fingerprint.slice(0, 16))}…</code></span>` : "<span>unsigned: this Switchyard has no key</span>"}</div>
        <div class="pf-seal-step ${pinOk ? "ok" : "bad"}"><span class="k">pinned key</span>${entry.pinned ? `<code title="${esc(entry.pinned.fingerprint)}">${esc(entry.pinned.fingerprint.slice(0, 16))}…</code><span>${esc(entry.pinned.from)}</span>` : "<span>none pinned</span>"}</div>
        ${verdict(entry.findings)}
        <p class="fine">Checked by <code>verifyProof</code> on this exact file: no model, no Switch, no bank. The same check runs offline with <code>npm run switchyard verify-proof &lt;file&gt; -- --fingerprint &lt;hex&gt;</code>.</p>
        <div class="pf-tamper">
          <button class="btn small" data-tamper="amount">${icon("alert")} Check a copy with the amount changed</button>
          <button class="btn small" data-tamper="quote">${icon("alert")} Check a copy with a quote moved</button>
          ${ui.tamper?.id === c.id ? `<div class="pf-tampered"><p class="fine">Edited in this browser: ${esc(ui.tamper.what)}. Only the edited file was sent to the verifier.</p>${ui.tamper.findings ? verdict(ui.tamper.findings) + `<ul class="pf-fails">${ui.tamper.findings.filter((f) => !f.ok).map((f) => `<li>${icon("x")} ${esc(f.what)}</li>`).join("")}</ul>` : '<div class="skeleton" style="height:40px"></div>'}</div>` : ""}
        </div>
        <label class="pf-drop" data-drop>${icon("doc")}<span><b>Check a proof file</b><span>Drop a <code>.proof.json</code> here, or choose one</span></span><input type="file" accept=".json,application/json"></label>
        ${ui.dropped ? `<div class="pf-tampered"><p class="fine"><b>${esc(ui.dropped.name)}</b></p>${ui.dropped.findings ? verdict(ui.dropped.findings) + `<ul class="pf-fails">${ui.dropped.findings.filter((f) => !f.ok).map((f) => `<li>${icon("x")} ${esc(f.what)}</li>`).join("")}</ul>` : ui.dropped.error ? `<div class="notice error">${esc(ui.dropped.error)}</div>` : '<div class="skeleton" style="height:40px"></div>'}</div>` : ""}
      </aside>
    </div>
    <section class="card pf-findings"><h3>${icon("check")} What the verifier checked</h3>${findingsHtml(entry.findings)}</section>`;
}

export function renderProofs(state, ui, rerender) {
  ui.cache ??= {};
  if (!state.loaded) return `<div class="pf-loading"><div class="skeleton" style="height:420px"></div></div>`;
  const withActions = state.cases.filter((c) => c.events.some((e) => e.type === "executed"));
  const paid = (c) => c.events.some((e) => e.type === "executed" && e.payload?.pay);
  const list = [...withActions.filter(paid), ...withActions.filter((c) => !paid(c)), ...state.cases.filter((c) => !withActions.includes(c))];
  if (!list.length) return `<div class="empty-state card">${icon("lock")}<h2>No cases yet</h2><p>Every case gets a signed proof once it exists. Send one with <code>npm run switchyard demo send fabrikam-invoice</code>.</p></div>`;
  ui.id = list.some((c) => c.id === ui.id) ? ui.id : list[0].id;
  const c = state.cases.find((x) => x.id === ui.id);
  if (!ui.cache[c.id] || (ui.cache[c.id].proof && ui.cache[c.id].proof.log.length !== c.events.length)) load(c.id, ui, rerender);
  const items = list
    .map((x) => {
      const pay = x.events.find((e) => e.type === "executed" && e.payload?.pay)?.payload.pay;
      return `<li><button class="pf-pick" data-proof="${esc(x.id)}" aria-current="${x.id === c.id}"><span class="t">${esc(x.title)}</span><span class="s"><span class="pill ${esc(x.outcome.tone)}">${esc(x.outcome.label)}</span>${pay ? `<span class="mono">${money(Number(pay.amount))} ${esc(pay.currency ?? "")}</span>` : ""}<span class="mono">${esc(x.id)}</span></span></button></li>`;
    })
    .join("");
  return `<div class="pf-layout">
    <aside class="card pf-list"><h3>${icon("lock")} Proofs</h3><p class="fine">Every case can export one. Payments first.</p><ol>${items}</ol></aside>
    <article class="card pf-main">${explorer(c, ui.cache[c.id], ui)}</article>
  </div>`;
}

async function check(text) {
  return (await api("/api/verify-proof", { method: "POST", body: text })).findings;
}

export function proofClick(e, state, ui, rerender) {
  const pick = e.target.closest("[data-proof]");
  if (pick) {
    ui.id = pick.dataset.proof;
    ui.tamper = null;
    setHash(`proofs/${ui.id}`);
    return rerender();
  }
  const head = e.target.closest("[data-section]");
  if (head) {
    ui.open ??= new Set(["evidence", "executions"]);
    const k = head.dataset.section;
    ui.open.has(k) ? ui.open.delete(k) : ui.open.add(k);
    return rerender();
  }
  const tamper = e.target.closest("[data-tamper]");
  const entry = ui.cache?.[ui.id];
  if (tamper && entry?.proof) {
    const copy = JSON.parse(entry.text);
    let what = "";
    if (tamper.dataset.tamper === "amount") {
      const ex = copy.log.find((x) => x.type === "executed" && x.payload?.pay) ?? copy.log.find((x) => x.type === "executed");
      if (ex?.payload?.pay) {
        const was = ex.payload.pay.amount;
        ex.payload.pay.amount = String(Number(was) + 1);
        what = `the paid amount in the log, ${was} → ${ex.payload.pay.amount}`;
      } else if (ex) {
        ex.receipt = `${ex.receipt} (edited)`;
        what = "the receipt of the first action in the log";
      } else what = "nothing: this case has no action to edit";
    } else {
      const q = copy.sections.evidence?.quotes?.[0];
      if (q && Number.isInteger(q.start)) {
        q.start += 3;
        q.end += 3;
        what = `the first quote's offsets, moved by 3 characters ("${q.quote}")`;
      } else what = "nothing: this case has no grounded quote";
    }
    ui.tamper = { id: ui.id, what, findings: null };
    rerender();
    check(JSON.stringify(copy))
      .then((findings) => (ui.tamper.findings = findings))
      .catch((error) => (ui.tamper.findings = [{ ok: false, what: error.message }]))
      .finally(rerender);
  }
}

export function proofDrop(e, ui, rerender) {
  const file = e.type === "drop" ? e.dataTransfer?.files?.[0] : e.target.closest?.("[data-drop]") && e.target.files?.[0];
  if (!file) return;
  e.preventDefault();
  ui.dropped = { name: file.name, findings: null };
  rerender();
  file
    .text()
    .then(check)
    .then((findings) => (ui.dropped.findings = findings))
    .catch((error) => (ui.dropped.error = error.message))
    .finally(rerender);
}
