import { describe, expect, it } from "vitest";
import { CHECKS } from "../src/engine/verifiers.ts";
import { authenticated, mailAuth } from "../src/inlets/mail-auth.ts";

// The company's mail gateway is believed only through its own header, the
// topmost one; absent means "not authenticated", never a pass.
describe("mail authentication evidence", () => {
  const GW = "mx.acme.test";
  const pass = `${GW}; spf=pass smtp.mailfrom=fabrikam.test; dkim=pass header.d=fabrikam.test; dmarc=pass header.from=fabrikam.test`;

  it("believes only the trusted gateway's header, and only the topmost one", () => {
    expect(authenticated(mailAuth({ "Authentication-Results": [pass] }, GW), "fabrikam.test")).toBe(true);
    // The gateway says DMARC failed (topmost); a "pass" the attacker wrote into
    // the message, naming the gateway, sits below it and is ignored.
    const planted = { "Authentication-Results": [`${GW}; spf=fail; dkim=none; dmarc=fail header.from=fabrikam.test`, pass] };
    expect(mailAuth(planted, GW)).toMatchObject({ available: true, dmarc: "fail" });
    expect(authenticated(mailAuth(planted, GW), "fabrikam.test")).toBe(false);
    // A header from some other server says nothing.
    expect(mailAuth({ "Authentication-Results": [pass.replace(GW, "mx.attacker.test")] }, GW)).toMatchObject({ available: false });
  });

  it("is unavailable, not passed, without a trusted gateway or its header", () => {
    expect(mailAuth({ "Authentication-Results": [pass] }, undefined)).toEqual({ available: false, reason: "no trusted mail gateway is configured" });
    expect(mailAuth({}, GW)).toMatchObject({ available: false });
    expect(authenticated(mailAuth({}, GW), "fabrikam.test")).toBe(false);
  });

  it("a DKIM signature counts only for the sender's own domain", () => {
    const other = mailAuth({ "Authentication-Results": [`${GW}; spf=softfail; dkim=pass header.d=bulkmailer.test`] }, GW);
    expect(authenticated(other, "fabrikam.test")).toBe(false);
  });

  const MASTER = `| vendor | domain | iban | contact | phone | changed | verified |
|---|---|---|---|---|---|---|
| Fabrikam Print | fabrikam.test | DE29100500000190183746 | accounts@fabrikam.test | +49 30 5550 1003 | 2025-03-20 | callback 2025-03-20 |`;
  const run = (extra: Record<string, unknown>) =>
    CHECKS.bank_change.run({ doc: "vendor-master", vendor: "Fabrikam Print", sender: "accounts@fabrikam.test", iban: "DE63120300001064532871", text: "pay DE63 1203 0000 1064 5328 71", ...extra }, [{ id: "vm", name: "vendor-master", content: MASTER }]);

  it("a forged From on the vendor's real domain fails the bank-change check", () => {
    const forged = run({ auth: mailAuth({ "Authentication-Results": [`${GW}; spf=fail; dkim=none; dmarc=fail header.from=fabrikam.test`] }, GW) });
    expect(forged).toMatchObject({ ok: false, forged: true, detail: expect.stringContaining("DMARC failed for fabrikam.test: the From address is forged") });
  });

  it("a Reply-To on another domain fails it; the same domain does not", () => {
    expect(run({ reply_to: "pay@fabrikam-payments.test" })).toMatchObject({ ok: false, detail: expect.stringContaining("replies to it go to fabrikam-payments.test, not fabrikam.test") });
    expect(run({ reply_to: "ap@fabrikam.test" })).toMatchObject({ ok: true });
  });

  it("says plainly when the sender is not authenticated, and passes nothing on that alone", () => {
    expect(run({})).toMatchObject({ ok: true, authenticated: false, detail: expect.stringContaining("sender not authenticated") });
    expect(run({ auth: mailAuth({ "Authentication-Results": [pass] }, GW) })).toMatchObject({ ok: true, authenticated: true, detail: expect.stringContaining(`sender authenticated by ${GW}`) });
  });
});
