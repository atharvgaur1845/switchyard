import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { comparePayee, sandboxPayees } from "../src/sandbox/bank.ts";
import { attestRooms, FakeSwitch, invoiceReader, investigatorSays, RecordingOutlets, replyWith } from "./fake-switch.ts";

// Who holds the account, said by the bank (Verification of Payee, in the
// sandbox), not by the email, the callback or the vendor master.
const docs = parse(readFileSync("templates/invoice-check.template.yaml", "utf8")).room.docs as { name: string; content: string }[];
const doc = (name: string) => docs.find((d) => d.name === name)!.content;
const MASTER = doc("vendor-master");
const POS = doc("purchase-orders");
const MANDATES = doc("payment-mandates");
const flows = ["bank-change", "invoice-check"].map((f) => loadFlow(readFileSync(`flows/${f}.flow.yaml`, "utf8")));
const FACTOR = "DE12500105170648489890";

describe("the sandbox bank's payee answers", () => {
  it("compares names the way the schemes answer", () => {
    expect(comparePayee("Fabrikam Print GmbH", "Fabrikam Print")).toBe("match");
    expect(comparePayee("Fabrikam Print Services s.r.o.", "Fabrikam Print")).toBe("close_match");
    expect(comparePayee("Fabrikam Prnt GmbH", "Fabrikam Print")).toBe("close_match");
    expect(comparePayee("Jonas Petrak", "Northwind Paper")).toBe("no_match");
  });
});

function world(opts: { master?: string; mandates?: string; payees?: Record<string, string>; editMandates?: string } = {}) {
  const store = new Store();
  const chat = new FakeSwitch()
    .agent("@checker", (r) => (r.includes("asks us to change the bank account") ? replyWith({ vendor: "Fabrikam Print", new_iban: /(DE\d{2}(?: ?\d{4}){4} ?\d{2})/.exec(r)?.[1] ?? "", reason: "new bank", red_flags: [] })(r) : invoiceReader()(r)))
    .agent("@checker-backup", investigatorSays())
    .doc("finance", "purchase-orders", POS)
    .doc("finance", "vendor-master", opts.master ?? MASTER)
    .doc("finance", "payment-mandates", opts.mandates ?? MANDATES);
  const outlets = new RecordingOutlets();
  outlets.payees = { ...sandboxPayees(), ...(opts.payees ?? {}) };
  const runner = new Runner(store, chat, outlets, flows, { now: () => Date.parse("2026-11-06"), people: { "@ap-clerk": ["@clerk"], "@controller": ["@controller"] } });
  attestRooms(store, chat);
  if (opts.editMandates) chat.docs.get("finance")!.find((d) => d.name === "payment-mandates")!.content = opts.editMandates;
  const settle = () => chat.deliver((m) => runner.onMessage(m));
  const invoice = async (data: Record<string, unknown>) => {
    const id = await runner.open("invoice-check", data, "webhook");
    await settle();
    return id;
  };
  const card = (id: string) => chat.cards.findLast((c) => c.requestId.startsWith(id))!;
  return { store, chat, runner, outlets, invoice, card, settle };
}
const fabrikam = (number: string) => ({ supplier: "Fabrikam Print", number, amount: 3150, po: "PO-1043" });

