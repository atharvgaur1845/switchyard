import { describe, expect, it } from "vitest";
import { loadFlow, type Outlet } from "../src/engine/flow-schema.ts";
import type { Outlets } from "../src/engine/ports.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { hashOutlet } from "../src/outlets/payload.ts";
import { FakeSwitch } from "./fake-switch.ts";

// An outlet that does its work and then never returns: the process is
// killed before Switchyard can record the result (a power cut, kill -9).
class CrashingOutlets implements Outlets {
  readonly sent: { outlet: Outlet; key: string }[] = [];
  crashNext = false;
  failNext = false;

  async execute(outlet: Outlet, key: string): Promise<string> {
    this.sent.push({ outlet, key });
    if (this.crashNext) {
      this.crashNext = false;
      return new Promise<string>(() => {});
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error("SMTP timed out after the server accepted the message");
    }
    return `did ${key}`;
  }
}

const flow = (outlet: string) =>
  loadFlow(`
flow: send
room: r
steps:
  - id: ok
    gate: { approver: "@owner", title: send it?, options: [send, hold], approves: [out] }
  - id: out
    when: ok == "send"
    outlet: ${outlet}
`);

const email = flow(`{ email: { to: "{case.to}", subject: Quote, body: "Here it is." } }`);
const ledger = flow(`{ csv: { file: ledger.csv, row: ["{case.to}"] } }`);

async function crashMidSend(f: ReturnType<typeof flow>) {
  const store = new Store();
  const chat = new FakeSwitch();
  const outlets = new CrashingOutlets();
  const first = new Runner(store, chat, outlets, [f]);
  const id = await first.open("send", { to: "dana@globex.test" }, "test");
  outlets.crashNext = true;
  void first.onApproval({ requestId: chat.cards[0].requestId, answer: "send", answeredBy: "mx:@owner" });
  await new Promise((r) => setTimeout(r, 5));

  // A fresh process on the same event log.
  const second = new Runner(store, chat, outlets, [f]);
  await second.resumeAll();
  return { store, chat, outlets, runner: second, id };
}

describe("an action interrupted by a crash", () => {
  it("is not sent again on restart: a person is asked whether it went out", async () => {
    const { store, chat, outlets, id } = await crashMidSend(email);

    expect(outlets.sent).toHaveLength(1);
    expect(store.load(id).pending).toMatchObject({ kind: "in_doubt", step: "out" });
    expect(chat.cards.at(-1)!.options).toEqual(["it went out", "send it again"]);
    expect(chat.cards.at(-1)!.detail).toContain("Email dana@globex.test");
  });

  it("is recorded, not repeated, when the approver says it went out", async () => {
    const { store, chat, outlets, runner, id } = await crashMidSend(email);
    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "it went out", answeredBy: "mx:@owner" });

    expect(outlets.sent).toHaveLength(1);
    const state = store.load(id);
    expect(state.status).toBe("done");
    expect(state.results.out).toMatchObject({ receipt: "confirmed sent by @owner" });
  });

  it("is sent exactly once more when the approver asks for it", async () => {
    const { store, chat, outlets, runner, id } = await crashMidSend(email);
    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "send it again", answeredBy: "mx:@owner" });

    expect(outlets.sent).toHaveLength(2);
    expect(outlets.sent[1].outlet).toEqual(outlets.sent[0].outlet);
    expect(store.load(id).status).toBe("done");
  });

  it("can only be decided by the approver, and re-asks after a wrong answer", async () => {
    const { store, chat, outlets, runner, id } = await crashMidSend(email);
    const cards = chat.cards.length;
    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "send it again", answeredBy: "mx:@intern" });

    expect(outlets.sent).toHaveLength(1);
    expect(store.load(id).pending?.kind).toBe("in_doubt");
    expect(chat.cards).toHaveLength(cards + 1);
    expect(chat.cards.at(-1)!.detail).toContain("only @owner can decide");

    await runner.onApproval({ requestId: chat.cards.at(-1)!.requestId, answer: "it went out", answeredBy: "mx:@owner" });
    expect(store.load(id).status).toBe("done");
  });

  it("asks a person, rather than retrying, when a send fails", async () => {
    const store = new Store();
    const chat = new FakeSwitch();
    const outlets = new CrashingOutlets();
    const runner = new Runner(store, chat, outlets, [email]);
    const id = await runner.open("send", { to: "dana@globex.test" }, "test");
    outlets.failNext = true;
    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "send", answeredBy: "mx:@owner" });

    expect(store.load(id).pending?.kind).toBe("in_doubt");
    expect(chat.said("SMTP timed out")).toBe(true);
    expect(outlets.sent).toHaveLength(1);
  });

  it("does not run an action twice when a second event arrives mid-send", async () => {
    const store = new Store();
    const chat = new FakeSwitch();
    const outlets = new CrashingOutlets();
    const runner = new Runner(store, chat, outlets, [email]);
    const id = await runner.open("send", { to: "dana@globex.test" }, "test");
    outlets.crashNext = true; // the send hangs
    void runner.onApproval({ requestId: chat.cards[0].requestId, answer: "send", answeredBy: "mx:@owner" });
    await new Promise((r) => setTimeout(r, 5));
    await runner.advance(id);
    await runner.resumeAll();
    expect(outlets.sent).toHaveLength(1);
  });

  it("is finished on restart when repeating it is harmless (a keyed ledger row)", async () => {
    const { store, chat, outlets, id } = await crashMidSend(ledger);

    expect(outlets.sent.map((s) => s.key)).toEqual([`${id}/out`, `${id}/out`]);
    expect(store.load(id).status).toBe("done");
    expect(chat.cards).toHaveLength(1);
  });

  it("never loses an action: every approved case ends executed or with a person", async () => {
    for (const f of [email, ledger]) {
      const { store, id } = await crashMidSend(f);
      const state = store.load(id);
      expect(state.status === "done" || state.pending?.kind === "in_doubt").toBe(true);
    }
  });
});

describe("what the approval card showed", () => {
  it("is stored, and hashes to the approved hash", async () => {
    const store = new Store();
    const chat = new FakeSwitch();
    const runner = new Runner(store, chat, new CrashingOutlets(), [email]);
    const id = await runner.open("send", { to: "dana@globex.test" }, "test");

    const opened = store.events(id).find((e) => e.type === "gate_opened");
    expect(opened?.type === "gate_opened" && opened.payloads?.out).toEqual({
      email: { to: "dana@globex.test", subject: "Quote", body: "Here it is." },
    });
    expect(opened?.type === "gate_opened" && hashOutlet(opened.payloads!.out as Outlet)).toBe(
      opened?.type === "gate_opened" && opened.hashes.out,
    );
  });
});
