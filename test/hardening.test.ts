import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "../src/engine/commands.ts";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { startServer } from "../src/server.ts";
import { whoAnswered } from "../src/switch/client.ts";
import { FakeSwitch, RecordingOutlets, replyWith } from "./fake-switch.ts";

// Defects found in review: each test failed (or could not be written) before its fix.

const expense = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));
const invoice = loadFlow(readFileSync("flows/invoice-check.flow.yaml", "utf8"));
const asha = { name: "Asha", email: "a@example.test", category: "travel", reason: "visit", amount: 900 };

describe("one thing at a time", () => {
  it("records one decision when the same answer arrives twice at once", async () => {
    const store = new Store();
    const chat = new FakeSwitch().agent("@policy", replyWith({ verdict: "needs_review", reasons: [] }));
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [expense]);
    const id = await runner.open("expense", asha, "form");
    await chat.deliver((m) => runner.onMessage(m));

    const answer = { requestId: chat.cards[0].requestId, answer: "approve", answeredBy: "mx:@manager" };
    await Promise.all([runner.onApproval(answer), runner.onApproval(answer)]);

    expect(store.events(id).filter((e) => e.type === "gate_answered")).toHaveLength(1);
    expect(outlets.executed).toHaveLength(1);
  });
});

describe("a webhook sent twice", () => {
  let server: Server;
  afterEach(() => server?.close());

  it("opens one case and says the second delivery was a duplicate", async () => {
    const store = new Store();
    const verdict = { result: "match", po_amount: 1240, reasons: [] };
    const chat = new FakeSwitch().agent("@checker", replyWith(verdict)).agent("@checker-backup", replyWith(verdict));
    const runner = new Runner(store, chat, new RecordingOutlets(), [invoice]);
    server = startServer({ port: 0, flows: [invoice], runner, store, env: { INVOICE_HOOK_SECRET: "s3cret" } });
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/in/invoice-check`;
    const body = JSON.stringify({ invoice: { supplier: "Northwind Paper", number: "NW-1", total: 1240, po_number: "PO-1041" } });
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Switchyard-Signature": `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}` },
        body,
      });

    const first = await post();
    const second = await post();
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ case: (await first.json()).case, duplicate: true });
    expect(store.caseIds()).toHaveLength(1);
  });
});

describe("who answered a card", () => {
  const people = [
    { id: "1", name: "bob", type: "user" },
    { id: "2", name: "x-bob", type: "user" },
    { id: "3", name: "agent-bob", type: "agent" },
  ];

  it("is the longest username the id ends with, so x-bob is never taken for bob", () => {
    expect(whoAnswered("@switch-slack-b1-x-bob:local", people)?.name).toBe("x-bob");
    expect(whoAnswered("@switch-slack-b1-bob:local", people)?.name).toBe("bob");
    expect(whoAnswered("@switch-slack-b1-bob-0a1b2c3d:local", people)?.name).toBe("bob");
    expect(whoAnswered("@switch-slack-b1-mallory:local", people)).toBeUndefined();
  });
});

describe("commands that change a case", () => {
  const setup = async () => {
    const store = new Store();
    const chat = new FakeSwitch().agent("@policy", replyWith({ verdict: "needs_review", reasons: [] }));
    const runner = new Runner(store, chat, new RecordingOutlets(), [expense]);
    const commands = new Commands(runner, store, chat, [expense], { "@manager": ["@priya"] });
    const id = await runner.open("expense", asha, "form");
    await chat.deliver((m) => runner.onMessage(m));
    const say = (body: string, sender: string, room = "ops-requests") => commands.handle({ room, messageId: "u1", sender, body, fromPerson: true });
    return { store, chat, id, say };
  };

  it("only reach a case from its own room", async () => {
    const { store, id, say } = await setup();
    await say(`@yard cancel ${id}`, "@priya", "sales-ops");
    expect(store.load(id).status).toBe("open");
  });

  it("only come from someone who fills a role in that flow", async () => {
    const { store, chat, id, say } = await setup();
    await say(`@yard cancel ${id}`, "@intern");
    expect(store.load(id).status).toBe("open");
    expect(chat.posts.at(-1)!.body).toMatch(/@intern cannot change case/);

    await say(`@yard cancel ${id}`, "@priya");
    expect(store.load(id).status).toBe("cancelled");
  });
});
