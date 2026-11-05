import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Commands } from "../src/engine/commands.ts";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { basisHash, CHECKS, docHash, tableRows } from "../src/engine/verifiers.ts";
import { seedDocuments } from "../src/switch/seed-docs.ts";
import { FakeSwitch, RecordingOutlets, replyWith, attestRooms } from "./fake-switch.ts";

// The finance room's vendor master, as its template seeds it.
const VENDOR_MASTER = (parseYaml(readFileSync("templates/invoice-check.template.yaml", "utf8")).room.docs as { name: string; content: string }[])
  .find((d) => d.name === "vendor-master")!.content;

const POS = `| PO | supplier | amount | status |
|---|---|---|---|
| PO-1041 | Northwind Paper | 1,240.00 | open |
| PO-1043 | Fabrikam Print | 3,150.00 | open |
| PO-1050 | Tailspin Travel | 900.00 | closed |`;
const docs = [{ id: "1", name: "purchase-orders", content: POS }];
const lookup = (args: Record<string, unknown>) => CHECKS.po_lookup.run({ doc: "purchase-orders", ...args }, docs);

describe("checks done by code", () => {
  it("reads markdown tables without their header and separator", () => {
    expect(tableRows(POS)).toEqual([
      ["PO-1041", "Northwind Paper", "1,240.00", "open"],
      ["PO-1043", "Fabrikam Print", "3,150.00", "open"],
      ["PO-1050", "Tailspin Travel", "900.00", "closed"],
    ]);
  });

  it("passes an invoice that matches an open PO exactly", () => {
    expect(lookup({ po: "PO-1041", supplier: "Northwind Paper", amount: 1240 })).toMatchObject({ ok: true, po_amount: 1240 });
  });

  it.each([
    [{ po: "PO-1043", supplier: "Fabrikam Print", amount: 3980 }, /PO-1043 is for 3,150.00, the invoice is 3,980.00/],
    [{ po: "PO-1043", supplier: "Fabrikam Print", amount: 3150.01 }, /is for 3,150.00/],
    [{ po: "PO-9999", supplier: "Anyone", amount: 1 }, /PO-9999 is not in purchase-orders/],
    [{ po: "PO-1041", supplier: "Evil Corp", amount: 1240 }, /supplier is Northwind Paper/],
    [{ po: "PO-1050", supplier: "Tailspin Travel", amount: 900 }, /PO-1050 is closed/],
  ])("refuses %o", (args, why) => {
    const result = lookup(args);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(why);
  });

  it("checks a quote's arithmetic line by line", () => {
    const lines = [
      { item: "Workshop", qty: 1, unit: 1200, amount: 1200 },
      { item: "Design", qty: 4, unit: 650, amount: 2600 },
    ];
    expect(CHECKS.sum_lines.run({ lines, total: 3800 }, [])).toMatchObject({ ok: true });
    expect(CHECKS.sum_lines.run({ lines, total: 3900 }, []).detail).toMatch(/add up to 3,800.00, not 3,900.00/);
    expect(CHECKS.sum_lines.run({ lines: [{ qty: 4, unit: 650, amount: 2500 }], total: 2500 }, []).detail).toMatch(/qty × unit ≠ amount/);
  });
});

