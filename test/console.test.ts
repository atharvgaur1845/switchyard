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
import { loadOrCreateKey } from "../src/proof.ts";
import { sandboxPayees, startBank } from "../src/sandbox/bank.ts";
import { startServer } from "../src/server.ts";
import { attestRooms, FakeSwitch, invoiceReader, investigatorSays } from "./fake-switch.ts";

// What the dashboard's Proofs and Attack lab views call: a proof checked on
// the exact bytes sent, and held-out scenarios run on demand.
const docs = parse(readFileSync("templates/invoice-check.template.yaml", "utf8")).room.docs as { name: string; content: string }[];
const doc = (name: string) => docs.find((d) => d.name === name)!.content;
const flows = ["bank-change", "invoice-check"].map((f) => loadFlow(readFileSync(`flows/${f}.flow.yaml`, "utf8")));
const TEXT = "Fabrikam Print, invoice FP-0901, print run for PO-1043. Total 3,150.00 EUR, due in 7 days.";

let bank: Server;
let server: Server;
let base: string;
let caseId: string;
beforeAll(async () => {
  bank = startBank({ port: 0, ledger: join(mkdtempSync(join(tmpdir(), "bank-")), "ledger.json"), payees: sandboxPayees() });
  await new Promise((r) => bank.once("listening", r));
  const chat = new FakeSwitch()
    .agent("@checker", invoiceReader({ quotes: ["Fabrikam Print", "FP-0901", "PO-1043", "3,150.00 EUR"] }))
    .agent("@checker-backup", investigatorSays())
    .doc("finance", "purchase-orders", doc("purchase-orders"))
    .doc("finance", "vendor-master", doc("vendor-master"))
    .doc("finance", "payment-mandates", doc("payment-mandates"));
  const store = new Store();
  const outlets = new LiveOutlets({ dataDir: tmpdir(), bankUrl: `http://127.0.0.1:${(bank.address() as { port: number }).port}`, smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, chat, store);
  const runner = new Runner(store, chat, outlets, flows, { now: () => Date.parse("2026-11-06") });
  attestRooms(store, chat);
  caseId = await runner.open("invoice-check", { supplier: "Fabrikam Print", number: "FP-0901", amount: 3150, po: "PO-1043", text: TEXT }, "webhook");
  await chat.deliver((m) => runner.onMessage(m));
  const proofKey = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "keys-")), "proof.pem"));
  server = startServer({ port: 0, flows, runner, store, proofKey });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  bank.close();
  server.close();
});

const post = (path: string, body: string) => fetch(base + path, { method: "POST", body });

describe("the dashboard's proof check", () => {
  it("names the key it trusts, and passes the proof it handed out", async () => {
    const overview = await (await fetch(`${base}/api/overview`)).json();
    expect(overview.proof).toMatchObject({ from: "this Switchyard's signing key" });
    const proof = await (await fetch(`${base}/api/proof/${caseId}`)).text();
    const { findings, pinned } = await (await post("/api/verify-proof", proof)).json();
    expect(pinned.fingerprint).toBe(overview.proof.fingerprint);
    expect(findings.filter((f: { ok: boolean }) => !f.ok)).toEqual([]);
  });

  it("fails an edited copy, and says what is wrong", async () => {
    const proof = await (await fetch(`${base}/api/proof/${caseId}`)).json();
    proof.log.find((e: { type: string; payload?: { pay?: unknown } }) => e.type === "executed" && e.payload?.pay).payload.pay.amount = "3151";
    const { findings } = await (await post("/api/verify-proof", JSON.stringify(proof))).json();
    const failed = findings.filter((f: { ok: boolean }) => !f.ok).map((f: { what: string }) => f.what);
    expect(failed).toEqual(expect.arrayContaining(['section "log" matches its digest', "the sections are exactly what the log says"]));
    expect(failed.some((w: string) => /^schedule_payment: the action recorded hashes to/.test(w))).toBe(true);
  });

  it("refuses a file that is not a proof", async () => {
    expect((await post("/api/verify-proof", "not json")).status).toBe(400);
    const { findings } = await (await post("/api/verify-proof", "{}")).json();
    expect(findings.some((f: { ok: boolean }) => !f.ok)).toBe(true);
  });
});

describe("the dashboard's attack lab", () => {
  it("lists the 20 held-out scenarios", async () => {
    const list = await (await fetch(`${base}/api/lab`)).json();
    expect(list.map((s: { id: string }) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => `H${String(i + 1).padStart(2, "0")}`));
    expect(list[0].steps.every((s: unknown) => typeof s === "string")).toBe(true);
  });

  it("runs one under the controls asked for, with its trace", async () => {
    // H05, the factoring company: links on hold one benign change, as the held-out table says.
    const off = await (await post("/api/lab", JSON.stringify({ id: "H05", links: false }))).json();
    const on = await (await post("/api/lab", JSON.stringify({ id: "H05", links: true }))).json();
    expect(off.run).toMatchObject({ pass: true, toAttacker: 0 });
    expect(on.run.pass).toBe(false);
    expect(on.run.failures).toContain("b: not changed, expected changed");
    expect(on.run.cases.find((c: { label?: string }) => c.label === "b").events.length).toBeGreaterThan(0);
    expect(on.controls).toEqual({ links: true, fooled: false, bank: "unavailable" });
  });

  it("refuses anything but a held-out scenario id", async () => {
    expect((await post("/api/lab", JSON.stringify({ id: "../../etc" }))).status).toBe(400);
  });
});
