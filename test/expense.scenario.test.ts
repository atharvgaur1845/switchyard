import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { FakeSwitch, RecordingOutlets, replyWith } from "./fake-switch.ts";

const expense = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));
const request = { name: "Asha", email: "asha@example.test", category: "travel", reason: "client visit" };

describe("expense flow against a fake Switch", () => {
  let store: Store, chat: FakeSwitch, outlets: RecordingOutlets, runner: Runner;

  beforeEach(() => {
    store = new Store();
    chat = new FakeSwitch().agent("@policy", replyWith({ verdict: "ok", reasons: ["within policy"] }));
    outlets = new RecordingOutlets();
    runner = new Runner(store, chat, outlets, [expense]);
  });

  const deliver = () => chat.deliver((m) => runner.onMessage(m));

  it("records a small, compliant expense by rule, with no card", async () => {
    const id = await runner.open("expense", { ...request, amount: 120 }, "web form");
    await deliver();

    expect(chat.cards).toHaveLength(0);
    expect(outlets.executed).toEqual([
      { key: `${id}/record`, outlet: { csv: { file: "ledger.csv", row: ["Asha", "120", "travel"] } } },
    ]);
    expect(chat.said('approved by rule "case.amount <= 500')).toBe(true);
    expect(store.load(id).status).toBe("done");
  });

  it("holds a large expense for the manager and records exactly what was approved", async () => {
    const id = await runner.open("expense", { ...request, amount: 800 }, "web form");
    await deliver();

    expect(chat.cards).toHaveLength(1);
    expect(chat.cards[0].detail).toContain("Append to ledger.csv: Asha | 800 | travel");
    expect(outlets.executed).toHaveLength(0);

    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "approve", answeredBy: "mx:@manager" });
    expect(outlets.executed).toHaveLength(1);
    expect(chat.said("approved by @manager")).toBe(true);
    expect(store.load(id).status).toBe("done");
  });

  it("records nothing when the manager rejects", async () => {
    const id = await runner.open("expense", { ...request, amount: 800 }, "web form");
    await deliver();
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "reject", answeredBy: "mx:@manager" });

    expect(outlets.executed).toHaveLength(0);
    expect(store.load(id).status).toBe("done");
  });

  it("ignores an answer from someone who is not the approver", async () => {
    const id = await runner.open("expense", { ...request, amount: 800 }, "web form");
    await deliver();
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "approve", answeredBy: "mx:@intern" });

    expect(outlets.executed).toHaveLength(0);
    expect(chat.cards).toHaveLength(2);
    expect(store.load(id).pending?.kind).toBe("gate");
  });

  it("ignores an answer it cannot attribute to anyone", async () => {
    await runner.open("expense", { ...request, amount: 800 }, "web form");
    await deliver();
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "approve", answeredBy: "???" });
    expect(outlets.executed).toHaveLength(0);
  });

  it("refuses to act when the action changed after approval", async () => {
    // The gate approves the email before the agent has written its body, so
    // the email that would go out is not the one the person saw.
    const drifting = loadFlow(`
flow: drift
room: r
steps:
  - id: ok
    gate: { approver: "@manager", title: send it?, options: [send, stop], approves: [mail] }
  - id: draft
    agent: "@writer"
    ask: Write the reply.
    expect: { text: str }
  - id: mail
    outlet: { email: { to: "{case.email}", subject: Re, body: "{draft.text}" } }
`);
    chat.agent("@writer", replyWith({ text: "We will refund you in full." }));
    runner = new Runner(store, chat, outlets, [drifting]);
    const id = await runner.open("drift", request, "test");
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "send", answeredBy: "mx:@manager" });
    await deliver();

    expect(outlets.executed).toHaveLength(0);
    expect(store.load(id).status).toBe("failed");
    expect(chat.said("the action changed after it was approved")).toBe(true);
  });

  it("re-asks a malformed reply once, then moves the step to the bench agent", async () => {
    chat.agent("@policy", () => "Looks fine to me!");
    const id = await runner.open("expense", { ...request, amount: 800 }, "web form");
    await deliver();

    const asks = store.events(id).filter((e) => e.type === "asked");
    expect(asks.map((e) => e.type === "asked" && [e.agent, e.attempt])).toEqual([
      ["@policy", 1], ["@policy", 2], ["@policy-backup", 3],
    ]);
    expect(store.load(id).pending).toMatchObject({ agent: "@policy-backup" });
    expect(chat.said("did not match the step's contract")).toBe(true);
  });

  it("ignores replies from other senders and other threads", async () => {
    const id = await runner.open("expense", { ...request, amount: 800 }, "web form");
    const threadId = store.load(id).threadId!;
    await runner.onMessage({ room: "ops-requests", messageId: "x", threadId, sender: "@someone", body: "{}", fromPerson: true });
    await runner.onMessage({ room: "ops-requests", messageId: "y", threadId: "other", sender: "@policy", body: "{}", fromPerson: false });
    expect(store.load(id).pending?.kind).toBe("agent");
  });

  it("resumes after a restart from the event log alone", async () => {
    const id = await runner.open("expense", { ...request, amount: 800 }, "web form");
    await deliver();
    const requestId = chat.cards[0].requestId;

    const restarted = new Runner(store, chat, outlets, [expense]);
    await restarted.onApproval({ requestId, answer: "approve", answeredBy: "mx:@manager" });
    expect(outlets.executed).toHaveLength(1);
    expect(store.load(id).status).toBe("done");
  });

  it("fills placeholders in what it asks an agent", async () => {
    const flow = loadFlow(`
flow: hello
room: r
steps:
  - id: greet
    agent: "@policy"
    ask: Write to {case.name} about {case.category}.
    expect: { text: str }
`);
    let seen = "";
    chat.agent("@policy", (body) => ((seen = body), ""));
    await new Runner(store, chat, outlets, [flow]).open("hello", { name: "Asha", category: "travel" }, "test");
    expect(seen).toContain("Write to Asha about travel.");
  });
});
