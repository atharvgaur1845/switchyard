// The About page: what Switchyard is and how every part works, with
// diagrams. The diagrams are Mermaid source; the README embeds the same
// text (a test keeps the two identical), and this page draws it with
// Mermaid from a CDN. Offline, the source is shown as text.

import { esc, icon } from "./icons.js";

export const DIAGRAMS = {
  architecture: `flowchart TB
  IN["Inlets<br/>email, signed webhooks, forms, schedules"] --> R
  subgraph ENG["Switchyard engine (@yard)"]
    R["Runner<br/>runs each flow's steps, one at a time"] --> C["Code checks<br/>policy, commitments, PO, vendor master,<br/>payee, quotes, links"]
    R --> L[("Event log<br/>append-only, SQLite")]
    L --> P["Signed proofs<br/>Ed25519"]
  end
  R <--> A["Switch agents<br/>Claude Haiku, Gemini, tools switched off"]
  C <--> D["Switch room documents<br/>commitments, capacity, policy,<br/>vendor-master, purchase-orders"]
  R <--> K["Switch approval cards<br/>named people in Slack, one thread per case"]
  R --> O["Outlets, only after approval<br/>sandbox bank, room rows, email"]
  L --> UI["Console"]`,

  loop: `sequenceDiagram
  autonumber
  participant In as Inlet
  participant Y as @yard engine
  participant Ag as Agents
  participant Code as Code checks
  participant Doc as Room documents
  participant P as Person on a Switch card
  participant Out as Outlet
  In->>Y: a case opens, recorded in the event log
  Y->>Ag: one fenced request per agent, each with its own job
  Ag-->>Y: a JSON answer, with quotes
  Y->>Code: check every claim
  Code->>Doc: read the rows it needs, record their hashes
  Code-->>Y: pass or fail, and what it read
  Y->>P: a card showing the exact action and its hash
  P-->>Y: an answer, with who gave it
  Y->>Doc: read again: did anything change since the checks?
  alt a document changed
    Y->>Code: check again, and the earlier approval no longer counts
  else nothing changed
    Y->>Out: carry out exactly the approved action
    Out-->>Y: receipt, read back: its hash equals the approval
  end`,

  decision: `flowchart TD
  P["Proposal arrives<br/>signed webhook"] --> A1["assess: two agents<br/>finance desk, engineering desk"]
  A1 --> A2["challenge: two agents<br/>operations desk, red team"]
  A2 --> F["fit: code checks commitments and capacity"]
  F --> PO["policy: code checks the company's rules"]
  PO --> CF["counter_fit and counter_policy:<br/>the same checks on the counteroffer"]
  CF --> DS["dissent: every objection,<br/>with its quote and where it is"]
  DS --> Q{"Does the counteroffer<br/>pass both checks?"}
  Q -- yes --> DEC["decide: the CFO's card<br/>counter or decline"]
  Q -- no --> NA["no_alternative: the CFO's card<br/>decline or hold"]
  DEC -- counter --> CO["cosign: the CTO's card<br/>approve or reject<br/>never the person who chose"]
  CO -- approve --> WR["write commitments into the room<br/>email the counteroffer"]
  WR --> AW(["Assumption Watch, every tick"])
  AW -- "the capacity is gone" --> RE["a new case decides again<br/>on the facts as they are now"]`,

  commitments: `erDiagram
  PROPOSAL }o--o{ COMMITMENT : "runs into, found by code"
  PROPOSAL }o--o{ RULE : "is checked against"
  DECISION ||--o{ COMMITMENT : "writes, once two people sign"
  COMMITMENT }o--|| RESOURCE : "holds an amount until a date"
  DECISION ||--o{ ASSUMPTION : "rests on"
  ASSUMPTION }o--|| RESOURCE : "is checked again against"
  POLICY ||--o{ RULE : "holds, each with who set it"`,

  watch: `stateDiagram-v2
  [*] --> Checked: code reads commitments, capacity and policy
  Checked --> Approved: the CFO chooses, the CTO co-signs
  Approved --> Checked: capacity changed before acting, approval voided
  Approved --> CarriedOut: commitments written, counteroffer sent
  CarriedOut --> CarriedOut: still holds
  CarriedOut --> AtRisk: each tick, the capacity is no longer there
  AtRisk --> [*]: a new case decides again`,

  bankChange: `flowchart TD
  E["Email: we changed banks"] --> R["request: an agent reads it<br/>vendor, new IBAN, red flags"]
  R --> C["checks: code<br/>sender's domain against the one on file,<br/>look-alikes, IBAN check digits,<br/>Reply-To, mail gateway results"]
  C --> PY["payee: the bank says who holds the IBAN"]
  PY --> L["links: did people already refuse this account?"]
  L --> Q{"What did code find?"}
  Q -- "a check failed, or the bank says no match" --> S["suspect: the controller<br/>block or investigate"]
  S -- block --> WV["warn the real supplier<br/>at the address on file"]
  S -- block --> FL[("the account is recorded as refused,<br/>evidence for every other case")]
  Q -- "the account was refused before" --> LK["linked: the controller<br/>hold or call anyway"]
  Q -- "everything passes" --> CB["callback: the AP clerk calls<br/>the number on file"]
  LK -- "call anyway" --> CB
  CB -- confirmed --> AP["approve: the controller,<br/>a different person"]
  CB -- "not confirmed" --> FL
  AP -- approve --> UM["update the vendor-master row"]`,

  invoice: `flowchart TD
  I["Invoice: signed webhook"] --> RV["review: two agents<br/>invoice reader, fraud investigator"]
  RV --> EV["evidence: code keeps a quote<br/>only if it is in the invoice, at its offsets"]
  EV --> PO["po_check: the PO matches to the cent<br/>and is not already invoiced"]
  PO --> BC["bank_check: the account on file,<br/>never the one printed on the invoice"]
  BC --> PY["payee: the bank says who holds it"]
  PY --> LN["links: refused or shared accounts"]
  LN --> Q{"Does the payment rule hold?<br/>every check passes, amount at most 10,000"}
  Q -- yes --> RP["mark the PO invoiced, then pay by the rule"]
  Q -- no --> G{"Why not?"}
  G -- "the vendor row was edited outside a case" --> H["held: no pay button"]
  G -- "the PO is already invoiced" --> DU["duplicate: no pay button"]
  G -- "the bank says no match" --> MM["mismatch: no pay button"]
  G -- "anything else" --> FN["finance: the controller<br/>pay or dispute"]
  FN -- pay --> RP
  RP --> BK["sandbox bank: pays once per key,<br/>read back: its hash equals the approval"]`,

  links: `flowchart LR
  A["Case 1: a look-alike domain<br/>asks for account DE88"] -- "the controller blocks" --> F[("DE88 recorded:<br/>refused by a person")]
  F -- "open cases are checked again at once" --> B["Case 2: the real domain asks for DE88<br/>its callback card stops counting"]
  F -- "checked by the links step" --> C["Case 3: an invoice printing DE88<br/>goes to a person"]
  B -- "the controller holds" --> X["nobody calls, nothing changes"]`,

  hashes: `flowchart LR
  subgraph Card["On the Switch card"]
    H1["approved hash<br/>SHA-256 of the exact action"]
  end
  subgraph Engine["When the engine acts"]
    BH["basis hashes<br/>every document row the checks read"]
    H2["sent hash<br/>the action rendered again"]
  end
  subgraph Bank["Sandbox bank"]
    H3["read-back hash<br/>what the bank now holds"]
  end
  H1 -- "must equal" --> H2
  H2 -- "must equal" --> H3
  BH -- "a row changed: the approval stops counting" --> H1`,

  proof: `flowchart TB
  LOG[("The case's event log")] --> S["Sections drawn from it: source, agents,<br/>evidence, checks, beneficiary, links,<br/>dissent, decisions, executions, assumptions"]
  S --> D["SHA-256 digest of each section,<br/>of the flow file and of the log"]
  FLOW["The flow file"] --> D
  D --> R["Root: a digest of the digests"]
  R --> SIG["Ed25519 signature<br/>key kept outside the log"]
  SIG --> V{"verify-proof:<br/>no model, no Switch, no bank"}
  V --> V1["the signature, and the pinned key"]
  V --> V2["every digest and the root"]
  V --> V3["the sections, derived again from the log"]
  V --> V4["each action rendered again from the log,<br/>its condition and rule evaluated again"]
  V --> V5["approved = sent = the bank's copy"]
  V --> V6["each quote at its offsets"]`,
};

