import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { FakeSwitch, RecordingOutlets, replyWith } from "./fake-switch.ts";

const invoices = loadFlow(readFileSync("flows/invoice-check.flow.yaml", "utf8"));
const invoice = { supplier: "Northwind Paper", number: "NW-1", amount: 1240, po: "PO-1041" };
const match = { result: "match", po_amount: 1240, reasons: ["ok"] };

describe("parallel checkers", () => {
  let store: Store, chat: FakeSwitch, outlets: RecordingOutlets, runner: Runner;
  beforeEach(() => {
    store = new Store();
    chat = new FakeSwitch();
    outlets = new RecordingOutlets();
    runner = new Runner(store, chat, outlets, [invoices]);
  });
  const deliver = () => chat.deliver((m) => runner.onMessage(m));

  it("pays automatically when both checkers agree it matches", async () => {
    chat.agent("@checker", replyWith(match)).agent("@checker-backup", replyWith(match));
    const id = await runner.open("invoice-check", invoice, "webhook");
    await deliver();

    expect(store.load(id).results.match).toMatchObject({ agreed: true, checker: { result: "match" } });
    expect(chat.cards).toHaveLength(0);
    expect(outlets.executed).toHaveLength(1);
  });

  it("sends a disagreement to the controller instead of paying", async () => {
    chat
      .agent("@checker", replyWith(match))
      .agent("@checker-backup", replyWith({ result: "mismatch", po_amount: 1000, reasons: ["amount differs"] }));
    const id = await runner.open("invoice-check", invoice, "webhook");
    await deliver();

    expect(store.load(id).results.match).toMatchObject({ agreed: false });
    expect(chat.cards).toHaveLength(1);
    expect(outlets.executed).toHaveLength(0);
  });

  it("waits for every checker, and re-asks only the one whose reply was malformed", async () => {
    let tries = 0;
    chat
      .agent("@checker", replyWith(match))
      .agent("@checker-backup", (request) => (++tries === 1 ? "match, I think" : replyWith(match)(request)));
    const id = await runner.open("invoice-check", invoice, "webhook");
    await deliver();

    const asked = store.events(id).filter((e) => e.type === "asked").map((e) => e.type === "asked" && e.agent);
    expect(asked).toEqual(["@checker", "@checker-backup", "@checker-backup"]);
    expect(outlets.executed).toHaveLength(1);
  });

  it("hands the case to a person when a checker misses the SLA", async () => {
    let clock = 0;
    chat.agent("@checker", replyWith(match));
    runner = new Runner(store, chat, outlets, [invoices], { now: () => clock });
    const id = await runner.open("invoice-check", invoice, "webhook");
    await deliver();
    expect(store.load(id).pending?.kind).toBe("parallel");

    clock = 10 * 60_000;
    await runner.tick();
    expect(store.load(id).status).toBe("failed");
    expect(chat.said("no answer from @checker-backup within 10m")).toBe(true);
  });
});
