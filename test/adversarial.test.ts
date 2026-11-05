import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Flow, loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { CHECKS } from "../src/engine/verifiers.ts";
import { LiveOutlets } from "../src/outlets/index.ts";
import { startBank } from "../src/sandbox/bank.ts";
import { caseSummaries } from "../src/web/api.ts";
import { FakeSwitch, replyWith } from "./fake-switch.ts";

// Attacks on supplier payments, each one paired with the control that stops
// it. Every test was a probe that paid (or misled) on the code before the
// fix; the README's attack table names them.

const docsOf = (file: string) => parse(readFileSync(file, "utf8")).room.docs as { name: string; content: string }[];
const MASTER = docsOf("templates/invoice-check.template.yaml").find((d) => d.name === "vendor-master")!.content;
const POS = docsOf("templates/invoice-check.template.yaml").find((d) => d.name === "purchase-orders")!.content;
const flows = ["bank-change", "invoice-check"].map((f) => loadFlow(readFileSync(`flows/${f}.flow.yaml`, "utf8")));
const FABRIKAM = "DE29100500000190183746";
const MULE = "DE68370400440532099999";
const PRINTED = "DE88500700100175526303";
const fabrikam = (number: string, extra: Record<string, unknown> = {}) => ({ supplier: "Fabrikam Print", number, amount: 3150, po: "PO-1043", ...extra });

let bank: Server;
let bankUrl: string;
const ledger = join(mkdtempSync(join(tmpdir(), "bank-")), "ledger.json");
const paidInLedger = () => {
  try {
    return JSON.parse(readFileSync(ledger, "utf8")) as { key: string; to: string; reference: string }[];
  } catch {
    return [];
  }
};
beforeAll(async () => {
  bank = startBank({ port: 0, ledger });
  await new Promise((r) => bank.once("listening", r));
  bankUrl = `http://127.0.0.1:${(bank.address() as { port: number }).port}`;
});
afterAll(() => bank.close());

