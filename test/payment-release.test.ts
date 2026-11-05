import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Flow, loadFlow, type Outlet } from "../src/engine/flow-schema.ts";
import type { Outlets, OutletResult } from "../src/engine/ports.ts";
import { Commands } from "../src/engine/commands.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { basisHash, CHECKS, editDistance, ibanValid, setTableRow } from "../src/engine/verifiers.ts";
import { LiveOutlets } from "../src/outlets/index.ts";
import { hashOutlet } from "../src/outlets/payload.ts";
import { startBank } from "../src/sandbox/bank.ts";
import { FakeSwitch, replyWith } from "./fake-switch.ts";

// Releasing supplier payments: bank details change only through a checked,
// called-back, four-eyes case; payments go only to the account on file; and
// nothing is paid on facts that changed after the checks ran.

const docsOf = (file: string) => parse(readFileSync(file, "utf8")).room.docs as { name: string; content: string }[];
const MASTER = docsOf("templates/invoice-check.template.yaml").find((d) => d.name === "vendor-master")!.content;
const POS = docsOf("templates/invoice-check.template.yaml").find((d) => d.name === "purchase-orders")!.content;
const flows = ["bank-change", "invoice-check"].map((f) => loadFlow(readFileSync(`flows/${f}.flow.yaml`, "utf8")));
const flow = (name: string) => flows.find((f) => f.flow === name) as Flow;
const NEW_IBAN = "DE63120300001064532871";
const FABRIKAM = "DE29100500000190183746";
const vendor = (args: Record<string, unknown>) => CHECKS.bank_change.run({ doc: "vendor-master", ...args }, [{ id: "1", name: "vendor-master", content: MASTER }]);

