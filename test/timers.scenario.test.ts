import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { FakeSwitch, RecordingOutlets, replyWith } from "./fake-switch.ts";

const expense = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));
const request = { name: "Asha", email: "asha@example.test", category: "travel", reason: "visit", amount: 900 };
const MIN = 60_000;

describe("deadlines, escalation and failover", () => {
  let clock: number, store: Store, chat: FakeSwitch, outlets: RecordingOutlets, runner: Runner;

  beforeEach(() => {
    clock = 0;
    store = new Store();
    chat = new FakeSwitch().agent("@policy", replyWith({ verdict: "ok", reasons: [] }));
    outlets = new RecordingOutlets();
    runner = new Runner(store, chat, outlets, [expense], { now: () => clock });
  });

  const deliver = () => chat.deliver((m) => runner.onMessage(m));
  const answer = (requestId: string, who: string, choice = "approve") =>
    runner.onApproval({ requestId, answer: choice, answeredBy: `mx:${who}` });

  it("reminds once at half the deadline, then escalates to the backup", async () => {
    await runner.open("expense", request, "form");
    await deliver();

    clock = 119 * MIN;
    await runner.tick();
    expect(chat.said("reminder")).toBe(false);

    clock = 120 * MIN;
    await runner.tick();
    await runner.tick();
    expect(chat.posts.filter((p) => p.body.includes("@manager reminder"))).toHaveLength(1);

    clock = 240 * MIN;
    await runner.tick();
    expect(chat.cards).toHaveLength(2);
    expect(chat.cards[1].title).toMatch(/^@finance-lead/);
    expect(chat.cards[1].detail).toContain("Append to ledger.csv");
  });

  it("does not let the backup decide before escalation", async () => {
    await runner.open("expense", request, "form");
    await deliver();
    await answer(chat.cards[0].requestId, "@finance-lead");
    expect(outlets.executed).toHaveLength(0);
  });

  it("lets the backup decide on the escalated card, and the approver on either", async () => {
    await runner.open("expense", request, "form");
    await deliver();
    clock = 240 * MIN;
    await runner.tick();

    await answer(chat.cards[1].requestId, "@finance-lead");
    expect(outlets.executed).toHaveLength(1);
    expect(chat.said("approved by @finance-lead")).toBe(true);
  });

  it("keeps the approver able to answer after escalation", async () => {
    await runner.open("expense", request, "form");
    await deliver();
    clock = 240 * MIN;
    await runner.tick();
    await answer(chat.cards[0].requestId, "@manager");
    expect(outlets.executed).toHaveLength(1);
  });

  it("does not repeat a reminder or escalation after a restart", async () => {
    await runner.open("expense", request, "form");
    await deliver();
    clock = 240 * MIN;
    await runner.tick();
    const cards = chat.cards.length;

    const restarted = new Runner(store, chat, outlets, [expense], { now: () => clock });
    await restarted.tick();
    expect(chat.cards).toHaveLength(cards);
    expect(chat.posts.filter((p) => p.body.includes("reminder"))).toHaveLength(1);
  });

  it("moves a silent agent to its bench after the SLA", async () => {
    chat.agent("@policy", () => "");
    chat.inbox.length = 0;
    const silent = new FakeSwitch().agent("@policy-backup", replyWith({ verdict: "ok", reasons: [] }));
    runner = new Runner(store, silent, outlets, [expense], { now: () => clock });
    const id = await runner.open("expense", { ...request, amount: 100 }, "form");

    clock = 10 * MIN;
    await runner.tick();
    await silent.deliver((m) => runner.onMessage(m));

    expect(silent.said("handing it to @policy-backup")).toBe(true);
    expect(outlets.executed).toHaveLength(1);
    expect(store.load(id).status).toBe("done");
  });

  it("moves to the bench at once when the provider reports a limit", async () => {
    chat.agent("@policy", () => "Error: usage limit reached, try again later.");
    chat.agent("@policy-backup", replyWith({ verdict: "ok", reasons: [] }));
    const id = await runner.open("expense", { ...request, amount: 100 }, "form");
    await deliver();

    const asked = store.events(id).filter((e) => e.type === "asked");
    expect(asked.map((e) => e.type === "asked" && e.agent)).toEqual(["@policy", "@policy-backup"]);
    expect(store.load(id).status).toBe("done");
  });

  it("gives up to a person when the bench fails too", async () => {
    chat.agent("@policy", () => "429 rate limited");
    chat.agent("@policy-backup", () => "503 overloaded");
    const id = await runner.open("expense", { ...request, amount: 100 }, "form");
    await deliver();
    expect(store.load(id).status).toBe("failed");
    expect(chat.said("A person needs to take this case")).toBe(true);
  });
});