describe("invoices: the models check, code decides", () => {
  const flow = loadFlow(readFileSync("flows/invoice-check.flow.yaml", "utf8"));
  const run = async (invoice: Record<string, unknown>, verdict: Record<string, unknown>, withDocs = true) => {
    const store = new Store();
    const chat = new FakeSwitch().agent("@checker", replyWith(verdict)).agent("@checker-backup", replyWith(verdict));
    if (withDocs) chat.doc("finance", "purchase-orders", POS).doc("finance", "vendor-master", VENDOR_MASTER);
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [flow], { vendors: { "@checker": "anthropic", "@checker-backup": "google" } });
    attestRooms(store, chat);
    const id = await runner.open("invoice-check", invoice, "webhook");
    await chat.deliver((m) => runner.onMessage(m));
    return { store, chat, outlets, id };
  };
  const match = { result: "match", po_amount: 3980, reasons: ["looks right"] };

  it("does not pay when both models agree but the purchase order disagrees", async () => {
    const { store, chat, outlets, id } = await run({ supplier: "Fabrikam Print", number: "FP-1", amount: 3980, po: "PO-1043" }, match);

    expect(store.load(id).results.match).toMatchObject({ agreed: true });
    expect(store.load(id).results.po_check).toMatchObject({ ok: false });
    expect(outlets.executed).toHaveLength(0);
    expect(chat.cards).toHaveLength(1);
  });

  it("shows the approver the evidence and the deadline on the card", async () => {
    const { chat } = await run({ supplier: "Fabrikam Print", number: "FP-1", amount: 3980, po: "PO-1043" }, match);
    const detail = chat.cards[0].detail;

    expect(detail).toContain("✗ checked by code (po_lookup): PO-1043 is for 3,150.00, the invoice is 3,980.00");
    expect(detail).toContain("✓ @checker (anthropic) and @checker-backup (google) agreed on match");
    expect(detail).toMatch(/Decide by \d{4}-\d\d-\d\d \d\d:\d\d UTC; after that @cfo can decide/);
  });

  it("pays by the rule only when the models agree and the code check passes", async () => {
    const { outlets } = await run({ supplier: "Northwind Paper", number: "NW-1", amount: 1240, po: "PO-1041" }, { ...match, po_amount: 1240 });
    expect(outlets.payments).toHaveLength(1);
  });

  it("sends the case to the controller when the room has no purchase orders", async () => {
    const { store, outlets, id } = await run({ supplier: "Northwind Paper", number: "NW-1", amount: 1240, po: "PO-1041" }, { ...match, po_amount: 1240 }, false);
    expect(store.load(id).results.po_check).toMatchObject({ ok: false, detail: 'no document "purchase-orders" in this room' });
    expect(store.load(id).pending?.kind).toBe("gate");
    expect(outlets.executed).toHaveLength(0);
  });

  it("stops for a person when Switch cannot be read at all", async () => {
    const store = new Store();
    const chat = new FakeSwitch().agent("@checker", replyWith({ ...match, po_amount: 1240 })).agent("@checker-backup", replyWith({ ...match, po_amount: 1240 }));
    chat.documents = async () => {
      throw new Error("connection refused");
    };
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [flow]);
    attestRooms(store, chat);
    const id = await runner.open("invoice-check", { supplier: "Northwind Paper", number: "NW-1", amount: 1240, po: "PO-1041" }, "webhook");
    await chat.deliver((m) => runner.onMessage(m));

    expect(store.load(id).status).toBe("failed");
    expect(chat.said("could not read the room's documents (connection refused)")).toBe(true);
    expect(outlets.executed).toHaveLength(0);
  });

  it("records which version of the rules each check used", async () => {
    const { store, id } = await run({ supplier: "Northwind Paper", number: "NW-1", amount: 1240, po: "PO-1041" }, { ...match, po_amount: 1240 });
    const events = store.events(id);
    // A check watches the row it relied on; an agent is told the whole document's version.
    expect(events.find((e) => e.type === "verified")).toMatchObject({ docs: { "purchase-orders": basisHash(POS, "PO-1041") }, rows: { "purchase-orders": "PO-1041" } });
    expect(events.find((e) => e.type === "asked")).toMatchObject({ docs: { "purchase-orders": docHash(POS) } });
  });
});

describe("rules live in the room", () => {
  const flow = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));
  const setup = () => {
    const store = new Store();
    const chat = new FakeSwitch().doc("ops-requests", "expense-policy", "Meals: up to 60 per person per day.");
    const runner = new Runner(store, chat, new RecordingOutlets(), [flow]);
    attestRooms(store, chat);
    const commands = new Commands(runner, store, chat, [flow], { "@manager": ["@priya"] });
    const say = (body: string, sender = "@priya") => commands.handle({ room: "ops-requests", messageId: "u1", sender, body, fromPerson: true });
    return { chat, say };
  };

  it("lets an approver change a rule, and says what changed", async () => {
    const { chat, say } = await setup();
    await say('@yard edit expense-policy "60 per person" "100 per person"');

    expect((await chat.documents("ops-requests"))[0].content).toBe("Meals: up to 100 per person per day.");
    expect(chat.posts.at(-1)!.body).toMatch(/@priya \(@manager\) changed `expense-policy`: "60 per person" → "100 per person". Version `\w+` → `\w+`/);
  });

  it("refuses someone who fills no approver role", async () => {
    const { chat, say } = await setup();
    await say('@yard edit expense-policy "60" "6000"', "@intern");
    expect((await chat.documents("ops-requests"))[0].content).toContain("60 per person");
    expect(chat.posts.at(-1)!.body).toMatch(/cannot change this room's rules/);
  });

  it("refuses an edit that is ambiguous or matches nothing", async () => {
    const { chat, say } = await setup();
    await say('@yard edit expense-policy "e" "x"');
    expect(chat.posts.at(-1)!.body).toMatch(/appears \d+ times/);
    await say('@yard edit expense-policy "nothing like this" "x"');
    expect(chat.posts.at(-1)!.body).toMatch(/appears 0 times/);
  });

  it("lists the room's documents with their versions", async () => {
    const { chat, say } = await setup();
    await say("@yard docs");
    expect(chat.posts.at(-1)!.body).toContain("`expense-policy` (version `");
  });

  it("puts a flow's documents into its room once, and never overwrites edits", async () => {
    const chat = new FakeSwitch();
    expect(await seedDocuments(chat, [flow])).toEqual(["#ops-requests/expense-policy"]);
    await chat.updateDocument("ops-requests", "d-expense-policy", "edited in the room");
    expect(await seedDocuments(chat, [flow])).toEqual([]);
    expect((await chat.documents("ops-requests"))[0].content).toBe("edited in the room");
  });
});