// Writes room documents for real (through the live outlet), records the rest.
class TestOutlets implements Outlets {
  readonly done: { outlet: Outlet; key: string }[] = [];
  private readonly live: LiveOutlets;
  constructor(chat: FakeSwitch, bankUrl = "http://127.0.0.1:1") {
    this.live = new LiveOutlets({ dataDir: tmpdir(), bankUrl, smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, chat, new Store());
  }
  async execute(outlet: Outlet, key: string): Promise<OutletResult> {
    this.done.push({ outlet, key });
    if ("document" in outlet || "pay" in outlet) return this.live.execute(outlet, key);
    return `did ${key}`;
  }
}

describe("code checks for bank details", () => {
  it("validates IBAN check digits", () => {
    expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(ibanValid("DE89370400440532013001")).toBe(false);
    expect(ibanValid("not an iban")).toBe(false);
  });

  it("measures how far a look-alike domain is", () => {
    expect(editDistance("fabrikarn.test", "fabrikam.test")).toBe(2);
    expect(editDistance("fabrikma.test", "fabrikam.test")).toBe(1);
    expect(editDistance("fabrikam.test", "fabrikam.test")).toBe(0);
  });

  it("refuses a change from a look-alike domain and says why", () => {
    const r = vendor({ vendor: "Fabrikam Print", sender: "accounts@fabrikarn.test", iban: NEW_IBAN });
    expect(r).toMatchObject({ ok: false, lookalike: true, contact: "accounts@fabrikam.test" });
    expect(r.detail).toMatch(/fabrikarn.test, 2 characters away from fabrikam.test on file: a look-alike domain/);
  });

  it("passes a change from the supplier's own domain to a valid new account", () => {
    expect(vendor({ vendor: "Fabrikam Print", sender: "accounts@fabrikam.test", iban: NEW_IBAN })).toMatchObject({ ok: true, new_tail: "2871", phone: "+49 30 5550 1003" });
  });

  it("refuses an invalid account, an unchanged account, and an unknown supplier", () => {
    expect(vendor({ vendor: "Fabrikam Print", sender: "a@fabrikam.test", iban: "DE00120300001064532871" }).detail).toMatch(/not a valid IBAN/);
    expect(vendor({ vendor: "Fabrikam Print", sender: "a@fabrikam.test", iban: FABRIKAM }).detail).toMatch(/already on file/);
    expect(vendor({ vendor: "Evil Corp", sender: "a@evil.test", iban: NEW_IBAN }).detail).toMatch(/not in vendor-master/);
  });

  it("pays the account on file, flags a different printed account, and holds a recent change", () => {
    const docs = [{ id: "1", name: "vendor-master", content: MASTER }];
    const check = (args: Record<string, unknown>, now = Date.parse("2026-11-05")) => CHECKS.vendor_bank.run({ doc: "vendor-master", ...args }, docs, now);
    expect(check({ vendor: "Fabrikam Print" })).toMatchObject({ ok: true, iban: FABRIKAM, recent: false });
    expect(check({ vendor: "Fabrikam Print", iban: NEW_IBAN }).detail).toMatch(/invoice asks for payment to DE63…2871, but DE29…3746 is on file/);
    expect(check({ vendor: "Fabrikam Print" }, Date.parse("2025-04-01"))).toMatchObject({ ok: true, recent: true });
  });

  it("sets one row of a table, or appends it", () => {
    const updated = setTableRow(MASTER, ["Fabrikam Print", "fabrikam.test", NEW_IBAN, "a", "b", "2026-11-05", "callback by @clerk"]);
    expect(updated).toContain(`| Fabrikam Print | fabrikam.test | ${NEW_IBAN} |`);
    expect(updated).not.toContain(FABRIKAM);
    expect(updated.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(MASTER.split("\n").filter((l) => l.startsWith("|")).length);
    expect(setTableRow(MASTER, ["Acme New", "x"])).toMatch(/\| Acme New \| x \|\n$/);
  });
});

describe("a bank-detail change", () => {
  const setup = (sender: string) => {
    const store = new Store();
    const chat = new FakeSwitch()
      .agent("@checker", replyWith({ vendor: "Fabrikam Print", new_iban: "DE63 1203 0000 1064 5328 71", reason: "audit", red_flags: ["urgency"] }))
      .doc("finance", "vendor-master", MASTER);
    const outlets = new TestOutlets(chat);
    // One person can hold both roles; four eyes must still keep them apart.
    const people = { "@ap-clerk": ["@clerk"], "@controller": ["@controller", "@clerk"] };
    const runner = new Runner(store, chat, outlets, [flow("bank-change")], { people });
    const open = async () => {
      const id = await runner.open("bank-change", { from: sender, subject: "bank details", body: "..." }, `email from ${sender}`);
      await chat.deliver((m) => runner.onMessage(m));
      return id;
    };
    const answer = (n: number, who: string, choice: string) => runner.onApproval({ requestId: chat.cards[n].requestId, answer: choice, answeredBy: `mx:${who}` });
    return { store, chat, outlets, open, answer, master: () => chat.docs.get("finance")![0].content };
  };

  it("from a look-alike domain is blocked, and the real supplier is warned at the address on file", async () => {
    const { chat, outlets, open, answer, master } = setup("accounts@fabrikarn.test");
    await open();
    expect(chat.cards[0].title).toMatch(/block this bank-detail change request/);
    await answer(0, "@controller", "block");

    expect(outlets.done.map((d) => Object.keys(d.outlet)[0])).toEqual(["email"]);
    expect(outlets.done[0].outlet).toMatchObject({ email: { to: "accounts@fabrikam.test" } });
    expect(master()).toBe(MASTER);
  });

  it("needs a callback and a second person, then changes exactly one row", async () => {
    const { store, chat, open, answer, master } = setup("accounts@fabrikam.test");
    const id = await open();
    expect(chat.cards[0].title).toMatch(/call Fabrikam Print on \+49 30 5550 1003 \(the number on file, not one from the email\).*ends in 2871/);
    await answer(0, "@clerk", "confirmed");

    // The person who made the call cannot approve the change.
    await answer(1, "@clerk", "approve");
    expect(chat.said("@clerk answered \"callback\", so a different person must decide \"approve\"")).toBe(true);
    expect(master()).toBe(MASTER);

    await answer(2, "@controller", "approve");
    expect(store.load(id).status).toBe("done");
    expect(master()).toContain(`| Fabrikam Print | fabrikam.test | ${NEW_IBAN} | accounts@fabrikam.test | +49 30 5550 1003 |`);
    expect(master()).toContain("callback by @clerk");
    expect(master()).not.toContain(FABRIKAM);
  });

  it("is not written if the vendor master changed after the checks read it", async () => {
    const { store, chat, open, answer, master } = setup("accounts@fabrikam.test");
    const id = await open();
    await answer(0, "@clerk", "confirmed");
    // Someone edits the vendor master while the approval card is open.
    chat.docs.get("finance")![0].content = MASTER.replace("+49 30 5550 1003", "+49 30 5550 9999");
    await answer(1, "@controller", "approve");

    expect(store.events(id).some((e) => e.type === "rewound")).toBe(true);
    expect(chat.said("a document the checks read changed after they ran")).toBe(true);
    expect(master()).not.toContain(NEW_IBAN);
    // The checks ran again on the new version, and the callback is asked again, with the new number.
    expect(chat.cards.at(-1)!.title).toMatch(/\+49 30 5550 9999/);
  });
});

describe("paying an invoice", () => {
  let bank: Server;
  let bankUrl: string;
  const ledger = join(mkdtempSync(join(tmpdir(), "bank-")), "ledger.json");
  beforeAll(async () => {
    bank = startBank({ port: 0, ledger });
    await new Promise((r) => bank.once("listening", r));
    bankUrl = `http://127.0.0.1:${(bank.address() as { port: number }).port}`;
  });
  afterAll(() => bank.close());

  const setup = (verdict: Record<string, unknown>) => {
    const store = new Store();
    const chat = new FakeSwitch().agent("@checker", replyWith(verdict)).agent("@checker-backup", replyWith(verdict))
      .doc("finance", "purchase-orders", POS).doc("finance", "vendor-master", MASTER);
    const outlets = new TestOutlets(chat, bankUrl);
    const runner = new Runner(store, chat, outlets, [flow("invoice-check")], { now: () => Date.parse("2026-11-05") });
    return { store, chat, outlets, runner };
  };
  const matched = { result: "match", po_amount: 3150, reasons: ["PO-1043 matches"] };

  it("pays the account on file by rule, and the bank's copy hashes to the approved action", async () => {
    const { store, chat, runner } = setup(matched);
    const id = await runner.open("invoice-check", { supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043" }, "webhook");
    await chat.deliver((m) => runner.onMessage(m));

    const executed = store.events(id).find((e) => e.type === "executed");
    expect(executed).toMatchObject({ readback: executed?.type === "executed" ? executed.hash : "" });
    expect(executed?.type === "executed" && executed.receipt).toMatch(/paid 3150 EUR to Fabrikam Print \(sandbox bank SBX-\d+\)/);
    const held = JSON.parse(readFileSync(ledger, "utf8")).find((p: { key: string }) => p.key === `${id}/schedule_payment`);
    expect(held).toMatchObject({ to: FABRIKAM, amount: "3150" });
  });

  it("pays the account on file even when the invoice prints another one, after a person decides", async () => {
    const { store, chat, runner } = setup(matched);
    const id = await runner.open("invoice-check", { supplier: "Fabrikam Print", number: "FP-0913", amount: 3150, po: "PO-1043", iban: NEW_IBAN }, "webhook");
    await chat.deliver((m) => runner.onMessage(m));
    expect(chat.cards[0].detail).toMatch(/✗ checked by code \(vendor_bank\): the invoice asks for payment to DE63…2871, but DE29…3746 is on file/);
    expect(chat.cards[0].detail).toContain(`Account: ${FABRIKAM}`);
    expect(chat.cards[0].detail).toMatch(/Checked against room documents: purchase-orders \(PO-1043's row\) \w+, vendor-master \(Fabrikam Print's row\) \w+/);

    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "pay", answeredBy: "mx:@controller" });
    expect(store.events(id).find((e) => e.type === "executed")).toMatchObject({ payload: { pay: { to: FABRIKAM } } });
  });

  it("does not pay on an approval given before the vendor master changed", async () => {
    const { store, chat, runner } = setup(matched);
    const id = await runner.open("invoice-check", { supplier: "Fabrikam Print", number: "FP-0914", amount: 3150, po: "PO-1043", iban: NEW_IBAN }, "webhook");
    await chat.deliver((m) => runner.onMessage(m));
    const before = basisHash(MASTER, "Fabrikam Print");
    // A bank-change case (or an insider) rewrites Fabrikam's row while the card is open.
    chat.docs.get("finance")![1].content = setTableRow(MASTER, ["Fabrikam Print", "fabrikam.test", NEW_IBAN, "accounts@fabrikam.test", "+49 30 5550 1003", "2026-11-05", "callback by @clerk"]);
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "pay", answeredBy: "mx:@controller" });

    expect(store.events(id).some((e) => e.type === "executed")).toBe(false);
    expect(store.events(id).find((e) => e.type === "rewound")).toMatchObject({ docs: { "vendor-master": [before, expect.any(String)] } });
    // A new card, on the new facts: the account changed today, so a person decides again.
    expect(chat.cards).toHaveLength(2);
    expect(chat.cards[1].requestId).toMatch(/-v2$/);
    expect(chat.cards[1].detail).toContain(`Account: ${NEW_IBAN}`);
    expect(chat.cards[1].detail).toMatch(/changed 2026-11-05 \(first payment since: a person approves\)/);
  });

  it("is paid at most once per key, and refuses a different payment under the same key", async () => {
    const outlets = new LiveOutlets({ dataDir: tmpdir(), bankUrl, smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, new FakeSwitch(), new Store());
    const pay = { pay: { payee: "Northwind Paper", to: "DE89370400440532013000", amount: "1240", currency: "EUR", reference: "NW-9" } };
    const first = await outlets.execute(pay, "k1/pay");
    const again = await outlets.execute(pay, "k1/pay");
    expect(again).toEqual(first);
    expect(typeof first === "object" && first.readback).toBe(hashOutlet(pay));
    await expect(outlets.execute({ pay: { ...pay.pay, amount: "9999" } }, "k1/pay")).rejects.toThrow(/409/);
    expect(JSON.parse(readFileSync(ledger, "utf8")).filter((p: { key: string }) => p.key === "k1/pay")).toHaveLength(1);
  });
});

describe("the documents payments rest on", () => {
  it("cannot be edited from chat, even by someone who holds a role", async () => {
    const store = new Store();
    const chat = new FakeSwitch().doc("finance", "vendor-master", MASTER).doc("finance", "purchase-orders", POS);
    const runner = new Runner(store, chat, new TestOutlets(chat), flows);
    const commands = new Commands(runner, store, chat, flows, { "@controller": ["@priya"] });
    await commands.handle({ room: "finance", messageId: "u1", sender: "@priya", body: `@yard edit vendor-master "${FABRIKAM}" "${NEW_IBAN}"`, fromPerson: true });

    expect(chat.docs.get("finance")![0].content).toBe(MASTER);
    expect(chat.posts.at(-1)!.body).toMatch(/`vendor-master` is read by code checks \(bank-change.checks, invoice-check.bank_check\), so it cannot be edited from chat; changes go through a `bank-change` case/);
  });
});
