import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadFlow } from "../src/engine/flow-schema.ts";
import { Runner } from "../src/engine/runner.ts";
import { Store } from "../src/engine/store.ts";
import { docHash } from "../src/engine/verifiers.ts";
import { caseSummaries, flowSummaries } from "../src/web/api.ts";
import { diagram, left } from "../src/web/static/diagram.js";
import { FakeSwitch, RecordingOutlets, replyWith } from "./fake-switch.ts";

// The diagram draws only what the engine recorded; these tests hold it to that.

const flows = readdirSync("flows").map((f) => loadFlow(readFileSync(`flows/${f}`, "utf8")));
const flow = (name: string) => flows.find((f) => f.flow === name)!;
const summary = (name: string) => flowSummaries([flow(name)])[0];
const MIN = 60_000;

// The ring's filled length as a fraction of its circumference.
const ringFraction = (svg: string) => {
  const m = /class="ring"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? Number(m[1]) / Number(m[2]) : undefined;
};

describe("the diagram", () => {
  it("draws every shipped flow as a plan, one station per step", () => {
    for (const f of flowSummaries(flows)) {
      const svg = diagram(f);
      const stations = (svg.match(/<g class="n (?:bench )?k-/g) ?? []).length;
      const lanes = f.steps.filter((s) => s.kind === "parallel").reduce((n, s) => n + (s.agents?.length ?? 0), 0);
      const benches = f.steps.filter((s) => s.kind === "agent" && s.backup).length;
      expect(stations, f.flow).toBe(f.steps.filter((s) => s.kind !== "parallel").length + lanes + benches);
      expect(svg, f.flow).not.toMatch(/undefined|NaN/);
    }
  });

  it("fills the deadline ring on the same clock tick() reminds and escalates by", async () => {
    let clock = 0;
    const store = new Store();
    const chat = new FakeSwitch().agent("@policy", replyWith({ verdict: "needs_review", reasons: [] }));
    const runner = new Runner(store, chat, new RecordingOutlets(), [flow("expense")], { now: () => clock });
    await runner.open("expense", { name: "Asha", email: "a@example.test", category: "travel", reason: "visit", amount: 900 }, "form");
    await chat.deliver((m) => runner.onMessage(m));
    const draw = () => {
      const c = caseSummaries(store, [flow("expense")])[0];
      return { c, svg: diagram(summary("expense"), c, {}, clock) };
    };

    // The card opened at 0 with a 4h deadline: the reminder is due at 2h.
    clock = 120 * MIN - 1;
    expect(draw().c.waiting).toMatchObject({ remindAt: 120 * MIN, deadlineAt: 240 * MIN, escalateTo: "@finance-lead" });
    await runner.tick();
    expect(chat.said("reminder")).toBe(false);

    clock = 120 * MIN;
    expect(ringFraction(draw().svg)).toBeCloseTo(0.5, 3);
    expect(draw().svg).toContain("→ @finance-lead in 2h 0m");
    await runner.tick();
    expect(chat.said("reminder")).toBe(true);

    clock = 240 * MIN;
    expect(ringFraction(draw().svg)).toBe(1);
    await runner.tick();
    expect(draw().svg).toContain("escalated to @finance-lead");
  });

  it("lights the bench siding only after a failover is logged", async () => {
    let clock = 0;
    const store = new Store();
    const chat = new FakeSwitch().agent("@policy", () => "").agent("@policy-backup", replyWith({ verdict: "ok", reasons: [] }));
    chat.inbox.length = 0;
    const runner = new Runner(store, chat, new RecordingOutlets(), [flow("expense")], { now: () => clock });
    await runner.open("expense", { name: "Asha", email: "a@example.test", category: "meals", reason: "lunch", amount: 40 }, "form");
    const draw = () => diagram(summary("expense"), caseSummaries(store, [flow("expense")])[0], {}, clock);

    expect(draw()).not.toContain("siding lit");
    clock = 5 * MIN;
    expect(ringFraction(draw())).toBeCloseTo(0.5, 3);
    expect(draw()).toContain("→ @policy-backup in 5m");

    clock = 10 * MIN;
    await runner.tick();
    await chat.deliver((m) => runner.onMessage(m));
    expect(draw()).toContain("siding lit");
    expect(draw()).toContain("done by @policy-backup");
  });

  it("puts the card's hash on the approval arc, and locks it when the action matched", async () => {
    const POS = "| PO | supplier | amount | status |\n|---|---|---|---|\n| PO-1043 | Fabrikam Print | 3,150.00 | open |";
    const store = new Store();
    const verdict = { result: "mismatch", po_amount: 3150, reasons: ["over the PO"] };
    const chat = new FakeSwitch().agent("@checker", replyWith(verdict)).agent("@checker-backup", replyWith(verdict)).doc("finance", "purchase-orders", POS);
    const outlets = new RecordingOutlets();
    const runner = new Runner(store, chat, outlets, [flow("invoice-check")]);
    await runner.open("invoice-check", { supplier: "Fabrikam Print", number: "FP-1", amount: 3150.5, po: "PO-1043" }, "webhook");
    await chat.deliver((m) => runner.onMessage(m));
    const draw = () => diagram(summary("invoice-check"), caseSummaries(store, [flow("invoice-check")])[0], { "@checker": "anthropic", "@checker-backup": "google" });

    const gate = store.events(caseSummaries(store, [flow("invoice-check")])[0].id).find((e) => e.type === "gate_opened");
    const hash = gate?.type === "gate_opened" ? gate.hashes.schedule_payment : "";
    let svg = draw();
    expect(svg).toContain('class="junction ok"');
    expect(svg).toContain(docHash(POS));
    expect(svg).toContain(`${hash.slice(0, 8)} · on the card`);
    expect(svg).toMatch(/class="vt v-google"/);

    await runner.onApproval({ requestId: chat.cards[0].requestId, answer: "pay", answeredBy: "mx:@controller" });
    svg = draw();
    expect(outlets.executed).toHaveLength(1);
    expect(svg).toContain(`${hash.slice(0, 8)} = executed`);
    expect(svg).toContain('class="bind ok"');
  });

  it("says a step was added later rather than pretending the case skipped it", () => {
    const f = summary("invoice-check");
    const c = {
      status: "done",
      waiting: null,
      stations: [
        { id: "match", status: "done" },
        { id: "po_check", status: "todo" },
        { id: "finance", status: "done" },
        { id: "schedule_payment", status: "skipped" },
      ],
      events: [],
    };
    const svg = diagram(f, c);
    expect(svg).toContain("skipped absent");
    expect(svg).toContain("added after this run");
  });

  it("reads time left the way the clocks do", () => {
    expect(left(90 * MIN, 0)).toBe("1h 30m");
    expect(left(61 * 60 * MIN, 0)).toBe("2d 13h");
    expect(left(0, 5)).toBe("now");
  });
});
