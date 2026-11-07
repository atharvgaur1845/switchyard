import { describe, expect, it } from "vitest";
import { runChaos } from "../src/chaos.ts";
import { watchState } from "../src/engine/runner.ts";
import type { CaseEvent } from "../src/engine/store.ts";

// The Chaos Lab is a test: every scenario must show what it expects, and
// every invariant must hold after it, for any seed.
describe("the chaos lab", () => {
  for (const seed of [1, 2, 7]) {
    it(`holds every scenario and invariant for seed ${seed}`, async () => {
      const results = await runChaos(seed);
      expect(results).toHaveLength(8);
      for (const r of results) expect({ id: r.id, ok: r.ok, observed: r.observed, failed: r.invariants.filter((i) => !i.ok) }).toMatchObject({ ok: true, failed: [] });
    });
  }

  it("is deterministic for a seed", async () => {
    const strip = (rs: Awaited<ReturnType<typeof runChaos>>) => rs.map((r) => r.observed.replace(/\b[0-9a-f]{8}\b/g, "<case>"));
    expect(strip(await runChaos(3, "C1"))).toEqual(strip(await runChaos(3, "C1")));
  });
});

describe("Assumption Watch hysteresis", () => {
  const e = (type: string): CaseEvent => ({ type, assumption: "capacity", detail: "", at: 0 }) as unknown as CaseEvent;
  it("counts failing re-checks in a row, and a pass starts the count again", () => {
    expect(watchState([], "capacity")).toEqual({ state: "healthy", fails: 0, passes: 0 });
    expect(watchState([e("assumption_suspect"), e("assumption_suspect")], "capacity")).toMatchObject({ state: "suspect", fails: 2 });
    expect(watchState([e("assumption_suspect"), e("assumption_ok"), e("assumption_suspect")], "capacity")).toMatchObject({ state: "suspect", fails: 1, passes: 0 });
    expect(watchState([e("assumption_suspect"), e("assumption_ok")], "capacity")).toMatchObject({ state: "suspect", passes: 1 });
    expect(watchState([e("assumption_suspect"), e("assumption_cleared")], "capacity")).toMatchObject({ state: "healthy" });
  });
});
