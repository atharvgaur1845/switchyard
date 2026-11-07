import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { fixtureReply } from "./agents/fixture-agent.ts";
import { FOURTH_COFFEE, TAILSPIN } from "./demo.ts";
import { type Flow, loadFlow } from "./engine/flow-schema.ts";
import { type Invariant, invariants } from "./engine/invariants.ts";
import type { ApprovalCard, Chat, InboundMessage, Outlets, RoomDocument } from "./engine/ports.ts";
import type { Outlet } from "./engine/flow-schema.ts";
import { Runner } from "./engine/runner.ts";
import { Store } from "./engine/store.ts";
import { buildProof, seal, signProof, verifyProof } from "./proof.ts";

// The Chaos Lab: the company-decision flow under injected failures, each
// scenario deterministic for a seed (the seed picks orders and which of two
// competing decisions goes first). Every scenario ends by asserting the
// engine's invariants (engine/invariants.ts) on what it left behind.
// No model, no Switch, no network: the chat and documents are in memory,
// the agents are the fixture agent, and outlets are recorded, not sent.

export interface ChaosResult {
  id: string;
  title: string;
  injected: string;
  expected: string;
  observed: string;
  ok: boolean;
  invariants: Invariant[];
  ms: number;
}

const ROOT = join(import.meta.dirname, "..");
const T0 = Date.parse("2026-11-07T09:00:00Z");

// A small deterministic generator (mulberry32), so a seed replays exactly.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  store: Store;
  runner: Runner;
  docs: RoomDocument[];
  flows: Flow[];
  sent: { outlet: Outlet; key: string }[];
  cards: ApprovalCard[];
  said: string[];
  clock: { now: number };
  settle(): Promise<void>;
  propose(data: Record<string, unknown>): Promise<string>;
  answer(caseId: string, choice: string, by: string): Promise<void>;
  edit(name: string, from: string, to: string): void;
  restart(): Runner;
}

function world(opts: { outage?: string; hang?: (o: Outlet) => boolean; confirm?: number; recover?: number; store?: Store; timeoutMs?: number } = {}): World {
  const docs = (parse(readFileSync(join(ROOT, "templates/contract-decision.template.yaml"), "utf8")).room.docs as { name: string; content: string }[]).map((d) => ({ id: d.name, name: d.name, content: d.content }));
  const replies = parse(readFileSync(join(ROOT, "fixtures/replies.yaml"), "utf8"));
  const raw = parse(readFileSync(join(ROOT, "flows/contract-decision.flow.yaml"), "utf8"));
  if (opts.confirm || opts.recover) raw.assumptions = raw.assumptions.map((a: Record<string, unknown>) => ({ ...a, confirm: opts.confirm ?? 1, recover: opts.recover ?? 1 }));
  const flows = [loadFlow(JSON.stringify(raw))];
  const inbox: InboundMessage[] = [];
  const cards: ApprovalCard[] = [];
  const said: string[] = [];
  const sent: World["sent"] = [];
  const clock = { now: T0 };
  let next = 1;
  const chat: Chat = {
    async post(_room, body) {
      said.push(body);
      return `m${next++}`;
    },
    async sendTargeted(room, handle, body, threadId) {
      const reply = handle === opts.outage ? "Error: 503 service unavailable, try again later" : fixtureReply(body, replies);
      inbox.push({ room, threadId, sender: handle, body: reply, messageId: `m${next++}`, fromPerson: false });
    },
    async openApproval(card) {
      cards.push(card);
    },
    async handleOf(answeredBy) {
      return answeredBy.replace(/^chaos:/, "");
    },
    async documents() {
      return docs;
    },
    async updateDocument(_room, id, content) {
      const doc = docs.find((d) => d.id === id);
      if (doc) doc.content = content;
    },
  };
  const outlets: Outlets = {
    execute(outlet, key) {
      sent.push({ outlet, key });
      if (opts.hang?.(outlet)) return new Promise(() => {});
      if ("document" in outlet) {
        const { name, row } = outlet.document as { name: string; row: string[] };
        const doc = docs.find((d) => d.name === name)!;
        const line = `| ${row.join(" | ")} |`;
        const lines = doc.content.trimEnd().split("\n");
        const at = lines.findIndex((l) => l.startsWith(`| ${row[0]} |`));
        if (at >= 0) lines[at] = line;
        else lines.push(line);
        doc.content = `${lines.join("\n")}\n`;
        return Promise.resolve(`set ${row[0]}'s row in ${name}`);
      }
      return Promise.resolve(`recorded ${Object.keys(outlet)[0]} (chaos lab: not sent)`);
    },
  };
  const store = opts.store ?? new Store();
  const people = { "@cfo": ["@cfo"], "@cto": ["@cto"] };
  const make = () => new Runner(store, chat, outlets, flows, { people, now: () => clock.now, outletTimeoutMs: opts.timeoutMs ?? 50 });
  const w: World = {
    store,
    runner: make(),
    docs,
    flows,
    sent,
    cards,
    said,
    clock,
    async settle() {
      while (inbox.length) await w.runner.onMessage(inbox.shift()!);
    },
    async propose(data) {
      const id = await w.runner.open("contract-decision", { ...data }, "webhook");
      await w.settle();
      return id;
    },
    async answer(caseId, choice, by) {
      const card = cards.findLast((c) => c.requestId.startsWith(caseId));
      if (!card) throw new Error(`no card for ${caseId}`);
      await w.runner.onApproval({ requestId: card.requestId, answer: choice, answeredBy: `chaos:${by}` });
      await w.settle();
    },
    edit(name, from, to) {
      const d = docs.find((x) => x.name === name)!;
      d.content = d.content.replace(from, to);
    },
    restart() {
      w.runner = make();
      return w.runner;
    },
  };
  return w;
}