export const SECTIONS = [
  {
    id: "what",
    title: "What Switchyard is",
    body: `<p><b>A control plane for consequential company decisions and the actions that carry them out.</b> Agents investigate and argue, each with its own job. Code checks every claim against the company's rules, what it has already promised, and the bank. Named people decide on Switch cards. The engine carries out exactly what they signed, checks again when the facts a decision rested on change, and signs the whole record.</p>
      <p>Two applications run on the same engine. <b>Company decisions</b>: a sales proposal is argued, checked against the company's policy and its commitments, decided by two people, and written back as new commitments. <b>Supplier payments</b>: a payment leaves only with evidence that it is the right one, and a "we changed banks" email cannot redirect it.</p>
      <p>The principle behind both: agents should not run a company. They investigate, argue and plan inside a system that knows what the company has promised, and named people decide.</p>`,
  },
  {
    id: "architecture",
    title: "The pieces, and how they connect",
    diagram: "architecture",
    body: `<p>Work arrives through <b>inlets</b>: an email, a signed webhook, a form. The <b>engine</b> (<code>@yard</code>, itself a Switch agent) runs the flow file's steps one at a time and records each one in an append-only <b>event log</b>; the state of a case is never stored, only folded from its events.</p>
      <p><b>Switch</b> is where the work happens: <b>agents</b> are asked in the case's thread, <b>room documents</b> are the company's system of record that code checks read and approved cases write, and <b>approval cards</b> carry each decision with the name of the person who made it. <b>Outlets</b> act outside Switch only after approval: the sandbox bank, a room row, an email.</p>`,
  },
  {
    id: "loop",
    title: "The control loop every case goes through",
    diagram: "loop",
    body: `<p>Every flow, decision or payment, follows the same loop. Agents never decide: their answers are checked by code. Nothing is carried out without a person's answer on a card, or a rule written in the flow file that holds once every check passes.</p>
      <p>The card shows the exact action and its SHA-256 hash, so the approval is bound to that action and no other. Just before acting, the engine reads the room documents again: if a row the checks relied on changed, nothing is sent, the checks run again, and the earlier approval stops counting.</p>`,
  },
  {
    id: "decision",
    title: "A company decision, step by step",
    diagram: "decision",
    open: ["decisions", "Open the Decision Room"],
    body: `<p><b>The example:</b> Tailspin Analytics proposes 12,000,000 INR a year at a 25% discount, 99.99% uptime, delivered in six weeks.</p>
      <ul><li><b>Four views, not a vote.</b> Two agents on two vendors take four jobs: the finance desk (which also proposes a counteroffer), the engineering desk, the operations desk and a red team. Each objection must quote the proposal.</li>
      <li><b>The company constitution, by code.</b> The <code>policy</code> document holds the rules and who set each: maximum discount 15% (CFO), minimum year-1 margin 30% (CFO), maximum uptime 99.9% (CTO), no new fixed costs this quarter (board). Code computes the margin itself from the policy's own cost rates (28.5% here), over the first contract year: a year of revenue after the discount, against a year of GPU-hours and the one-off rollout team.</li>
      <li><b>The commitments, by code.</b> 400 of 1,000 GPU-hours are free, because C-101 holds 600 for Northwind Paper until March 2027, decided by the CTO; the engineers are promised to Contoso and to a platform migration. The check fails closed: any shortfall is a "no" whether or not a promise explains it, and a missing request, a capacity row it cannot read, a capacity report more than a month old, or a promise with no readable amount or date stops it rather than being skipped.</li>
      <li><b>Only an alternative that passes reaches a card.</b> The counteroffer (10%, 99.9%, 400 GPU-hours, starting after the Contoso release) passes both checks, so the CFO is offered it or a decline; accepting the proposal as it stands is not an option. Choosing it with objections still open records the CFO as answering for them.</li>
      <li><b>Only one decision can hold the same capacity.</b> Two proposals checked against the same room can each fit on their own and not together. When the CFO chooses a counteroffer, what it needs is held in one SQLite transaction against the capacity, the commitments already written and every other open decision's hold: committed plus held never exceeds capacity. A second decision that no longer fits is checked again with that hold counted, and its card offers only decline or hold. A hold lapses when its decision ends or after two days; once carried out, the commitments it wrote count instead.</li>
      <li><b>Four eyes.</b> The CTO co-signs the exact actions; the CFO cannot. Then Switchyard writes three commitments into the room and emails the counteroffer.</li></ul>`,
  },
  {
    id: "commitments",
    title: "The Commitment Graph: what the company has promised",
    diagram: "commitments",
    open: ["commitments", "Open the Commitment Graph"],
    body: `<p>A company is a set of promises made under uncertainty: capacity reserved for a customer, engineers promised to a release, an uptime guarantee, a budget. A decision made yesterday constrains the one being made today.</p>
      <p>The <code>commitments</code> room document holds one row per promise: its id, kind, who it is to, the resource it holds, how much, until when, who decided it and on what basis. The <code>capacity</code> document says what there is to promise from. Every proposal is checked against both before anyone is asked, and each promise in its way is named with the person who made it. A signed decision adds its own rows, so the next proposal sees them.</p>`,
  },
  {
    id: "watch",
    title: "Assumption Watch: decisions that can expire",
    diagram: "watch",
    open: ["commitments", "See it on the graph"],
    body: `<p>A decision rests on facts that can change after it is made. Before it is carried out, a change to the capacity voids the approval: the checks run again on the new figure. After it is carried out, every tick of the engine checks each declared assumption again, by code, on the room's documents as they are now.</p>
      <p>When operations reports GPU capacity down from 1,000 to 700, the counteroffer's 400 GPU-hours no longer fit next to Northwind's 600. The decision is marked at risk, its thread says why, and a new case decides again on the current facts; there, the finance desk offers a smaller tier and code passes it. The first decision and what it did stay exactly as they were.</p>
      <p><b>Hard facts and noisy readings.</b> A capacity report is a hard fact, so the first failing re-check breaks the assumption. For a noisy measurement, a flow can set <code>confirm: 3</code> and <code>recover: 2</code>: the assumption is suspect after one bad reading, breaks only after three in a row, and clears only after two good ones in a row, so a reading that flaps around the line neither reopens the decision nor clears it each tick. While anything in the room is suspect, no new capacity is held there: uncertain capacity authorizes nothing.`,
  },
  {
    id: "bankchange",
    title: "A supplier's bank-detail change",
    diagram: "bankChange",
    open: ["cases", "Open the cases"],
    body: `<p>A classic fraud is an email saying "we changed banks". The agent reads the request, but code decides the facts: the sender's domain against the one on file (a look-alike such as <code>fabrikarn.test</code> for <code>fabrikam.test</code> is caught by edit distance), the IBAN's check digits, a Reply-To elsewhere, and the mail gateway's DMARC result when there is a trusted gateway.</p>
      <p>The bank says who holds the new account (Verification of Payee, in the sandbox). A request that passes still needs a callback to the number on file and a second person's approval; the clerk who called cannot approve. Only then is the vendor-master row written.</p>`,
  },
  {
    id: "invoice",
    title: "An invoice payment",
    diagram: "invoice",
    open: ["proofs", "Open a payment's proof"],
    body: `<p>Two agents with different jobs read the invoice: one reports what it says, the other looks for signs of an attack. Code keeps a quote only if it is really in the invoice, and records where. The money goes only to the account in the vendor master, never to one printed on the invoice.</p>
      <p>Three kinds of case get a card with no pay button at all: a vendor row edited in the room outside any case, a PO already invoiced, and an account the bank says the vendor does not hold (or a factoring mandate typed into the room by hand). A payment by the rule needs every check to pass and at most 10,000; anything else goes to the controller.</p>`,
  },
  {
    id: "links",
    title: "What one case teaches the others",
    diagram: "links",
    open: ["investigations", "Open Investigations"],
    body: `<p>A supplier's mailbox can be taken over: the email then comes from the real domain and passes every check. What gives it away is history. When a person blocks a request from a look-alike domain, or the supplier says on the phone that an account is not theirs, that account is recorded as refused. Every open case on it is checked again at once, and any card it had stops counting.</p>
      <p>Investigations draws these connections as a graph in which every line is a recorded fact: who decided, in which case, when. A block is labelled a person's suspicion, never proof of fraud, and nothing is scored.</p>`,
  },
  {
    id: "hashes",
    title: "Why the approval is the action",
    diagram: "hashes",
    body: `<p>Three hashes, from three places, must agree: the one on the card the person answered, the one of the action the engine sent, and the one of what the bank now holds, read back after paying. Underneath, the engine keeps the hash of every document row the checks read; if one changes before the engine acts, the approval no longer counts.</p>
      <p>Switch has no per-document permissions, so Switchyard also keeps the hash of every row as it first saw it or last wrote it through a case. A row edited by hand outside a case passes no check.</p>`,
  },
  {
    id: "proof",
    title: "Every decision and payment leaves a proof",
    diagram: "proof",
    open: ["proofs", "Open the Proof Explorer"],
    body: `<p>One file per case answers "why did we do this?". It holds the case's event log, the evidence drawn from it in sections, the flow it ran under, a digest of each part, a root over the digests and an Ed25519 signature made with a key kept outside the log.</p>
      <p><code>npm run switchyard verify-proof &lt;file&gt;</code> checks it with no model, no Switch and no bank: 32 checks for the demo payment, 49 for the demo decision. It evaluates the payment rule again on the log rather than trusting it, and runs each decision check (commitments, policy, dissent) again on the documents it read, which the log keeps, with the arguments the flow makes from the log. An edited log, a moved quote, or a rewritten amount signed again with another key each fails. What a signature cannot prove: that the record is true.</p>`,
  },
  {
    id: "chaos",
    title: "Five guarantees, and a Chaos Lab that tries to break them",
    open: ["lab", "Open the Chaos lab"],
    body: `<p>Switchyard makes five guarantees, and <code>src/engine/invariants.ts</code> checks each one on the event log and the reservation ledger as they stand:</p>
      <ul><li><b>Capacity safety.</b> What the commitments document holds plus every open decision's hold never exceeds the capacity, in any hold's window.</li>
      <li><b>Approval integrity.</b> Every action a person approved was sent with exactly the hash they approved.</li>
      <li><b>Authority separation.</b> No one answered two gates the flow keeps apart.</li>
      <li><b>Idempotent execution.</b> No action was carried out twice in a case.</li>
      <li><b>Recoverability.</b> An action whose outcome is unknown is in doubt for a person, never sent again blindly.</li></ul>
      <p>The Chaos Lab (<code>npm run chaos</code>, or the panel at the top of the Attack lab) injects eight failures into the contract decision, deterministic for a seed, and checks all five after each: two decisions competing for one pool of capacity; capacity cut between the CFO's and the CTO's signatures; an agent's provider down mid-investigation; the same card answer delivered twice; the counteroffer email hanging past the timeout; the engine crashing mid-send and a new one starting on the same database; a capacity reading flapping around the line; and a decision's record rewritten and signed again. Its first run found a real bug: a decision whose approval was voided kept its hold. A voided approval now releases it.</p>
      <p><b>Measured.</b> <code>npm run bench</code> times the engine alone (no model, no Switch): the commitments check takes under 8 ms on 10,000 promises; a hold takes under 2 ms with 1,000 other decisions holding; eight processes reserving from one pool on the same database file took exactly the holds that fit and never over-allocated; verifying a decision's proof, its checks run again, takes under 3 ms. <code>docs/BENCHMARKS.md</code> has the method and the full output.</p>`,
  },
  {
    id: "lab",
    title: "Measured, not claimed",
    open: ["lab", "Open the Attack lab"],
    body: `<p>The Attack lab runs 20 scenarios written blind by a separate author from a one-page brief and frozen before their first run, on the real engine, under two configurations side by side. Their first run found two real bugs, both fixed, so the numbers now are regression results, not a detection rate.</p>
      <p>With people doing their job, every attack is stopped with or without links between cases, and links cost one false positive (a factoring company that two suppliers really share). With every callback fooled, money gets through; a bank that knows who holds each account would stop it, which the lab reports as an upper bound because the registry is ours.</p>`,
  },
  {
    id: "real",
    title: "What is real and what is simulated",
    body: `<ul><li><b>Real:</b> Switch (rooms, threads, cards, documents) on Slack; the agents (Claude Haiku and Gemini through their CLIs, with tools switched off); the emails through Mailpit; the engine, its event log and its checks; two people deciding.</li>
      <li><b>Sandbox:</b> the bank and its answers about who holds an account; the suppliers and their <code>.test</code> domains; Tailspin, the commitments, the capacity and the policy. No CRM, HR or ERP is connected.</li>
      <li><b>This page</b>, when hosted publicly, shows the offline run: fixture agents and cards clicked by a script.</li></ul>`,
  },
];

