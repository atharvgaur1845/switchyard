import { describe, expect, it } from "vitest";
import { compile, ExprError, render } from "../src/engine/expr.ts";

describe("expressions", () => {
  const scope = { case: { amount: 800, name: "Asha" }, check: { verdict: "ok" }, manager: "approve" };

  it.each([
    ["case.amount > 500", true],
    ["case.amount <= 500", false],
    ['check.verdict == "ok" and manager != "reject"', true],
    ['not (check.verdict == "ok")', false],
    ['case.amount < 100 or manager == "approve"', true],
    ['missing.path == "x"', false],
    ["missing.path > 1", false],
  ])("%s -> %s", (source, expected) => {
    expect(compile(source)(scope)).toBe(expected);
  });

  it("does not compare numbers with strings by order", () => {
    expect(compile('case.name > 5')(scope)).toBe(false);
  });

  it.each(["case.amount >", "(case.amount > 1", "process.exit()", "a ; b", "x = 1"])(
    "rejects %s",
    (source) => expect(() => compile(source)).toThrow(ExprError),
  );

  it("fills placeholders and leaves missing ones empty", () => {
    expect(render("{case.name} spent {case.amount}{nope}", scope)).toBe("Asha spent 800");
  });
});