const has = (w: World, id: string, type: string) => w.store.events(id).some((e) => e.type === type);
const count = (w: World, id: string, type: string) => w.store.events(id).filter((e) => e.type === type).length;

type Scenario = { id: string; title: string; injected: string; expected: string; run(seed: () => number): Promise<{ w: World; observed: string; ok: boolean }> };

export const SCENARIOS: Scenario[] = [
  {
    id: "C1",
    title: "Two decisions, one pool of capacity",
    injected: "Two proposals checked against the same room before either is decided; each counteroffer fits what is free on its own (400 GPU-hours of 400).",
    expected: "The first one chosen holds the capacity; the second is refused the hold, checked again with it counted, and offered only decline or hold.",
    async run(seed) {
      const w = world();
      const a = await w.propose(TAILSPIN);
      const b = await w.propose(FOURTH_COFFEE);
      const [first, second] = seed() < 0.5 ? [a, b] : [b, a];
      await w.answer(first, "counter", "@cfo");
      await w.answer(second, "counter", "@cfo");
      const refused = w.store.events(second).find((e) => e.type === "reservation_refused");
      const offered = w.cards.findLast((c) => c.requestId.startsWith(second))?.options.join("/");
      return { w, observed: `case ${first} held ${w.store.holds(new Date(w.clock.now)).filter((h) => h.case === first && h.resource === "gpu-hours").map((h) => h.amount)} GPU-hours; case ${second} ${refused ? "was refused the hold" : "took a hold too"}; its card offers ${offered}`, ok: has(w, first, "reserved") && Boolean(refused) && offered === "decline/hold" };
    },
  },
  {
    id: "C2",
    title: "Capacity changes between the two signatures",
    injected: "Operations cuts GPU capacity from 1,000 to 700 after the CFO chooses the counteroffer, before the CTO co-signs.",
    expected: "The CTO's approval does not count; nothing is written; the checks run again and no alternative passes.",
    async run() {
      const w = world();
      const id = await w.propose(TAILSPIN);
      await w.answer(id, "counter", "@cfo");
      w.edit("capacity", "| gpu-hours | 1000 |", "| gpu-hours | 700 |");
      await w.answer(id, "approve", "@cto");
      const written = w.docs.find((d) => d.name === "commitments")!.content.includes(`D-${id}`);
      const pending = w.store.load(id).pending;
      return { w, observed: `${has(w, id, "rewound") ? "approval voided and checks run again" : "approval kept"}; ${written ? "commitments written" : "nothing written"}; now waiting on ${pending?.kind === "gate" ? pending.step : "nothing"}`, ok: has(w, id, "rewound") && !written && pending?.kind === "gate" && pending.step === "no_alternative" };
    },
  },
  {
    id: "C3",
    title: "An agent's provider goes down mid-investigation",
    injected: "Every request to @checker-backup (the engineering desk and the red team) returns a provider error.",
    expected: "Those views are recorded as could not answer, kept open in the dissent ledger, and the decision still goes to a person.",
    async run() {
      const w = world({ outage: "@checker-backup" });
      const id = await w.propose(TAILSPIN);
      const dissent = w.store.load(id).results.dissent as { stances?: { role: string; position: string }[] } | undefined;
      const missing = (dissent?.stances ?? []).filter((s) => s.position === "could not answer").map((s) => s.role);
      const pending = w.store.load(id).pending;
      return { w, observed: `${missing.join(" and ") || "no view"} could not answer; the case waits on ${pending?.kind === "gate" ? `${pending.step} (a person)` : pending?.kind ?? "nothing"}`, ok: missing.length === 2 && pending?.kind === "gate" };
    },
  },
  {
    id: "C4",
    title: "The same card answer arrives twice",
    injected: "Switch delivers the CFO's \"counter\" answer twice, as a retried webhook would.",
    expected: "One answer recorded, one hold, one co-sign card.",
    async run() {
      const w = world();
      const id = await w.propose(TAILSPIN);
      const card = w.cards.findLast((c) => c.requestId.startsWith(id))!;
      const answer = { requestId: card.requestId, answer: "counter", answeredBy: "chaos:@cfo" };
      await w.runner.onApproval(answer);
      await w.runner.onApproval(answer);
      await w.settle();
      const answers = w.store.events(id).filter((e) => e.type === "gate_answered" && e.step === "decide").length;
      const cosigns = w.cards.filter((c) => c.requestId.startsWith(`${id}-cosign`)).length;
      return { w, observed: `${answers} answer recorded, ${count(w, id, "reserved")} hold, ${cosigns} co-sign card`, ok: answers === 1 && count(w, id, "reserved") === 1 && cosigns === 1 };
    },
  },
  {
    id: "C5",
    title: "The counteroffer email never comes back",
    injected: "The email outlet hangs past the engine's timeout after both people signed.",
    expected: "The send is in doubt for a person; it is not retried blindly.",
    async run() {
      const w = world({ hang: (o) => "email" in o });
      const id = await w.propose(TAILSPIN);
      await w.answer(id, "counter", "@cfo");
      await w.answer(id, "approve", "@cto");
      await w.runner.tick();
      const emails = w.sent.filter((s) => "email" in s.outlet).length;
      const pending = w.store.load(id).pending;
      return { w, observed: `email attempted ${emails} time${emails === 1 ? "" : "s"}; case is ${pending?.kind === "in_doubt" ? "in doubt, waiting on a person" : pending?.kind ?? w.store.load(id).status}`, ok: emails === 1 && pending?.kind === "in_doubt" };
    },
  },
  {
    id: "C6",
    title: "The engine crashes while sending",
    injected: "The process dies after recording that it started the email and before recording the result; a new engine starts on the same database.",
    expected: "The new engine does not send it again: the action is in doubt for a person. The commitments already written stay written, once.",
    async run() {
      const store = new Store();
      // A long timeout: the first engine is gone long before it would fire.
      const w = world({ hang: (o) => "email" in o, store, timeoutMs: 1500 });
      const id = await w.propose(TAILSPIN);
      await w.answer(id, "counter", "@cfo");
      // The CTO's answer starts the outlets; the email hangs, and the
      // process is gone before it returns.
      void w.answer(id, "approve", "@cto");
      await new Promise((r) => setTimeout(r, 10));
      const restarted = w.restart();
      await restarted.resumeAll();
      const emails = w.sent.filter((s) => "email" in s.outlet).length;
      const pending = w.store.load(id).pending;
      return { w, observed: `after restart: email attempted ${emails} time${emails === 1 ? "" : "s"}; case is ${pending?.kind === "in_doubt" ? "in doubt" : pending?.kind ?? w.store.load(id).status}; GPU row written ${(w.docs.find((d) => d.name === "commitments")!.content.match(new RegExp(`D-${id}-gpu`, "g")) ?? []).length} time(s)`, ok: emails === 1 && pending?.kind === "in_doubt" };
    },
  },
  {
    id: "C7",
    title: "A noisy capacity reading",
    injected: "With confirm 3 and recover 2, GPU capacity reads 700, 1,000, 700, 1,000, 1,000, then 700 three times in a row.",
    expected: "The flapping makes the assumption suspect, not broken, and it clears only after two good readings in a row. Three bad readings in a row break it, once.",
    async run(seed) {
      const w = world({ confirm: 3, recover: 2 });
      const id = await w.propose(TAILSPIN);
      await w.answer(id, "counter", "@cfo");
      await w.answer(id, "approve", "@cto");
      const readings = [700, 1000, 700, 1000, 1000, 700, 700, 700];
      const trace: string[] = [];
      for (const reading of readings) {
        const doc = w.docs.find((d) => d.name === "capacity")!;
        doc.content = doc.content.replace(/\| gpu-hours \| \d+ \|/, `| gpu-hours | ${reading} |`);
        w.clock.now += 60_000 + Math.floor(seed() * 1000);
        await w.runner.tick();
        await w.settle();
        const last = w.store.events(id).filter((e) => e.type.startsWith("assumption_")).at(-1)?.type.replace("assumption_", "") ?? "healthy";
        trace.push(`${reading}:${last}`);
      }
      const broken = count(w, id, "assumption_broken");
      const cleared = count(w, id, "assumption_cleared");
      return { w, observed: `${trace.join(" ")}; broken ${broken} time, cleared ${cleared} time`, ok: broken === 1 && cleared === 1 && !trace.slice(0, 5).some((t) => t.endsWith("broken")) };
    },
  },
  {
    id: "C8",
    title: "Someone rewrites the decision's record",
    injected: "With the signing key, the log is edited so the original proposal fits the capacity, and the proof is signed again.",
    expected: "verify-proof runs the commitments check again on the documents it read and fails.",
    async run() {
      const w = world();
      const id = await w.propose(TAILSPIN);
      await w.answer(id, "counter", "@cfo");
      await w.answer(id, "approve", "@cto");
      const key = generateKeyPairSync("ed25519").privateKey;
      const proof = signProof(buildProof(w.store, w.flows, id), key);
      const honest = verifyProof(proof, proof.signature!.fingerprint).filter((f) => !f.ok).length;
      const forged = structuredClone(proof);
      const fit = forged.log.find((e) => e.type === "verified" && e.step === "fit") as unknown as { value: { ok: boolean } };
      fit.value.ok = true;
      const resigned = signProof(seal(forged.case, forged.flow, forged.log), key);
      const failed = verifyProof(resigned, resigned.signature!.fingerprint).filter((f) => !f.ok).map((f) => f.what);
      return { w, observed: `honest proof: ${honest} failing checks; forged proof: ${failed.length} failing (${failed[0] ?? "none"})`, ok: honest === 0 && failed.some((f) => f.startsWith("fit: the commitments check, run again")) };
    },
  },
];

export async function runChaos(seed = 1, only?: string): Promise<ChaosResult[]> {
  const out: ChaosResult[] = [];
  for (const s of SCENARIOS.filter((x) => !only || x.id === only)) {
    const started = performance.now();
    const random = rng(seed * 1000 + Number(s.id.slice(1)));
    const { w, observed, ok } = await s.run(random);
    const held = invariants(w.store, w.flows, w.docs, new Date(w.clock.now));
    out.push({ id: s.id, title: s.title, injected: s.injected, expected: s.expected, observed, ok: ok && held.every((i) => i.ok), invariants: held, ms: Math.round(performance.now() - started) });
  }
  return out;
}

// A carried-out decision, for the benchmarks: its store and flows.
export async function decisionWorld(): Promise<{ store: Store; flows: Flow[] }> {
  const w = world();
  const id = await w.propose(TAILSPIN);
  await w.answer(id, "counter", "@cfo");
  await w.answer(id, "approve", "@cto");
  return { store: w.store, flows: w.flows };
}
