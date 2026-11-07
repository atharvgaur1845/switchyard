import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { LiveOutlets } from "../src/outlets/index.ts";
import { buildProof, loadOrCreateKey, type Proof, seal, signProof, verifyProof } from "../src/proof.ts";
import { sandboxPayees, startBank } from "../src/sandbox/bank.ts";
import { attestRooms, FakeSwitch, invoiceReader, investigatorSays } from "./fake-switch.ts";

// A payment's proof: everything it rests on, signed, and checkable with no
// model, no Switch and no bank.
const docs = parse(readFileSync("templates/invoice-check.template.yaml", "utf8")).room.docs as { name: string; content: string }[];
const doc = (name: string) => docs.find((d) => d.name === name)!.content;
const flows = ["bank-change", "invoice-check"].map((f) => loadFlow(readFileSync(`flows/${f}.flow.yaml`, "utf8")));
const TEXT = "Fabrikam Print, invoice FP-0901, print run for PO-1043. Total 3,150.00 EUR, due in 7 days.";

let bank: Server;
let bankUrl: string;
beforeAll(async () => {
  bank = startBank({ port: 0, ledger: join(mkdtempSync(join(tmpdir(), "bank-")), "ledger.json"), payees: sandboxPayees() });
  await new Promise((r) => bank.once("listening", r));
  bankUrl = `http://127.0.0.1:${(bank.address() as { port: number }).port}`;
});
afterAll(() => bank.close());

async function paidInvoice() {
  const chat = new FakeSwitch()
    .agent("@checker", invoiceReader({ quotes: ["Fabrikam Print", "FP-0901", "PO-1043", "3,150.00 EUR"] }))
    .agent("@checker-backup", investigatorSays())
    .doc("finance", "purchase-orders", doc("purchase-orders"))
    .doc("finance", "vendor-master", doc("vendor-master"))
    .doc("finance", "payment-mandates", doc("payment-mandates"));
  const store = new Store();
  const outlets = new LiveOutlets({ dataDir: tmpdir(), bankUrl, smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, chat, store);
  const runner = new Runner(store, chat, outlets, flows, { now: () => Date.parse("2026-11-06") });
  attestRooms(store, chat);
  const id = await runner.open("invoice-check", { supplier: "Fabrikam Print", number: "FP-0901", amount: 3150, po: "PO-1043", text: TEXT }, "webhook");
  await chat.deliver((m) => runner.onMessage(m));
  return { store, id };
}

const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "keys-")), "proof.pem"));
// As the CLI does: the proof is checked as written to a file and read back.
const failed = (proof: Proof, pinned?: string) => verifyProof(JSON.parse(JSON.stringify(proof)), pinned).filter((f) => !f.ok).map((f) => f.what);

