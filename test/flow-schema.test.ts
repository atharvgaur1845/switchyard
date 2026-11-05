import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FlowError, loadFlow } from "../src/engine/flow-schema.ts";

const flow = (steps: string) => `flow: demo\nroom: r\nsteps:\n${steps}`;

describe("flow loading and lint", () => {
  it("loads the expense starter flow", () => {
    const loaded = loadFlow(readFileSync("flows/expense.flow.yaml", "utf8"));
    expect(loaded.steps.map((s) => s.id)).toEqual(["check", "manager", "record"]);
  });

  it("rejects an outlet that nobody approves", () => {
    const source = flow(`  - id: send\n    outlet: { post: { room: r, body: hi } }\n`);
    expect(() => loadFlow(source)).toThrow(/acts outside Switch with no approval/);
  });

  it("rejects a gate placed after the outlet it approves", () => {
    const source = flow(
      `  - id: send\n    outlet: { post: { room: r, body: hi } }\n    auto_approve: true\n` +
        `  - id: ok\n    gate: { approver: "@boss", title: t, options: [yes, no], approves: [send] }\n`,
    );
    expect(() => loadFlow(source)).toThrow(/must come before the outlet/);
  });

  it("rejects a broken condition and duplicate ids", () => {
    const source = flow(
      `  - id: a\n    when: case.x >\n    agent: "@x"\n    ask: q\n    expect: { v: str }\n` +
        `  - id: a\n    agent: "@x"\n    ask: q\n    expect: { v: str }\n`,
    );
    try {
      loadFlow(source);
      expect.unreachable();
    } catch (error) {
      expect((error as FlowError).problems).toHaveLength(2);
    }
  });

  it("rejects upper-case handles, which Discord would not turn into mentions", () => {
    const source = flow(`  - id: a\n    agent: "@Policy"\n    ask: q\n    expect: { v: str }\n`);
    expect(() => loadFlow(source)).toThrow(/lower case/);
  });

  it("rejects a reference to a step that does not exist yet", () => {
    const source = flow(
      `  - id: send\n    when: draft.ok == true\n    outlet: { post: { room: r, body: "{qoute.total}" } }\n    auto_approve: true\n` +
        `  - id: draft\n    agent: "@x"\n    ask: q\n    expect: { ok: bool }\n`,
    );
    try {
      loadFlow(source);
      expect.unreachable();
    } catch (error) {
      expect((error as FlowError).problems.join("\n")).toMatch(/"draft".*\n.*"qoute"|"qoute"[\s\S]*"draft"|"draft"[\s\S]*"qoute"/);
    }
  });
});
