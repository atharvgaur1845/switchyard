import { describe, expect, it } from "vitest";
import { attackLab } from "../src/lab.ts";

// The attack lab's numbers, as the README quotes them: every one is counted
// from a run of the real engine, links between cases off and on.
describe("the attack lab", () => {
  it("links between cases stop the compromised-mailbox attacks that single-case checks let through", async () => {
    const results = await attackLab();
    const by = (name: string) => results.find((r) => r.name.startsWith(name))!;
    const first = (name: string) => by(name).runs.first;
    const callback = (name: string) => by(name).runs.callback;
    // When the callback is skipped or fooled, links are what stops the money.
    for (const name of ["Compromised mailbox: the real domain", "Compromised mailbox first"]) {
      expect(first(name).baseline.toAttacker).toBe(3150);
      expect(first(name).links.toAttacker).toBe(0);
      // A callback that reaches the real supplier stops it without links.
      expect(callback(name).baseline.toAttacker).toBe(0);
    }
    // Single-case controls already stop these, with or without links.
    for (const name of ["Look-alike domain", "Invoice prints the account", "Insider swaps"]) {
      expect(first(name).baseline.toAttacker).toBe(0);
      expect(first(name).links.toAttacker).toBe(0);
    }
    // The costs: a shared factoring account gets a card it would not have had,
    // and a genuine change whose account a look-alike named first is held.
    expect(first("Two vendors paid through one factoring account").baseline.cards).toBe(0);
    expect(first("Two vendors paid through one factoring account").links.cards).toBe(1);
    expect(first("Poisoning: a look-alike names Fabrikam's genuine new account first").links.outcomes).toContain("Held · linked to another case");
    // Poisoning with a vendor's account on file costs nothing.
    expect(first("Poisoning: a look-alike names Fabrikam's real account").links.cards).toBe(first("Poisoning: a look-alike names Fabrikam's real account").baseline.cards);
    expect(results.filter((r) => r.kind === "benign").every((r) => r.runs.first.links.toAttacker === 0 && r.runs.callback.links.toAttacker === 0)).toBe(true);
  }, 30_000);
});