describe("people filling roles", () => {
  it("lets the mapped person approve as @manager and mentions them", async () => {
    const store = new Store();
    const chat = new FakeSwitch().agent("@policy", replyWith({ verdict: "ok", reasons: [] }));
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [expense], { people: { "@manager": ["@atharv"] } });
    await runner.open("expense", request, "form");
    await chat.deliver((m) => runner.onMessage(m));

    expect(chat.cards[0].title).toBe("@atharv approve Asha's expense?");
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "approve", answeredBy: "mx:@atharv" });
    expect(outlets.executed).toHaveLength(1);
  });
});

describe("bench agents get their own tries", () => {
  it("retries the bench once, then hands the case to a person", async () => {
    const store = new Store();
    const chat = new FakeSwitch()
      .agent("@policy", () => "Looks fine!")
      .agent("@policy-backup", () => "Also fine!");
    const runner = new Runner(store, chat, new RecordingOutlets(), [expense]);
    const id = await runner.open("expense", { ...request, amount: 100 }, "form");
    await chat.deliver((m) => runner.onMessage(m));

    const asked = store.events(id).filter((e) => e.type === "asked");
    expect(asked.map((e) => e.type === "asked" && `${e.agent}#${e.tries}`)).toEqual([
      "@policy#1", "@policy#2", "@policy-backup#1", "@policy-backup#2",
    ]);
    expect(store.load(id).status).toBe("failed");
  });
});

describe("wait steps", () => {
  const followUp = loadFlow(`
flow: quote
room: sales
steps:
  - id: owner
    gate: { approver: "@owner", title: send?, options: [send, hold], approves: [send_quote, follow_up] }
  - id: send_quote
    when: owner == "send"
    outlet: { email: { to: "{case.from}", subject: Quote, body: "Here it is." } }
  - id: three_days
    when: owner == "send"
    wait: 3d
  - id: follow_up
    when: owner == "send"
    outlet: { email: { to: "{case.from}", subject: Following up, body: "Did you get it?" } }
`);

  it("sends the follow-up after the wait, under the same approval", async () => {
    let clock = 0;
    const store = new Store();
    const chat = new FakeSwitch();
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [followUp], { now: () => clock });
    const id = await runner.open("quote", { from: "dana@globex.test" }, "email");
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "send", answeredBy: "mx:@owner" });
    expect(outlets.executed.map((e) => e.key)).toEqual([`${id}/send_quote`]);

    clock = 3 * 86_400_000 - 1;
    await runner.tick();
    expect(outlets.executed).toHaveLength(1);

    clock = 3 * 86_400_000;
    await runner.tick();
    expect(outlets.executed.map((e) => e.key)).toEqual([`${id}/send_quote`, `${id}/follow_up`]);
    expect(store.load(id).status).toBe("done");
  });

  it("lets a person end the wait early, and survives a restart while waiting", async () => {
    const store = new Store();
    const chat = new FakeSwitch();
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [followUp], { now: () => 0 });
    const id = await runner.open("quote", { from: "dana@globex.test" }, "email");
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "send", answeredBy: "mx:@owner" });
    expect(store.load(id).pending?.kind).toBe("wait");

    const restarted = new Runner(store, chat, outlets, [followUp], { now: () => 0 });
    expect(await restarted.resume(id, "@atharv")).toBeUndefined();
    expect(outlets.executed).toHaveLength(2);
    expect(chat.said("@atharv ended the wait early")).toBe(true);
    expect(await restarted.resume(id, "@atharv")).toMatch(/not waiting/);
  });
});
