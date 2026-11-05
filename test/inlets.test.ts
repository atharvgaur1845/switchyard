import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formFields, readSubmission } from "../src/inlets/form.ts";
import { mapPayload, verifySignature } from "../src/inlets/webhook.ts";
import { SseParser } from "../src/switch/sse.ts";

describe("SSE parsing", () => {
  it("joins frames split across chunks and skips keepalives", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\n\nid: 7\nevent: mess")).toEqual([]);
    expect(parser.push('age\ndata: {"a":1}\r\n\r\nevent: x\ndata: 1\ndata: 2\n\n')).toEqual([
      { id: "7", event: "message", data: '{"a":1}' },
      { id: undefined, event: "x", data: "1\n2" },
    ]);
  });
});

describe("form inlet", () => {
  const fields = formFields({ form: { fields: ["name", "amount:number", "email:email"] } })!;

  it("types the submission", () => {
    const result = readSubmission(fields, new URLSearchParams({ name: " Asha ", amount: "12.5", email: "a@b.co" }));
    expect(result).toEqual({ ok: true, data: { name: "Asha", amount: 12.5, email: "a@b.co" } });
  });

  it.each([
    [{ name: "", amount: "1", email: "a@b.co" }, /Name is required/],
    [{ name: "A", amount: "1", email: "nope" }, /email address/],
  ])("rejects %o", (values, error) => {
    const result = readSubmission(fields, new URLSearchParams(values));
    expect(!result.ok && result.error).toMatch(error);
  });

  it("refuses unknown field types", () => {
    expect(() => formFields({ form: { fields: ["x:date"] } })).toThrow(/unknown type/);
  });
});

describe("webhook inlet", () => {
  it("checks the HMAC of the raw body", () => {
    const raw = '{"total":5}';
    const good = "sha256=" + createHmac("sha256", "s3cret").update(raw).digest("hex");
    expect(verifySignature("s3cret", raw, good)).toBe(true);
    expect(verifySignature("s3cret", raw + " ", good)).toBe(false);
    expect(verifySignature("s3cret", raw, "sha256=00")).toBe(false);
    expect(verifySignature("s3cret", raw, undefined)).toBe(false);
  });

  it("maps payload paths to case fields", () => {
    const payload = { data: { total: 40, customer: { name: "Globex" } } };
    expect(mapPayload({ map: { amount: "data.total", customer: "data.customer.name" } }, payload)).toEqual({
      amount: 40,
      customer: "Globex",
    });
  });
});

describe("mapping Switch's answered_by to a handle", async () => {
  const { personIdMatches } = await import("../src/switch/client.ts");
  const bridge = "switch-mattermost-820b1c1b-ad44-45a4-bcbe-18fb35163089";

  it.each([
    [`${bridge}-user`, "user", true],
    [`${bridge}-ann-marie-1a2b3c4d`, "ann.marie", true],
    [`${bridge}-atharv`, "Atharv", true],
    [`${bridge}-superuser`, "user", false],
    [`${bridge}-user-extra`, "user", false],
  ])("%s is %s: %s", (localpart, name, expected) => {
    expect(personIdMatches(localpart, name)).toBe(expected);
  });
});
