import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Commands } from "../src/engine/commands.ts";
import { compile } from "../src/engine/expr.ts";
import { type Flow, loadFlow, type Outlet } from "../src/engine/flow-schema.ts";
import type { Outlets, OutletResult } from "../src/engine/ports.ts";
import { Runner } from "../src/engine/runner.ts";
import { fold, Store } from "../src/engine/store.ts";
import { CHECKS, setTableRow } from "../src/engine/verifiers.ts";
import { LiveOutlets } from "../src/outlets/index.ts";
import { sandboxPayees, startBank } from "../src/sandbox/bank.ts";
import { FakeSwitch, replyWith, attestRooms, invoiceReader, investigatorSays } from "./fake-switch.ts";

// Defects found by the independent review of the payment work, one test each.

const docsOf = parse(readFileSync("templates/invoice-check.template.yaml", "utf8")).room.docs as { name: string; content: string }[];
const MASTER = docsOf.find((d) => d.name === "vendor-master")!.content;
const POS = docsOf.find((d) => d.name === "purchase-orders")!.content;
const invoice = loadFlow(readFileSync("flows/invoice-check.flow.yaml", "utf8")) as Flow;
const NEW_IBAN = "DE63120300001064532871";
const HOUR = 3_600_000;
const matched = { result: "match", po_amount: 3150, reasons: [] };
const fabrikam = (number = "FP-1") => ({ supplier: "Fabrikam Print", number, amount: 3150, po: "PO-1043" });

let bank: Server;
let bankUrl: string;
beforeAll(async () => {
  bank = startBank({ port: 0, ledger: join(mkdtempSync(join(tmpdir(), "bank-")), "ledger.json"), payees: sandboxPayees() });
  await new Promise((r) => bank.once("listening", r));
  bankUrl = `http://127.0.0.1:${(bank.address() as { port: number }).port}`;
});
afterAll(() => bank.close());

class Paying implements Outlets {
  readonly paid: { outlet: Outlet; key: string }[] = [];
  private readonly live: () => LiveOutlets;
  failNext = false;
  constructor(chat: FakeSwitch) {
    this.live = () => new LiveOutlets({ dataDir: tmpdir(), bankUrl, smtp: { host: "127.0.0.1", port: 1, from: "x@y" } }, chat, new Store());
  }
  async execute(outlet: Outlet, key: string): Promise<OutletResult> {
    if (!("pay" in outlet)) return this.live().execute(outlet, key);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("connection reset");
    }
    this.paid.push({ outlet, key });
    return this.live().execute(outlet, key);
  }
  checkPayee(iban: string, name: string) {
    return this.live().checkPayee(iban, name);
  }
}

const setup = (opts: { people?: Record<string, string[]>; master?: string } = {}) => {
  let clock = Date.parse("2026-11-05T09:00:00Z");
  const store = new Store();
  const chat = new FakeSwitch().agent("@checker", invoiceReader()).agent("@checker-backup", investigatorSays(matched))
    .doc("finance", "purchase-orders", POS).doc("finance", "vendor-master", opts.master ?? MASTER);
  const outlets = new Paying(chat);
  const runner = new Runner(store, chat, outlets, [invoice], { now: () => clock, people: opts.people });
  attestRooms(store, chat);
  const open = async (data: Record<string, unknown>) => {
    const id = await runner.open("invoice-check", data, "webhook");
    await chat.deliver((m) => runner.onMessage(m));
    return id;
  };
  const master = () => chat.docs.get("finance")![1];
  return { store, chat, outlets, runner, open, master, advance: (ms: number) => (clock += ms) };
};

describe("cards from before a rewind", () => {
  it("cannot pay: an escalation card shown before the vendor master changed is ignored", async () => {
    const { store, chat, outlets, runner, open, master, advance } = setup();
    const id = await open({ ...fabrikam(), iban: NEW_IBAN }); // needs the controller
    advance(25 * HOUR);
    await runner.tick(); // escalates to the CFO with a card showing the old account
    const stale = chat.cards.at(-1)!;
    expect(stale.detail).toContain("DE29100500000190183746");

    master().content = setTableRow(MASTER, ["Fabrikam Print", "fabrikam.test", NEW_IBAN, "a@fabrikam.test", "1", "2026-11-05", "callback by @clerk"]);
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "pay", answeredBy: "mx:@controller" }); // rewinds
    await runner.tick();
    advance(25 * HOUR);
    await runner.tick(); // the new card escalates too, under a new id
    await runner.onApproval({ requestId: stale.requestId, answer: "pay", answeredBy: "mx:@cfo" });

    expect(outlets.paid).toHaveLength(0);
    expect(store.load(id).status).toBe("open");
    expect(new Set(chat.cards.map((c) => c.requestId)).size).toBe(chat.cards.length);
  });
});

