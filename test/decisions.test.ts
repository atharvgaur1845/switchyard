import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fixtureReply } from "../src/agents/fixture-agent.ts";
import { commitmentsOf, DECISION_CHECKS } from "../src/engine/decisions.ts";
import { loadFlow } from "../src/engine/flow-schema.ts";
import type { Outlets } from "../src/engine/ports.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { TAILSPIN } from "../src/demo.ts";
import { LiveOutlets } from "../src/outlets/index.ts";
import { buildProof, seal, signProof, verifyProof } from "../src/proof.ts";
import { attestRooms, FakeSwitch } from "./fake-switch.ts";

// A company decision, end to end: four views argue, code checks the
// proposal against the company's rules and what it has already promised,
// two people decide, the decision becomes commitments in the room, and the
// decision is made again when what it rested on stops being true.
const docs = parse(readFileSync("templates/contract-decision.template.yaml", "utf8")).room.docs as { name: string; content: string }[];
const doc = (name: string) => docs.find((d) => d.name === name)!.content;
const replies = parse(readFileSync("fixtures/replies.yaml", "utf8"));
const flow = loadFlow(readFileSync("flows/contract-decision.flow.yaml", "utf8"));

function world() {
  const chat = new FakeSwitch()
    .agent("@checker", (r) => fixtureReply(r, replies))
    .agent("@checker-backup", (r) => fixtureReply(r, replies))
    .doc("finance", "commitments", doc("commitments"))
    .doc("finance", "capacity", doc("capacity"))
    .doc("finance", "policy", doc("policy"));
  const store = new Store();
  const live = new LiveOutlets({ dataDir: tmpdir(), smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, chat, store);
  const sent: unknown[] = [];
  const outlets: Outlets = {
    execute: (o, k) => {
      if ("document" in o) return live.execute(o, k);
      sent.push(o);
      return Promise.resolve("simulated email");
    },
  };
  const runner = new Runner(store, chat, outlets, [flow], { now: () => Date.parse("2026-11-07T09:00:00Z"), people: { "@cfo": ["@cfo"], "@cto": ["@cto"] } });
  attestRooms(store, chat);
  const settle = () => chat.deliver((m) => runner.onMessage(m));
  const card = (id: string) => chat.cards.findLast((c) => c.requestId.startsWith(id))!;
  const answer = async (id: string, choice: string, by: string) => {
    await runner.onApproval({ requestId: card(id).requestId, answer: choice, answeredBy: `mx:${by}` });
    await settle();
  };
  const content = (name: string) => chat.docs.get("finance")!.find((d) => d.name === name)!.content;
  const edit = (name: string, from: string, to: string) => {
    const d = chat.docs.get("finance")!.find((x) => x.name === name)!;
    d.content = d.content.replace(from, to);
  };
  const propose = async () => {
    const id = await runner.open("contract-decision", { ...TAILSPIN }, "webhook");
    await settle();
    return id;
  };
  return { chat, store, runner, sent, settle, card, answer, content, edit, propose };
}

describe("a contract decision", () => {
  it("finds the rules and the promises the proposal breaks, names who made each, and offers only an alternative that passes", async () => {
    const { store, card, propose } = world();
    const id = await propose();
    const r = store.load(id).results as Record<string, any>;
    expect(r.fit.ok).toBe(false);
    expect(r.fit.conflicts.map((c: { id: string }) => c.id)).toEqual(["C-101", "C-102", "C-103"]);
    expect(r.fit.detail).toMatch(/C-101 holds 600 for Northwind Paper until 2027-03-31 \(decided by @cto\)/);
    expect(r.policy.ok).toBe(false);
    expect(r.policy.rules.filter((x: { ok: boolean }) => !x.ok).map((x: { rule: string }) => x.rule)).toEqual(["max discount", "min year-1 margin", "max uptime promised", "new fixed costs this quarter"]);
    expect(r.policy.margin).toBe(28.5);
    expect(r.counter_fit.ok && r.counter_policy.ok).toBe(true);
    expect(card(id).options).toEqual(["counter", "decline"]);
    expect(card(id).title).toMatch(/breaks 4 company rules \(max discount, min year-1 margin, max uptime promised, new fixed costs this quarter\), and promises already made stand in its way \(C-101, C-102, C-103\)\. The counteroffer passes both\. 8 objections stay open/);
  });

  it("keeps every objection with its quote, and does not average them into a vote", async () => {
    const { store, propose } = world();
    const id = await propose();
    const dissent = store.load(id).results.dissent as Record<string, any>;
    expect(dissent.stances).toEqual([
      { role: "finance", position: "counter" },
      { role: "engineering", position: "decline" },
      { role: "operations", position: "counter" },
      { role: "red team", position: "decline" },
    ]);
    const renewal = dissent.ledger.find((l: { quote?: string }) => l.quote === "Renewal for a second year is likely");
    expect(renewal).toMatchObject({ from: "red team", status: "open", grounded: { start: TAILSPIN.text.indexOf("Renewal") } });
    expect(dissent.open).toBe(8);
    expect(dissent.ledger.filter((l: { from: string }) => l.from === "code").every((l: { status: string }) => l.status.startsWith("binding"))).toBe(true);
  });

  it("sets aside an objection whose quote is not in the proposal", () => {
    const value = DECISION_CHECKS.dissent.run({ text: TAILSPIN.text, by_red_team: { position: "decline", objections: [{ claim: "They are insolvent.", quote: "we are close to insolvency", materiality: "high" }] } }, []);
    expect(value.ledger).toEqual([expect.objectContaining({ status: "set aside: its quote is not in the proposal" })]);
    expect(value.open).toBe(0);
  });

  it("needs two different people, then writes the decision into the room as commitments", async () => {
    const { store, card, answer, content, sent, propose } = world();
    const id = await propose();
    await answer(id, "counter", "@cfo");
    expect(card(id).title).toMatch(/co-sign the counteroffer to Tailspin Analytics that @cfo chose\? It reserves 400 GPU-hours/);
    // The person who chose cannot also co-sign.
    await answer(id, "approve", "@cfo");
    expect(store.load(id).pending).toMatchObject({ kind: "gate", step: "cosign" });
    await answer(id, "approve", "@cto");
    expect(store.load(id).status).toBe("done");
    const mine = commitmentsOf(content("commitments")).filter((c) => c.basis.includes(`case ${id}`));
    expect(mine.map((c) => [c.id, c.resource, c.amount, c.until])).toEqual([
      [`D-${id}-gpu`, "gpu-hours", 400, "2027-12-16"],
      [`D-${id}-eng`, "engineers", 3, "2027-01-27"],
      [`D-${id}-sla`, "uptime", 99.9, "2027-12-16"],
    ]);
    expect(sent).toHaveLength(1);
    // And its proof holds every check, with no model, Switch or bank.
    const key = generateKeyPairSync("ed25519").privateKey;
    const proof = signProof(buildProof(store, [flow], id), key);
    expect(verifyProof(JSON.parse(JSON.stringify(proof)), proof.signature!.fingerprint).filter((f) => !f.ok)).toEqual([]);
    expect((proof.sections.dissent as { open: number }).open).toBe(8);
  });

  it("does not act on an approval given before the capacity it rests on changed", async () => {
    const { store, answer, edit, content, propose } = world();
    const id = await propose();
    await answer(id, "counter", "@cfo");
    edit("capacity", "| gpu-hours | 1000 |", "| gpu-hours | 700 |");
    await answer(id, "approve", "@cto");
    expect(store.events(id).some((e) => e.type === "rewound")).toBe(true);
    expect(content("commitments")).not.toContain(`D-${id}`);
    // Checked again on the new capacity, the counteroffer no longer fits.
    expect(store.load(id).pending).toMatchObject({ kind: "gate", step: "no_alternative" });
  });

  it("is made again when the capacity it reserved is lost after it was carried out", async () => {
    const { store, runner, answer, edit, chat, settle, card, propose } = world();
    const id = await propose();
    await answer(id, "counter", "@cfo");
    await answer(id, "approve", "@cto");
    await runner.tick();
    expect(store.events(id).some((e) => e.type === "assumption_broken")).toBe(false);

    edit("capacity", "| gpu-hours | 1000 |", "| gpu-hours | 700 |");
    await runner.tick();
    await settle();
    const broken = store.events(id).find((e) => e.type === "assumption_broken")!;
    expect(broken).toMatchObject({ assumption: "capacity", detail: expect.stringMatching(/needs 400 GPU-hours a month .* and 100 of 700 are free: C-101 holds 600 for Northwind Paper/) });
    expect(chat.said("Assumption broken: the capacity the counteroffer reserved is still there")).toBe(true);
    // The original decision stands as it was; a new case decides again.
    expect(store.load(id).status).toBe("done");
    const again = (broken as { reopened: string }).reopened;
    expect(store.load(again).data).toMatchObject({ reconsider: id, customer: "Tailspin Analytics" });
    expect((store.load(again).results.counter_fit as { ok: boolean; needs: { gpu_hours: number } }).needs.gpu_hours).toBe(100);
    expect(card(again).options).toEqual(["counter", "decline"]);
    // Once per broken assumption.
    await runner.tick();
    expect(store.events(id).filter((e) => e.type === "assumption_broken")).toHaveLength(1);
  });
});

// The commitments and policy checks fail closed: anything they cannot read,
// or capacity that is not there, is a "no", never a resource skipped.
describe("the decision checks, on bad or missing inputs", () => {
  const NOW = Date.parse("2026-11-07T09:00:00Z");
  const HEAD = "| id | kind | to | resource | amount | until | decided by | basis |\n|---|---|---|---|---|---|---|---|\n";
  const CAP = "| resource | available | unit | as of |\n|---|---|---|---|\n";
  const room = (commitments: string, capacity: string) => [
    { id: "c", name: "commitments", content: HEAD + commitments },
    { id: "k", name: "capacity", content: CAP + capacity },
  ];
  const fresh = "| gpu-hours | 1000 | a month | 2026-11-01 |\n| engineers | 8 | people | 2026-11-01 |\n";
  const ask = { doc: "commitments", capacity: "capacity", max_age_days: 31, start: "2026-12-01", weeks: 6, gpu_hours: 400, engineers: 2 };
  const fit = (args: Record<string, unknown>, docs = room("", fresh)) => DECISION_CHECKS.commitments.run({ ...ask, ...args }, docs, NOW) as Record<string, any>;

  it("refuses an allocation the capacity cannot hold, even when no promise explains the gap", () => {
    const r = fit({}, room("", "| gpu-hours | 200 | a month | 2026-11-01 |\n| engineers | 8 | people | 2026-11-01 |\n"));
    expect(r.ok).toBe(false);
    expect(r.shortfall).toEqual({ gpu_hours: 200 });
    expect(r.conflicts).toEqual([]);
    expect(r.detail).toMatch(/needs 400 GPU-hours a month .* and 200 of 200 are free, with nothing promised from them: there is not enough/);
  });

  it("refuses when the capacity document has no row, or two rows, for a resource asked for", () => {
    expect(fit({}, room("", "| engineers | 8 | people | 2026-11-01 |\n"))).toMatchObject({ ok: false, detail: expect.stringMatching(/capacity has no row for gpu-hours/) });
    expect(fit({}, room("", "| gpu-hours | 1000 | a month | 2026-11-01 |\n"))).toMatchObject({ ok: false, detail: expect.stringMatching(/capacity has no row for engineers/) });
    expect(fit({}, room("", fresh + "| gpu-hours | 5000 | a month | 2026-11-02 |\n"))).toMatchObject({ ok: false, detail: expect.stringMatching(/2 rows for gpu-hours/) });
    expect(fit({}, room("", "| gpu-hours | lots | a month | 2026-11-01 |\n| engineers | 8 | people | 2026-11-01 |\n"))).toMatchObject({ ok: false, detail: expect.stringMatching(/"lots" gpu-hours available/) });
  });

  it("refuses a request that is missing, negative or not a number, and passes one that needs none of a resource", () => {
    for (const bad of [undefined, "", "-50", "a few"]) expect(fit({ gpu_hours: bad }).ok).toBe(false);
    expect(fit({ engineers: undefined }).detail).toMatch(/does not say how many engineers/);
    expect(fit({ gpu_hours: 0 }).ok).toBe(true);
  });

  it("refuses when a promise cannot be read, instead of leaving it out of the count", () => {
    expect(fit({}, room("| C-1 | capacity | Northwind | gpu-hours | 600 | next spring | @cto | x |\n", fresh))).toMatchObject({ ok: false, detail: expect.stringMatching(/C-1 in commitments: "next spring" is not a date/) });
    expect(fit({}, room("| C-1 | capacity | Northwind | gpu-hours |  | 2027-03-31 | @cto | x |\n", fresh)).detail).toMatch(/its amount is not a number of gpu-hours/);
    expect(fit({}, room("| C-1 | capacity | Northwind | gpu-hours | -600 | 2027-03-31 | @cto | x |\n", fresh)).ok).toBe(false);
    expect(fit({}, room("| C-1 | capacity | Northwind |  | 600 | 2027-03-31 | @cto | x |\n", fresh)).detail).toMatch(/does not say which resource/);
  });

  it("refuses a capacity report that is stale, undated or dated in the future", () => {
    const at = (d: string) => room("", `| gpu-hours | 1000 | a month | ${d} |\n| engineers | 8 | people | ${d} |\n`);
    expect(fit({}, at("2026-09-01")).detail).toMatch(/as of 2026-09-01, more than 31 days ago/);
    expect(fit({}, at("")).detail).toMatch(/does not say when gpu-hours was last reported/);
    expect(fit({}, at("2026-12-25")).detail).toMatch(/a date still to come/);
    expect(fit({}, at("2026-10-20")).ok).toBe(true);
  });

  it("refuses terms with a missing cost driver, rather than counting it as free", () => {
    const policy = [{ id: "p", name: "policy", content: doc("policy") }];
    const terms = { doc: "policy", value: 12_000_000, discount_pct: 10, uptime: 99.9, weeks: 6, gpu_hours: 400, engineers: 3 };
    expect(DECISION_CHECKS.constitution.run(terms, policy).ok).toBe(true);
    for (const missing of ["gpu_hours", "engineers", "value", "uptime"]) expect(DECISION_CHECKS.constitution.run({ ...terms, [missing]: "" }, policy).ok).toBe(false);
    expect(DECISION_CHECKS.constitution.run({ ...terms, discount_pct: 140 }, policy).ok).toBe(false);
  });
});

describe("a decision's proof", () => {
  it("runs the decision checks again from the documents they read, and catches a recorded result that was changed", async () => {
    const { store, answer, propose } = world();
    const id = await propose();
    await answer(id, "counter", "@cfo");
    await answer(id, "approve", "@cto");
    const key = generateKeyPairSync("ed25519").privateKey;
    const proof = signProof(buildProof(store, [flow], id), key);
    const fp = proof.signature!.fingerprint;
    const replays = verifyProof(proof, fp).filter((f) => /run again on them/.test(f.what));
    expect(replays).toHaveLength(5);
    expect(replays.every((f) => f.ok)).toBe(true);

    // Someone with the signing key rewrites the log: the proposal now "fits".
    const forged = structuredClone(proof);
    const fit = forged.log.find((e) => e.type === "verified" && e.step === "fit") as unknown as { value: { ok: boolean } };
    fit.value.ok = true;
    const resigned = signProof(seal(forged.case, forged.flow, forged.log), key);
    // Caught where it was changed, and again where the dissent check read it.
    expect(verifyProof(resigned, fp).filter((f) => !f.ok).map((f) => f.what)).toEqual([
      "fit: the commitments check, run again on them, gives the result recorded (it does not pass; the log says it passes)",
      "dissent: the dissent check's arguments are what the flow makes from the log",
    ]);

    // Or swaps the policy it read for a laxer one, and re-signs.
    const lax = structuredClone(proof);
    const policy = lax.log.find((e) => e.type === "verified" && e.step === "policy") as unknown as { replay: { docs: Record<string, string> } };
    policy.replay.docs.policy = policy.replay.docs.policy.replace("| max discount | 15% |", "| max discount | 50% |");
    const relaxed = signProof(seal(lax.case, lax.flow, lax.log), key);
    expect(verifyProof(relaxed, fp).filter((f) => !f.ok).map((f) => f.what)).toContain("policy: the documents it read (policy) hash to what the log recorded");
  });
});