// As `switchyard up` does: the room's documents exist, and Switchyard
// attests them at start, before anyone can edit them.
async function rig() {
  const verdict = { result: "match", po_amount: 3150, reasons: ["PO-1043 matches"] };
  const chat = new FakeSwitch()
    .agent("@checker", replyWith(verdict))
    .agent("@checker-backup", replyWith(verdict))
    .doc("finance", "purchase-orders", POS)
    .doc("finance", "vendor-master", MASTER);
  const store = new Store();
  const outlets = new LiveOutlets({ dataDir: tmpdir(), bankUrl, smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, chat, store);
  const runner = new Runner(store, chat, outlets, flows, { now: () => Date.parse("2026-11-06") });
  await runner.attestRows();
  const doc = (name: string) => chat.docs.get("finance")!.find((d) => d.name === name)!;
  const open = async (data: Record<string, unknown>) => {
    const id = await runner.open("invoice-check", data, "webhook");
    await chat.deliver((m) => runner.onMessage(m));
    return id;
  };
  const paid = (id: string) => store.events(id).filter((e) => e.type === "executed" && e.step === "schedule_payment");
  return { chat, store, runner, doc, open, paid };
}

describe("attacks on paying an invoice", () => {
  it("a second invoice for an already invoiced PO, under a new number, waits for a person", async () => {
    const { store, open, paid } = await rig();
    const first = await open(fabrikam("FP-0912"));
    const before = paidInLedger().length;
    // A new number, a longer number, and a Cyrillic "Р" that looks like "P".
    for (const number of ["FP-0913", "FP-09120", "FР-0912"]) {
      const id = await open(fabrikam(number));
      expect(paid(id)).toHaveLength(0);
      expect(store.load(id).pending?.kind).toBe("gate");
      expect(store.load(id).results.po_check).toMatchObject({ ok: false, detail: expect.stringContaining(`PO-1043 is invoiced FP-0912 (case ${first})`) });
    }
    expect(paid(first)).toHaveLength(1);
    expect(paidInLedger().length).toBe(before);
  });

  it("two cards open on one PO: once one is paid, the other's approval no longer counts", async () => {
    const { chat, store, runner, open, paid } = await rig();
    // Both print another account, so both wait on a card with the PO still open.
    const a = await open(fabrikam("FP-2001", { iban: PRINTED }));
    const b = await open(fabrikam("FP-2002", { iban: PRINTED }));
    const cardOf = (id: string) => chat.cards.findLast((c) => c.requestId.startsWith(id))!;
    await runner.onApproval({ requestId: cardOf(a).requestId, answer: "pay", answeredBy: "mx:@controller" });
    await runner.onApproval({ requestId: cardOf(b).requestId, answer: "pay", answeredBy: "mx:@controller" });

    expect(paid(a)).toHaveLength(1);
    expect(paid(b)).toHaveLength(0);
    expect(store.events(b).some((e) => e.type === "rewound")).toBe(true);
    expect(store.load(b).results.po_check).toMatchObject({ ok: false, detail: expect.stringContaining("PO-1043 is invoiced FP-2001") });
    expect(store.load(b).pending?.kind).toBe("gate");
  });

  it("a supplier named only part of the name on the PO is not that supplier", () => {
    const docs = [{ id: "1", name: "purchase-orders", content: POS }];
    for (const claimed of ["Fabrikam", "Print", "a", "Fabrikam Print Holdings"]) {
      expect(CHECKS.po_lookup.run({ doc: "purchase-orders", po: "PO-1043", supplier: claimed, amount: 3150 }, docs).ok).toBe(false);
    }
    expect(CHECKS.po_lookup.run({ doc: "purchase-orders", po: "PO-1043", supplier: "fabrikam  print", amount: 3150 }, docs).ok).toBe(true);
  });

  it("a PO is open only when its status says exactly that", () => {
    for (const [status, open] of [["open", true], ["Open", true], ["not open", false], ["reopen pending", false], ["paid (was open)", false]] as const) {
      const docs = [{ id: "1", name: "po", content: `| PO | supplier | amount | status |\n|---|---|---|---|\n| PO-1 | Acme | 10.00 | ${status} |` }];
      expect(CHECKS.po_lookup.run({ doc: "po", po: "PO-1", supplier: "Acme", amount: 10 }, docs).ok).toBe(open);
    }
  });
});

describe("attacks on the vendor master from inside the room", () => {
  it("an account swapped in the room directly is never paid, even when a person clicks pay", async () => {
    const { chat, store, runner, doc, open, paid } = await rig();
    // Someone with write access to the document swaps the IBAN, keeps the old
    // change date and types "callback", so every field looks verified.
    doc("vendor-master").content = doc("vendor-master").content.replace(FABRIKAM, MULE);
    const id = await open(fabrikam("FP-3001"));

    expect(paid(id)).toHaveLength(0);
    expect(store.load(id).results.bank_check).toMatchObject({
      ok: false,
      attested: false,
      detail: expect.stringMatching(/^Fabrikam Print's row in vendor-master is not what Switchyard last wrote there \(first seen at start\): it was changed in the room directly/),
    });
    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "pay", answeredBy: "mx:@controller" });
    expect(paid(id)).toHaveLength(0);
    expect(paidInLedger().some((p) => p.to === MULE)).toBe(false);
    expect(caseSummaries(store, flows).find((c) => c.id === id)?.outcome).toEqual({ label: "Held · row edited in the room", tone: "stop" });
  });

  it("restoring the row by hand makes it pass again", async () => {
    const { doc, open, paid } = await rig();
    doc("vendor-master").content = doc("vendor-master").content.replace(FABRIKAM, MULE);
    doc("vendor-master").content = doc("vendor-master").content.replace(MULE, FABRIKAM);
    expect(paid(await open(fabrikam("FP-3002")))).toHaveLength(1);
  });

  it("a vendor added in the room directly is not paid", async () => {
    const { store, doc, open, paid } = await rig();
    doc("vendor-master").content += `| Fabrikam Prints | fabrikam-prints.test | ${MULE} | a@fabrikam-prints.test | +49 1 | 2025-01-01 | callback 2025-01-01 |\n`;
    doc("purchase-orders").content += "| PO-9001 | Fabrikam Prints | 3,150.00 | open |\n";
    const id = await open({ supplier: "Fabrikam Prints", number: "X-1", amount: 3150, po: "PO-9001" });
    expect(paid(id)).toHaveLength(0);
    expect(store.load(id).results.bank_check).toMatchObject({ attested: false, detail: expect.stringMatching(/added in the room directly, not by a case/) });
    expect(store.load(id).results.po_check).toMatchObject({ attested: false });
  });

  it("a PO raised in the room directly goes to a person, who may still pay it", async () => {
    const { chat, store, runner, doc, open, paid } = await rig();
    doc("purchase-orders").content = doc("purchase-orders").content.replace("| PO-1043 | Fabrikam Print | 3,150.00 | open |", "| PO-1043 | Fabrikam Print | 9,150.00 | open |");
    const id = await open(fabrikam("FP-4001", { amount: 9150 }));
    expect(paid(id)).toHaveLength(0);
    expect(store.load(id).results.po_check).toMatchObject({ ok: false, attested: false });
    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "pay", answeredBy: "mx:@controller" });
    // The person decided with the evidence on the card; the account is the attested one on file.
    expect(paid(id)).toHaveLength(1);
    expect(paid(id)[0]).toMatchObject({ payload: { pay: { to: FABRIKAM } } });
  });
});