describe("starting and repeating cases", () => {
  it("does not let anyone start a paying case from chat, even someone who holds a role", async () => {
    const { store, chat, runner } = setup();
    const commands = new Commands(runner, store, chat, [invoice], { "@controller": ["@priya"] });
    for (const sender of ["@intern", "@priya"]) {
      await commands.handle({ room: "finance", messageId: "u1", sender, body: "@yard start invoice-check supplier=Fabrikam number=FP-1 amount=3150 po=PO-1043", fromPerson: true });
    }
    expect(store.caseIds()).toHaveLength(0);
    expect(chat.posts.at(-1)!.body).toMatch(/`invoice-check` cases only come in through its own inlet \(webhook\), never from chat/);
  });

  it("does not let anyone start any case from chat until roles are mapped", async () => {
    const expense = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));
    const store = new Store();
    const chat = new FakeSwitch();
    const commands = new Commands(new Runner(store, chat, new Paying(chat), [expense]), store, chat, [expense], {});
    await commands.handle({ room: "ops-requests", messageId: "u1", sender: "@anyone", body: "@yard start expense name=A amount=10", fromPerson: true });
    expect(store.caseIds()).toHaveLength(0);
    expect(chat.posts.at(-1)!.body).toMatch(/until switchyard.yaml maps roles to people/);
  });

  it("pays one invoice once, however many times it arrives", async () => {
    const { store, chat, outlets, open } = setup();
    const first = await open(fabrikam("FP-77"));
    const again = await open({ ...fabrikam("FP-77"), amount: 3150.0 });
    // The same invoice, written a little differently, is still the same invoice.
    expect(await open({ ...fabrikam("FP 77"), supplier: "Fabrikam-Print" })).toBe(first);
    const other = await open(fabrikam("FP-78"));
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    // A new invoice number on the same PO is a new case, but never a second
    // automatic payment: the first case marked the PO as invoiced.
    expect(outlets.paid).toHaveLength(1);
    expect(store.load(other).pending?.kind).toBe("gate");
    expect(store.load(other).results.po_check).toMatchObject({ ok: false, detail: expect.stringContaining(`PO-1043 is invoiced FP-77 (case ${first})`) });
    expect(chat.said(`it is case ${first} already, so it was not opened twice`)).toBe(true);
    expect(store.caseIds()).toHaveLength(2);
  });
});

describe("names in any script", () => {
  const master = `| vendor | domain | iban | contact | phone | changed | verified |
|---|---|---|---|---|---|---|
| Δέλτα ΑΕ | delta.test | DE89370400440532013000 | a@delta.test | 1 | 2025-01-01 | callback 2025-01-01 |`;
  const docs = [{ id: "1", name: "vendor-master", content: master }];

  it("never matches a different supplier, or an empty name", () => {
    expect(CHECKS.vendor_bank.run({ doc: "vendor-master", vendor: "Άλφα ΑΕ" }, docs).detail).toMatch(/not in vendor-master/);
    expect(CHECKS.vendor_bank.run({ doc: "vendor-master", vendor: "" }, docs).ok).toBe(false);
    expect(CHECKS.vendor_bank.run({ doc: "vendor-master", vendor: "δέλτα αε" }, docs).ok).toBe(true);
    // A vowel sign is a combining mark, not punctuation: कमल is not कमला.
    const hindi = [{ id: "3", name: "vm", content: master.replace("Δέλτα ΑΕ", "कमला") }];
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "कमल" }, hindi).ok).toBe(false);
    const po = [{ id: "2", name: "po", content: "| PO | supplier | amount | status |\n|---|---|---|---|\n| PO-1 | Δέλτα ΑΕ | 10.00 | open |" }];
    expect(CHECKS.po_lookup.run({ doc: "po", po: "PO-1", supplier: "Άλφα ΑΕ", amount: 10 }, po).ok).toBe(false);
  });
});

describe("the vendor master's own columns", () => {
  const row = (verified: string, changed = "2025-01-01") => [{ id: "1", name: "vm", content: `| v | d | i | c | p | ch | ve |\n|---|---|---|---|---|---|---|\n| Acme | acme.test | DE89370400440532013000 | a | 1 | ${changed} | ${verified} |` }];
  it("counts only a recorded callback as verified", () => {
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "Acme" }, row("not verified")).detail).toMatch(/never verified/);
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "Acme" }, row("pending")).detail).toMatch(/never verified/);
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "Acme" }, row("callback 2025-01-01")).ok).toBe(true);
  });
  it("treats a change date it cannot read as recent, so a person approves", () => {
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "Acme" }, row("callback", "05.11.2026"))).toMatchObject({ recent: true });
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "Acme" }, row("callback", "2025-02-30"))).toMatchObject({ recent: true });
    expect(CHECKS.vendor_bank.run({ doc: "vm", vendor: "Acme" }, row("callback", "2025-02-28"))).toMatchObject({ recent: false });
  });
});

