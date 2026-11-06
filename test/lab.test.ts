import { describe, expect, it } from "vitest";
import { attackLab } from "../src/lab.ts";

// The attack lab's numbers, as the README quotes them: every one is counted
// from a run of the real engine, links between cases off and on.
describe("the attack lab", () => {
  it("links between cases stop the compromised-mailbox attacks that single-case checks let through", async () => {
    const results = await attackLab();
    const by = (name: string) => results.find((r) => r.name.startsWith(name))!;
    for (const name of ["Compromised mailbox: the real domain", "Compromised mailbox first"]) {
      expect(by(name).baseline.toAttacker).toBe(3150);
      expect(by(name).links.toAttacker).toBe(0);
    }
    // Single-case controls already stop these, with or without links.
    for (const name of ["Look-alike domain", "Invoice prints the account", "Insider swaps"]) {
      expect(by(name).baseline.toAttacker).toBe(0);
      expect(by(name).links.toAttacker).toBe(0);
    }
    // The cost: a shared factoring account gets a card it would not have had.
    expect(by("Two vendors paid through one factoring account").baseline.cards).toBe(0);
    expect(by("Two vendors paid through one factoring account").links.cards).toBe(1);
    // Poisoning with a vendor's real account costs nothing.
    expect(by("Poisoning").links.cards).toBe(by("Poisoning").baseline.cards);
    expect(results.filter((r) => r.kind === "benign").every((r) => r.links.toAttacker === 0)).toBe(true);
  }, 30_000);
});