let mermaidReady;
function loadMermaid() {
  mermaidReady ??= import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then((m) => {
    const mermaid = m.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "Roboto, Arial, sans-serif",
      themeVariables: {
        primaryColor: "#e8f0fe", primaryBorderColor: "#1a73e8", primaryTextColor: "#202124",
        secondaryColor: "#f1f3f4", tertiaryColor: "#ffffff", lineColor: "#5f6368", fontSize: "14px",
        clusterBkg: "#f8f9fa", clusterBorder: "#dadce0", edgeLabelBackground: "#ffffff",
        actorBkg: "#e8f0fe", actorBorder: "#1a73e8", noteBkgColor: "#fef7e0", noteBorderColor: "#f9ab00",
      },
      flowchart: { curve: "basis", htmlLabels: true },
    });
    return mermaid;
  });
  return mermaidReady;
}

// Draws the diagrams once the page is in the document.
export async function drawDiagrams(view) {
  const nodes = [...view.querySelectorAll("pre.mermaid:not([data-processed])")];
  if (!nodes.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    // No internet: each diagram stays as its source text.
    for (const n of nodes) n.classList.add("offline");
    view.querySelector(".ab-offline")?.removeAttribute("hidden");
    return;
  }
  await mermaid.run({ nodes, suppressErrors: true });
}