describe("re-checks", () => {
  it("watch only the rows a check relied on: editing another supplier does not re-open this card", async () => {
    const { store, outlets, chat, runner, open, master } = setup();
    const id = await open({ ...fabrikam(), iban: NEW_IBAN });
    master().content = master().content.replace("+49 30 5550 1001", "+49 30 5550 7777"); // Northwind's row
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "pay", answeredBy: "mx:@controller" });
    expect(store.events(id).some((e) => e.type === "rewound")).toBe(false);
    expect(outlets.paid).toHaveLength(1);
  });

  it("stop for a person when two documents share a name, instead of looping", async () => {
    const { store, chat, outlets, open } = setup();
    chat.doc("finance", "vendor-master", MASTER);
    const id = await open(fabrikam());
    expect(store.load(id).results.bank_check).toMatchObject({ ok: false, detail: expect.stringMatching(/2 documents in this room are named "vendor-master"/) });
    expect(outlets.paid).toHaveLength(0);
    expect(store.events(id).filter((e) => e.type === "rewound")).toHaveLength(0);
  });

  it("forget the approvals a rewound gate gave", () => {
    const state = fold("c", [
      { type: "opened", flow: "f", room: "r", data: {} },
      { type: "gate_opened", step: "g", requestId: "c-g", approver: "@a", hashes: { out: "h1" }, at: 0 },
      { type: "gate_answered", step: "g", answer: "ok", answeredBy: "@a", approved: true },
      { type: "rewound", step: "out", steps: ["g"], docs: {} },
    ]);
    expect(state.approved).toEqual({});
    expect(state.deciders).toEqual({});
  });
});

describe("in doubt", () => {
  it("'send it again' pays through the same path: a readable receipt and a read-back", async () => {
    const { store, chat, outlets, runner, open } = setup();
    outlets.failNext = true;
    const id = await open(fabrikam("FP-9"));
    expect(store.load(id).pending?.kind).toBe("in_doubt");

    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "send it again", answeredBy: "mx:@controller" });
    const executed = store.events(id).find((e) => e.type === "executed" && e.step === "schedule_payment");
    expect(executed?.type === "executed" && executed.receipt).toMatch(/^paid 3150 EUR to Fabrikam Print at DE29100500000190183746 \(sandbox bank SBX-\d+\) \(resent by @controller\)$/);
    expect(executed).toMatchObject({ readback: executed?.type === "executed" ? executed.hash : "" });
    expect(store.load(id).status).toBe("done");
  });
});

describe("conditions", () => {
  it("treat a missing field as null", () => {
    expect(compile("x.y != null")({ x: {} })).toBe(false);
    expect(compile("x.y == null")({ x: {} })).toBe(true);
    expect(compile("x.y != null")({ x: { y: "a" } })).toBe(true);
  });
});

describe("smaller checks", () => {
  it("refuses a bank change when no domain is on file to compare with", () => {
    const docs = [{ id: "1", name: "vm", content: "| v | d | i |\n|---|---|---|\n| Acme |  | DE89370400440532013000 |" }];
    expect(CHECKS.bank_change.run({ doc: "vm", vendor: "Acme", sender: "x@", iban: "DE29100500000190183746" }, docs).detail).toMatch(/no domain on file/);
  });

  it("never overwrites the header row", () => {
    const out = setTableRow(MASTER, ["vendor", "evil.test", "DE89370400440532013000"]);
    expect(out.split("\n")[0]).toBe(MASTER.split("\n")[0]);
    expect(out).toContain("| vendor | evil.test | DE89370400440532013000 |");
  });

  it("checks an IBAN's length for its country", async () => {
    const { ibanValid } = await import("../src/engine/verifiers.ts");
    expect(ibanValid("DE543704004405320130001")).toBe(false); // check digits fine, 23 characters
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
  });

  it("stops, and says nothing was paid, when the bank refuses outright", async () => {
    const bad = MASTER.replace("DE29100500000190183746", "DE543704004405320130001");
    const { store, chat, open, runner } = setup({ master: bad });
    const id = await open(fabrikam("FP-55"));
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "pay", answeredBy: "mx:@controller" });
    expect(store.load(id).status).toBe("failed");
    expect(chat.said("the bank refused the payment: 422")).toBe(true);
    expect(store.events(id).some((e) => e.type === "in_doubt")).toBe(false);
  });
});
