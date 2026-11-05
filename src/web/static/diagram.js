// The interlocking diagram: a flow drawn as a yard of tracks and, for a case,
// what actually happened on it. Laid out by hand (x = step order, y = lane):
// flows are short chains with at most a fork, so no layout library. Every
// mark comes from the flow file or the case's event log; nothing is drawn
// that the engine did not record.

import { esc, PATHS, INLET_ICON, STEP_ICON } from "./icons.js";

const COL = 120; // one station
const PAR = 236; // a parallel step: fork, one lane per agent, junction
const MAIN = 120; // y of the main line
const R = 16; // station radius
const SIDING = MAIN + 98; // y of a bench agent's siding

const trunc = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Time until `t`, as a person reads it on a clock.
export function left(t, now = Date.now()) {
  const ms = t - now;
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function glyph(name, x, y, size = 14) {
  return `<svg class="g" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ""}</svg>`;
}

// One line of text under a station; `full` becomes its tooltip when cut.
function text(x, y, cls, value, max = 18, full = value) {
  const shown = trunc(value, max);
  const tip = String(full ?? "") !== shown ? `<title>${esc(full)}</title>` : "";
  return `<text x="${x}" y="${y}" class="${cls}" text-anchor="middle">${tip}${esc(shown)}</text>`;
}

// What the event log says about each step of one case.
function facts(c) {
  const f = { status: {}, lanes: {}, agreed: {}, failover: {}, verified: {}, answered: {}, executed: {}, hashes: {} };
  if (!c) return f;
  for (const s of c.stations) f.status[s.id] = s.status;
  for (const e of c.events) {
    if (e.type === "fanned_out") for (const a of e.agents) (f.lanes[e.step] ??= {})[a] ??= c.status === "open" ? "current" : "todo";
    if (e.type === "partial") (f.lanes[e.step] ??= {})[e.agent] = e.value?.unavailable ? "stopped" : "done";
    if (e.type === "answered" && e.value && typeof e.value === "object" && "agreed" in e.value) f.agreed[e.step] = e.value.agreed;
    if (e.type === "failed_over") f.failover[e.step] = e;
    if (e.type === "verified") f.verified[e.step] = e;
    if (e.type === "gate_opened") Object.assign(f.hashes, e.hashes);
    if (e.type === "gate_answered") f.answered[e.step] = e;
    if (e.type === "executed") f.executed[e.step] = e;
  }
  return f;
}

// A clock ring around the station a case is waiting at: it fills from when
// the wait began to when the engine's tick() acts next (escalation, failover,
// or the end of a wait). Gates also mark the reminder, sent at half time.
function ring(x, since, until, now, remindAt) {
  if (since == null || until == null || until <= since) return "";
  const r = R + 7;
  const C = 2 * Math.PI * r;
  const frac = Math.min(1, Math.max(0, (now - since) / (until - since)));
  const late = now >= until ? " late" : "";
  let tick = "";
  if (remindAt) {
    const a = ((remindAt - since) / (until - since)) * 2 * Math.PI - Math.PI / 2;
    const p = (d) => `${(x + Math.cos(a) * d).toFixed(1)},${(MAIN + Math.sin(a) * d).toFixed(1)}`;
    tick = `<path class="ring-tick" d="M${p(r - 4)} L${p(r + 4)}"><title>reminder</title></path>`;
  }
  return `<g class="clock${late}"><circle class="ring-track" cx="${x}" cy="${MAIN}" r="${r}"/>
    <circle class="ring" cx="${x}" cy="${MAIN}" r="${r}" stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${x} ${MAIN})"/>${tick}</g>`;
}

export function diagram(flow, c = null, vendors = {}, now = Date.now()) {
  const F = facts(c);
  // A step still "todo" after a later step ran was added to the flow after
  // this case passed that point: it is shown, but as not part of this run.
  const order = flow.steps.map((s) => s.id);
  const stateOf = (id) => {
    if (!c) return "plan";
    const st = F.status[id] ?? "todo";
    if (st === "todo" && order.slice(order.indexOf(id) + 1).some((later) => (F.status[later] ?? "todo") !== "todo")) return "absent";
    return st;
  };
  const vendorText = (handle, x, y) => (vendors[handle] ? `<text x="${x}" y="${y}" class="vt v-${esc(vendors[handle])}" text-anchor="middle">${esc(vendors[handle])}</text>` : "");
  const w = c?.waiting;

  // Positions: an inlet, then each step left to right.
  const inletX = 30;
  let cursor = 62;
  const pos = flow.steps.map((step) => {
    const width = step.kind === "parallel" ? PAR : COL;
    const p = { step, left: cursor, width, x: cursor + width / 2 };
    cursor += width;
    return p;
  });
  const byId = Object.fromEntries(pos.map((p) => [p.step.id, p]));
  const W = cursor + 12;
  let top = MAIN - 34;
  let bottom = MAIN + 80;

  const edges = [];
  const below = []; // sidings, drawn under the stations
  const nodes = [];
  const above = []; // binding arcs and documents

  // The inlet.
  const inletKinds = flow.inlets.map((i) => i.kind);
  nodes.push(`<g class="n inlet ${c ? "done" : "plan"}"><rect class="shape" x="${inletX - 14}" y="${MAIN - 14}" width="28" height="28" rx="8"/>${glyph(INLET_ICON[inletKinds[0]] ?? "form", inletX, MAIN)}</g>
    ${text(inletX, MAIN + R + 16, "lbl", "in", 6)}${text(inletX, MAIN + R + 30, "sub", inletKinds.join(" + "), 12)}`);

  let prevRight = inletX + 14;
  for (const p of pos) {
    const { step, x, left: L } = p;
    const st = stateOf(step.id);
    const on = c && st !== "todo" ? " on" : "";
    const nodeCls = st === "absent" ? "skipped absent" : st;
    const inContact = step.kind === "parallel" ? L + 4 : x - R;

    // The track into this station, with a diamond where a condition decides.
    edges.push(`<path class="edge${on}" d="M${prevRight},${MAIN} L${inContact},${MAIN}"/>`);
    if (step.when) {
      const mx = (prevRight + inContact) / 2;
      const skipped = st === "skipped";
      edges.push(`<g class="cond-mark${skipped ? " false" : ""}"><title>${esc(`${skipped ? "false: " : "if "}${step.when}`)}</title><rect x="${mx - 4}" y="${MAIN - 4}" width="8" height="8" transform="rotate(45 ${mx} ${MAIN})"/></g>`);
    }

    if (step.kind === "parallel") {
      prevRight = parallel(p, st);
      continue;
    }

    // The station itself.
    const v = F.verified[step.id];
    const bad = (v && v.value?.ok === false) || st === "stopped" ? " bad" : "";
    const icon = st === "done" && !bad ? "check" : bad ? "x" : STEP_ICON[step.kind];
    const shape = step.kind === "verify"
      ? `<rect class="shape" x="${x - 15}" y="${MAIN - 15}" width="30" height="30" rx="7"/>`
      : `<circle class="shape" cx="${x}" cy="${MAIN}" r="${R}"/>`;
    let clock = "";
    if (st === "current" && w) {
      if (w.kind === "person" && w.deadlineAt) clock = ring(x, w.since, w.deadlineAt, now, w.remindAt);
      else if (w.kind === "agent" && w.slaAt) clock = ring(x, w.since, w.slaAt, now);
      else if (w.kind === "wait") clock = ring(x, w.since, w.until, now);
    }
    nodes.push(`<g class="n k-${step.kind} ${nodeCls}${bad}">${clock}${st === "current" ? `<circle class="halo" cx="${x}" cy="${MAIN}" r="${R + 3}"/>` : ""}${shape}${glyph(icon, x, MAIN)}<title>${esc(step.id)}: ${esc(st === "plan" ? step.kind : st === "absent" ? "added to the flow after this case passed here" : st)}</title></g>`);

    // Its lines of text, stacked under it.
    const lines = [["lbl", step.label, 16]];
    const who = step.kind === "verify" ? step.who.replace(/^code: /, "code · ") : step.kind === "outlet" ? `${step.who}${step.autoRule ? " · or by rule" : ""}` : step.who;
    lines.push(["sub", who, 17, step.autoRule && step.autoRule !== true ? `${who}: ${step.autoRule}` : who]);
    if (step.kind === "agent" && vendors[step.who]) lines.push(["vendor", step.who]);
    if (step.when) lines.push([`cond${st === "skipped" ? " struck" : ""}`, `if ${step.when}`, 17, `${st === "skipped" ? "was false: " : "if "}${step.when}`]);
    const t = timing(step, st, x);
    if (t) lines.push(t);
    let y = MAIN + R + 16;
    for (const [cls, value, max, full] of lines) {
      nodes.push(cls === "vendor" ? vendorText(value, x, y) : text(x, y, cls, value, max, full));
      y += 14;
    }
    bottom = Math.max(bottom, y - 4);

    // A bench agent waits on a siding below; it lights up when it took over.
    if (step.kind === "agent" && step.backup) {
      const fo = F.failover[step.id];
      const lit = fo ? " lit" : "";
      const sideState = fo ? (st === "done" ? "done" : st) : c ? "idle" : "plan";
      below.push(`<path class="siding${lit}" d="M${x - 62},${MAIN} C${x - 50},${MAIN} ${x - 54},${SIDING} ${x - 34},${SIDING} L${x + 34},${SIDING} C${x + 54},${SIDING} ${x + 50},${MAIN} ${x + 62},${MAIN}">
        <title>${esc(fo ? `${fo.from} → ${fo.to}: ${fo.reason}` : `bench: ${step.backup} takes over if ${step.who} fails or misses its SLA`)}</title></path>`);
      nodes.push(`<g class="n bench k-agent ${sideState}"><circle class="shape" cx="${x}" cy="${SIDING}" r="11"/>${glyph(fo && st === "done" ? "check" : "bot", x, SIDING, 12)}</g>
        ${text(x, SIDING + 24, "sub", step.backup, 18)}${vendorText(step.backup, x, SIDING + 37)}`);
      bottom = Math.max(bottom, SIDING + 42);
    }

    // A code check reads a room document; show which, and which version.
    if (step.kind === "verify" && step.doc) {
      const hash = v?.docs?.[step.doc]?.replace(/^row:/, "");
      const row = v?.rows?.[step.doc];
      above.push(`<g class="doc-chip"><path class="doc-link" d="M${x},${MAIN - 16} L${x},${MAIN - 38}"/>
        <rect x="${x - 57}" y="${MAIN - 70}" width="114" height="${hash ? 32 : 22}" rx="6"/>${glyph("doc", x - 46, MAIN - 59, 11)}
        <text x="${x - 38}" y="${MAIN - 55}" class="sub">${esc(trunc(step.doc, 15))}</text>
        ${hash ? `<text x="${x - 38}" y="${MAIN - 43}" class="hashtext">${esc(hash)}</text>` : ""}
        <title>${esc(hash ? `${step.doc}${row ? `, ${row}'s row` : ""}, version ${hash}: the exact text this check read, from the Switch room` : `${step.doc}: a document in the Switch room`)}</title></g>`);
      top = Math.min(top, MAIN - 74);
    }
    prevRight = x + R;
  }

  // Approval → action: each gate is bound to the exact actions it covers.
  // With a case, the arc carries the hash on the card, and locks when the
  // executed action hashed the same.
  for (const p of pos.filter((q) => q.step.kind === "gate")) {
    const targets = p.step.approves ?? [];
    targets.forEach((target, j) => {
      const o = byId[target];
      if (!o) return;
      const hash = F.hashes[target];
      const ex = F.executed[target];
      const ans = F.answered[p.step.id];
      let cls = "plan";
      let label = `covers ${target.replace(/_/g, " ")}`;
      if (c && hash) {
        if (ex) [cls, label] = ex.hash === hash ? ["ok", `${hash.slice(0, 8)} = executed`] : ["bad", `${hash.slice(0, 8)} ≠ ${ex.hash.slice(0, 8)}`];
        else if (ans && !ans.approved) [cls, label] = ["declined", `${hash.slice(0, 8)} · not approved`];
        else if (ans) [cls, label] = ["held", `${hash.slice(0, 8)} · approved`];
        else if (c.status !== "open") [cls, label] = ["declined", `${hash.slice(0, 8)} · never answered`];
        else [cls, label] = ["held", `${hash.slice(0, 8)} · on the card`];
      } else if (c) {
        cls = "idle";
        label = "no card";
      }
      const y0 = MAIN - R - 1;
      const ctl = MAIN - 70 - 32 * j;
      // The outermost arc is labelled at its peak. Inner arcs are labelled
      // beside their arrowhead, where no other arc of this gate passes.
      const outer = j === targets.length - 1;
      // Inner labels stay short so they end before the next arc comes down.
      if (!outer) label = c && hash ? `${hash.slice(0, 8)}${cls === "declined" ? " ✗" : ""}` : trunc(label, 15);
      const peak = y0 + 0.75 * (ctl - y0);
      const locked = cls === "ok" || cls === "held";
      const lx = outer ? (p.x + o.x) / 2 - (label.length * 6.3 + (locked ? 14 : 0)) / 2 : o.x + 10;
      const ly = outer ? peak - 5 : y0 - 10;
      const tip = cls === "plan"
        ? `${p.step.id} approves the exact rendered ${target}; any change to it needs a new card`
        : hash ? `card hash ${hash}${ex ? `, executed hash ${ex.hash}${ex.hash === hash ? " (match)" : " (MISMATCH)"}` : ans ? ` (${ans.approved ? "approved" : `${ans.answer}: not approved`})` : ""}` : `${p.step.id} never opened a card in this case`;
      above.push(`<g class="bind ${cls}"><title>${esc(tip)}</title>
        <path class="arc" d="M${p.x},${y0} C${p.x},${ctl} ${o.x},${ctl} ${o.x},${y0 - 2}" marker-end="url(#arrow-${esc(flow.flow)})"/>
        ${locked ? glyph("lock", lx + 5, ly - 4, 11) : ""}
        <text x="${lx + (locked ? 13 : 0)}" y="${ly}" class="arc-label">${esc(label)}</text></g>`);
      top = Math.min(top, peak - 20);
    });
  }

  function timing(step, st, x) {
    if (st === "absent") return ["tm muted", "added after this run", 22];
    if (!c) {
      if (step.kind === "agent" && step.sla) return ["tm", `SLA ${step.sla}`, 20];
      if (step.kind === "gate" && step.deadline) return ["tm", `decide in ${step.deadline}${step.backup ? ` → ${step.backup}` : ""}`, 22];
      if (step.kind === "wait") return null;
      return null;
    }
    if (st === "current" && w) {
      if (w.kind === "person" && w.doubt) return ["tm bad", "in doubt: a person decides", 22];
      if (w.kind === "person" && w.deadlineAt) {
        if (w.escalated) return ["tm late", `escalated to ${w.escalateTo ?? "?"}`, 22];
        return ["tm", `${w.escalateTo ? `→ ${w.escalateTo}` : "due"} in ${left(w.deadlineAt, now)}`, 22];
      }
      if (w.kind === "agent" && w.slaAt) return ["tm", `${w.bench ? `→ ${w.bench}` : "→ a person"} in ${left(w.slaAt, now)}`, 22];
      if (w.kind === "wait") return ["tm", `resumes in ${left(w.until, now)}`, 22];
    }
    if (step.kind === "gate" && F.answered[step.id]) {
      const a = F.answered[step.id];
      return [`tm ${a.approved ? "ok" : "bad"}`, `${a.answer} · ${a.answeredBy}`, 22];
    }
    if (step.kind === "verify" && F.verified[step.id]) {
      const v = F.verified[step.id].value ?? {};
      return [`tm ${v.ok ? "ok" : "bad"}`, v.ok ? "passed" : v.detail, 18, v.detail];
    }
    if (step.kind === "outlet" && F.executed[step.id]) return ["tm ok", F.hashes[step.id] ? "done as approved" : "done by rule", 20];
    if (step.kind === "agent" && F.failover[step.id]) return ["tm", `done by ${F.failover[step.id].to}`, 22];
    return null;
  }

  // A parallel step: the track forks into one lane per agent, and rejoins at
  // a junction that shows whether they agreed.
  function parallel(p, st) {
    const { step, left: L, width } = p;
    const agents = step.agents ?? [];
    const jx = L + width - 26;
    const nx = L + 58;
    const lanes = F.lanes[step.id] ?? {};
    agents.forEach((a, k) => {
      const y = MAIN + (k - (agents.length - 1) / 2) * 58;
      const ls = c ? (lanes[a] ?? (st === "current" ? "current" : "todo")) : "plan";
      const on = c && ls !== "todo" ? " on" : "";
      edges.push(`<path class="edge${on}" d="M${L + 4},${MAIN} C${L + 26},${MAIN} ${L + 22},${y} ${L + 44},${y} L${nx - 13},${y}"/>`);
      edges.push(`<path class="edge${c && (ls === "done" || ls === "stopped") ? " on" : ""}" d="M${nx + 13},${y} L${jx - 34},${y} C${jx - 14},${y} ${jx - 18},${MAIN} ${jx - 7},${MAIN}"/>`);
      const icon = ls === "done" ? "check" : ls === "stopped" ? "x" : "bot";
      nodes.push(`<g class="n k-agent ${ls}${ls === "stopped" ? " bad" : ""}">${ls === "current" ? `<circle class="halo" cx="${nx}" cy="${y}" r="16"/>` : ""}<circle class="shape" cx="${nx}" cy="${y}" r="13"/>${glyph(icon, nx, y, 12)}</g>
        <text x="${nx + 19}" y="${y - 5}" class="sub lane-h">${esc(trunc(a, 16))}</text>
        ${vendors[a] ? `<text x="${nx + 19}" y="${y + 13}" class="vt v-${esc(vendors[a])}">${esc(vendors[a])}</text>` : ""}`);
      top = Math.min(top, y - 22);
      bottom = Math.max(bottom, y + 18);
    });
    const agreed = F.agreed[step.id];
    const jcls = agreed === undefined ? (c ? "todo" : "plan") : agreed ? "ok" : "bad";
    nodes.push(`<g class="junction ${jcls}"><title>${esc(agreed === undefined ? "the answers must match field by field, numbers to the cent" : agreed ? "every checker gave the same answer" : "the checkers disagreed, or one could not answer")}</title>
      <rect x="${jx - 7}" y="${MAIN - 7}" width="14" height="14" transform="rotate(45 ${jx} ${MAIN})"/></g>
      ${agreed === undefined ? "" : `<text x="${jx + 11}" y="${MAIN - 8}" class="tm ${agreed ? "ok" : "bad"}">${agreed ? "agreed" : "split"}</text>`}`);
    const ly = MAIN + ((agents.length - 1) / 2) * 58 + 34;
    nodes.push(text(L + width / 2, ly, "lbl", `${step.label} · ${agents.length} checkers`, 28));
    const t = c ? timing(step, st, p.x) : step.sla ? ["tm", `independent · SLA ${step.sla}`, 26] : null;
    if (t) nodes.push(text(L + width / 2, ly + 14, t[0], t[1], t[2], t[3]));
    bottom = Math.max(bottom, ly + 18);
    return jx + 7;
  }

  // The end of the line: where the case came to.
  edges.push(`<path class="edge${c && c.status !== "open" ? " on" : ""}" d="M${prevRight},${MAIN} L${W - 12},${MAIN}"/>`);
  const endCls = !c ? "plan" : c.status === "open" ? "todo" : c.outcome?.tone ?? "neutral";
  nodes.push(`<path class="buffer ${endCls}" d="M${W - 12},${MAIN - 10} L${W - 12},${MAIN + 10}"/>`);

  const H = bottom - top + 8;
  return `<svg class="dg ${c ? "case" : "plan"}" viewBox="0 ${top - 4} ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${flow.description}: ${flow.steps.map((s) => `${s.label} (${c ? stateOf(s.id) : s.kind})`).join(", ")}`)}" style="--w:${W}px">
    <defs><marker id="arrow-${esc(flow.flow)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class="arrowhead"/></marker></defs>
    ${below.join("")}${edges.join("")}${above.join("")}${nodes.join("")}
  </svg>`;
}