export function renderAbout() {
  const toc = SECTIONS.map((s, i) => `<li><a href="#about" data-jump="${s.id}"><span>${String(i + 1).padStart(2, "0")}</span>${esc(s.title)}</a></li>`).join("");
  const body = SECTIONS.map(
    (s, i) => `<section class="ab-sec card" id="ab-${s.id}">
      <div class="ab-num">${String(i + 1).padStart(2, "0")}</div>
      <div class="ab-text"><h2>${esc(s.title)}</h2>${s.body}${s.open ? `<p><a class="btn small" href="#${s.open[0]}">${icon("reroute")} ${esc(s.open[1])}</a></p>` : ""}</div>
      ${s.diagram ? `<figure class="ab-fig"><pre class="mermaid">${esc(DIAGRAMS[s.diagram])}</pre></figure>` : ""}
    </section>`,
  ).join("");
  return `<section class="ab-head">
      <h1>How Switchyard works</h1>
      <p class="fine">Everything here is drawn from the code: the flows in <code>flows/</code>, the checks in <code>src/engine/</code>, and the proofs in <code>src/proof.ts</code>. The README has the same diagrams, with screenshots.</p>
      <p class="fine ab-offline" hidden>The diagram library could not be loaded (no internet), so each diagram is shown as its Mermaid source.</p>
    </section>
    <div class="ab-layout">
      <nav class="card ab-toc" aria-label="On this page"><h3>On this page</h3><ol>${toc}</ol></nav>
      <div class="ab-body">${body}</div>
    </div>`;
}