describe("payee verification on an invoice", () => {
  it("pays by the rule when the bank confirms the vendor holds the account", async () => {
    const { store, outlets, invoice } = world();
    const id = await invoice(fabrikam("FP-8101"));
    expect(store.load(id).results.payee).toMatchObject({ ok: true, result: "match" });
    expect(outlets.payments).toHaveLength(1);
  });

  it("holds the invoice, with no pay button, when the bank says someone else holds the account on file", async () => {
    // A vendor row that looks right, and was attested: only the bank knows better.
    const { store, outlets, invoice, card } = world({ master: MASTER.replace("DE29100500000190183746", "DE68370400440532099999") });
    const id = await invoice(fabrikam("FP-8102"));
    expect(store.load(id).results.payee).toMatchObject({ ok: false, result: "no_match" });
    expect(card(id).title).toMatch(/hold Fabrikam Print invoice FP-8102: the bank says DE68…9999 is not held by Fabrikam Print, so nothing is paid on it/);
    expect(card(id).options).not.toContain("pay");
    expect(outlets.payments).toHaveLength(0);
  });

  it("sends a close match to a person, with the name the bank holds", async () => {
    const { store, outlets, invoice, card } = world({ master: MASTER.replace("DE29100500000190183746", "DE88500700100175526303") });
    const id = await invoice(fabrikam("FP-8103"));
    expect(store.load(id).results.payee).toMatchObject({ ok: false, result: "close_match", holder: "Fabrikam Print Services s.r.o." });
    expect(card(id).title).toMatch(/^.*pay Fabrikam Print invoice FP-8103/);
    expect(card(id).detail).toContain("the bank holds DE88…6303 under a similar but different name: Fabrikam Print Services s.r.o., not Fabrikam Print");
    expect(outlets.payments).toHaveLength(0);
  });

  it("never pays by the rule when the bank cannot say who holds the account", async () => {
    const { store, outlets, invoice } = world({ payees: { DE29100500000190183746: "" } });
    outlets.payees = {};
    const id = await invoice(fabrikam("FP-8104"));
    expect(store.load(id).results.payee).toMatchObject({ ok: false, result: "unavailable" });
    expect(store.load(id).pending?.kind).toBe("gate");
    expect(outlets.payments).toHaveLength(0);
  });

  it("pays a factoring company only under an attested mandate row", async () => {
    const master = MASTER.replace("DE29100500000190183746", FACTOR);
    const payees = { [FACTOR]: "Northbridge Factoring GmbH" };
    const mandate = `${MANDATES.trimEnd()}\n| Fabrikam Print | Northbridge Factoring | 2026-01-15 |\n`;

    const withMandate = world({ master, payees, mandates: mandate });
    const paid = await withMandate.invoice(fabrikam("FP-8105"));
    expect(withMandate.store.load(paid).results.payee).toMatchObject({ ok: true, result: "mandate", holder: "Northbridge Factoring" });
    expect(withMandate.outlets.payments).toHaveLength(1);

    const without = world({ master, payees });
    const held = await without.invoice(fabrikam("FP-8106"));
    expect(without.store.load(held).results.payee).toMatchObject({ result: "no_match" });
    expect(without.outlets.payments).toHaveLength(0);

    // A mandate row typed into the room by hand, after start, authorizes nothing.
    const byHand = world({ master, payees, editMandates: mandate });
    const typed = await byHand.invoice(fabrikam("FP-8107"));
    expect(byHand.store.load(typed).results.payee).toMatchObject({ ok: false, attested: false });
    expect(byHand.card(typed).options).not.toContain("pay");
    expect(byHand.outlets.payments).toHaveLength(0);
  });
});

describe("payee verification on a bank change", () => {
  const email = async (w: ReturnType<typeof world>, from: string, iban: string) => {
    const id = await w.runner.open("bank-change", { from, subject: "new bank", body: `Please pay us at ${iban} from now on.` }, `email from ${from}`);
    await w.settle();
    return id;
  };

  it("fails a request from the vendor's own domain when the bank says the account is someone else's, and the block is evidence", async () => {
    const w = world();
    const id = await email(w, "accounts@fabrikam.test", "DE68 3704 0044 0532 0999 99");
    expect(w.store.load(id).results.checks).toMatchObject({ ok: true });
    expect(w.store.load(id).results.payee).toMatchObject({ result: "no_match" });
    expect(w.card(id).title).toMatch(/block this bank-detail change request .*the bank says DE68…9999 is not held by Fabrikam Print/);
    await w.runner.onApproval({ requestId: w.card(id).requestId, answer: "block", answeredBy: "mx:@controller" });
    await w.settle();
    expect(w.store.events(id).find((e) => e.type === "flagged")).toMatchObject({ iban: "DE68370400440532099999" });
  });

  it("shows the bank's answer on the callback card", async () => {
    const w = world();
    const id = await email(w, "accounts@fabrikam.test", "DE88 5007 0010 0175 5263 03");
    expect(w.card(id).title).toMatch(/it must be DE88500700100175526303 \(the bank holds DE88…6303 under a similar but different name: Fabrikam Print Services s\.r\.o\., not Fabrikam Print\)$/);
  });
});