describe("a payment's proof", () => {
  it("holds every check for a payment made by the rule, and carries its evidence", async () => {
    const { store, id } = await paidInvoice();
    const proof = signProof(buildProof(store, flows, id), key);
    expect(failed(proof, proof.signature!.fingerprint)).toEqual([]);
    const s = proof.sections as Record<string, any>;
    expect(s.evidence.grounding).toBe("invoice text");
    expect(s.evidence.quotes).toContainEqual({ quote: "PO-1043", in: "text", start: TEXT.indexOf("PO-1043"), end: TEXT.indexOf("PO-1043") + 7 });
    expect(s.beneficiary).toMatchObject({ result: "match" });
    const paid = s.executions.find((e: any) => e.kind === "pay");
    expect(paid).toMatchObject({ payload: { pay: { to: "DE29100500000190183746", amount: "3150" } } });
    expect(paid.readback).toBe(paid.hash);
    const findings = verifyProof(JSON.parse(JSON.stringify(proof)), proof.signature!.fingerprint).map((f) => f.what);
    expect(findings).toContain("schedule_payment: the bank's copy hashes the same as what was sent");
    expect(findings).toContain(`"PO-1043" is at ${TEXT.indexOf("PO-1043")}–${TEXT.indexOf("PO-1043") + 7} in the invoice text`);
    // The rule is evaluated again on the log, not taken on trust.
    const rule = flows[1].steps.find((st) => st.id === "schedule_payment")! as { auto_approve: string };
    expect(findings).toContain(`schedule_payment: no person approved it, and its rule holds on the log (${rule.auto_approve})`);
    expect(findings).toContain("schedule_payment: the values the rule read, as recorded, are what the log says");
    expect(findings).toContain("schedule_payment: the action is what the flow makes from the log");
    expect(findings).toContain("reserve_po: the flow sends it with no approval once its condition holds");
    expect(paid.rule_inputs).toMatchObject({ "payee.ok": true, "case.amount": 3150 });
  });

  it("fails when the key holder signs a log on which the rule did not hold", async () => {
    // A signature proves who signed, not that the record is true. But a log
    // whose own facts do not allow the payment fails, even signed by the
    // right key: here the bank's answer is rewritten to a close match.
    const { store, id } = await paidInvoice();
    const genuine = buildProof(store, flows, id);
    const log = structuredClone(genuine.log);
    const payee = log.find((e) => e.type === "verified" && e.check === "payee") as any;
    payee.value = { ...payee.value, ok: false, result: "close_match" };
    const resealed = signProof(seal(genuine.case, genuine.flow, log), key);
    const problems = failed(resealed, resealed.signature!.fingerprint);
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/^schedule_payment: no person approved it, and its rule holds on the log/), "schedule_payment: the values the rule read, as recorded, are what the log says"]));
    expect(problems).not.toContain("the Ed25519 signature over the root is valid");
  });

  it("is not trusted without a pinned key", async () => {
    const { store, id } = await paidInvoice();
    expect(failed(signProof(buildProof(store, flows, id), key))).toEqual(["the signer's key is pinned (pass --fingerprint, or set proof.fingerprint in switchyard.yaml)"]);
  });

  it("fails when its log is edited after signing", async () => {
    const { store, id } = await paidInvoice();
    const proof = signProof(buildProof(store, flows, id), key);
    const edited = structuredClone(proof);
    const answered = edited.log.find((e) => e.type === "executed")!;
    (answered as any).receipt = "paid 3150 EUR to someone else";
    expect(failed(edited, proof.signature!.fingerprint)).toEqual(expect.arrayContaining(['section "log" matches its digest', "the sections are exactly what the log says"]));
  });

  it("fails when someone rewrites the payment and signs it again with another key", async () => {
    const { store, id } = await paidInvoice();
    const genuine = signProof(buildProof(store, flows, id), key);
    // Edit the amount everywhere, recompute the digests, sign with a new key.
    const forged = buildProof(store, flows, id);
    for (const e of forged.log) if (e.type === "executed" && (e.payload as any)?.pay) (e.payload as any).pay.amount = "31500";
    const rebuilt = { ...forged, sections: forged.sections };
    const other = generateKeyPairSync("ed25519").privateKey;
    const resigned = signProof(JSON.parse(JSON.stringify(rebuilt)), other);
    const problems = failed(resigned, genuine.signature!.fingerprint);
    expect(problems).toContain(`the signer is the pinned key ${genuine.signature!.fingerprint.slice(0, 16)}…`);
    expect(problems.some((p) => /the action recorded hashes to/.test(p))).toBe(true);
  });

  it("fails when a quote's offsets do not point at it", async () => {
    const { store, id } = await paidInvoice();
    const proof = buildProof(store, flows, id);
    const q = (proof.sections.evidence as any).quotes[0];
    q.start += 3;
    q.end += 3;
    const problems = failed(signProof(proof, key), signProof(proof, key).signature!.fingerprint);
    expect(problems).toContain(`"${q.quote}" is at ${q.start}–${q.end} in the invoice text`);
    expect(problems).toContain("the sections are exactly what the log says");
  });
});
