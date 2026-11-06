import { createHash } from "node:crypto";
import type { PayeeAnswer, RoomDocument } from "./ports.ts";
import { authenticated, type MailAuth } from "../inlets/mail-auth.ts";
import { type Blocked, findLinks, linkDigest } from "./links.ts";

// Checks done by code, not by a model. Agents read messy input and draft;
// these confirm the facts a decision rests on (a purchase order exists and
// matches, a quote adds up), so an automatic action never rests on what two
// models happened to agree on.

export interface VerifyResult {
  ok: boolean;
  // One line a person can read on the approval card.
  detail: string;
  // Document -> the first cell of the row the result rests on. Only that row
  // is then watched for changes, not the whole document.
  rows?: Record<string, string>;
  [field: string]: unknown;
}

// `now` is the engine's clock, so checks about dates are testable. `history`
// is what earlier cases decided, for checks that look across cases.
export interface History {
  caseId: string;
  blocked: Blocked[];
}
type Check = (args: Record<string, unknown>, docs: RoomDocument[], now?: number, history?: History) => VerifyResult;

const DAY = 86_400_000;

// `history`: the check needs earlier cases. `basis: false`: the document it
// reads is not part of what the case rests on (another step already holds
// that row); what it rests on is in its result's `watch`.
// Where a quote was found: at offsets in the invoice text, or in a field.
export interface Grounding {
  quote: string;
  in: string;
  start?: number;
  end?: number;
}

// What a check may ask outside the room: the bank, who holds an account.
export interface CheckContext {
  payee?: (iban: string, name: string) => Promise<PayeeAnswer>;
}
type AsyncCheck = (args: Record<string, unknown>, docs: RoomDocument[], ctx: CheckContext) => Promise<VerifyResult>;

export const CHECKS: Record<string, { needsDoc: boolean; history?: boolean; basis?: boolean; run: Check; runAsync?: AsyncCheck }> = {
  // args: doc, po, supplier, amount. The document holds a markdown table
  // whose first column is the PO number, then supplier, amount and status.
  po_lookup: {
    needsDoc: true,
    run(args, docs) {
      const doc = docs.find((d) => d.name === args.doc);
      if (!doc) return { ok: false, detail: `no document "${String(args.doc)}" in this room` };
      const po = String(args.po ?? "").trim();
      const row = tableRows(doc.content).find((cells) => cells[0]?.toUpperCase() === po.toUpperCase());
      if (!row) return { ok: false, found: false, detail: `${po || "(no PO number)"} is not in ${doc.name}` };
      const [, supplier = "", amountText = "", status = ""] = row;
      const poAmount = toNumber(amountText);
      const invoiced = toNumber(args.amount);
      const claimed = String(args.supplier ?? "");
      // The whole name: "Fabrikam" is a different supplier from "Fabrikam Print".
      const supplierOk = sameName(supplier, claimed);
      const amountOk = poAmount !== undefined && invoiced !== undefined && Math.round(poAmount * 100) === Math.round(invoiced * 100);
      // Exactly "open": "not open" and "paid (was open)" are not.
      const open = norm(status) === "open";
      const problems = [
        !supplierOk && `supplier is ${supplier}, not ${String(args.supplier)}`,
        !amountOk && `${po} is for ${fmt(poAmount)}, the invoice is ${fmt(invoiced)}`,
        !open && `${po} is ${status || "not open"}`,
      ].filter(Boolean);
      return {
        ok: problems.length === 0,
        found: true,
        rows: { [doc.name]: row[0] },
        po: row[0],
        supplier,
        po_amount: poAmount,
        amount_text: amountText,
        open,
        status,
        // Marked by an earlier case's reservation: this order was already
        // invoiced, and each PO is paid once.
        invoiced: /^invoiced\b/i.test(status.trim()),
        detail: problems.length === 0 ? `${po} (${supplier}, ${fmt(poAmount)}) matches the invoice` : problems.join("; "),
      };
    },
  },

  // What two agents with different jobs said about an invoice, checked
  // against the invoice itself. args: forensics (the reader's answer:
  // supplier, number, amount, iban, po, quotes), investigator (verdict and
  // findings, each a claim with a quote), and the invoice's own supplier,
  // number, amount, iban, po and text. A quote counts only if it is in the
  // invoice word for word, so a model cannot invent evidence; a reading that
  // differs from the invoice data, a quote that is not in it, a suspicious
  // verdict, or an agent that did not answer sends the invoice to a person.
  // Nothing here can make a payment happen: the other checks still decide.
  agent_evidence: {
    needsDoc: false,
    run(args) {
      const forensics = (args.forensics ?? {}) as Record<string, unknown>;
      const investigator = (args.investigator ?? {}) as Record<string, unknown>;
      const squash = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      // Where a quote may come from. With the invoice's own text, only that
      // text: a quote is located in it, with its character offsets. Without
      // it, a quote can only repeat a structured field, and says so; it is
      // never passed off as a quotation from a document nobody saw.
      const text = typeof args.text === "string" && args.text.trim() ? args.text : undefined;
      const fields: Record<string, string> = Object.fromEntries(
        (["supplier", "number", "amount", "iban", "po"] as const).filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== "").map((k) => [k, String(args[k])]),
      );
      const ground = (quote: unknown): Grounding | undefined => {
        const q = String(quote ?? "").trim();
        if (squash(q).length < 3) return undefined;
        if (text) {
          const pattern = new RegExp(q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
          const at = pattern.exec(text);
          return at ? { quote: q, in: "text", start: at.index, end: at.index + at[0].length } : undefined;
        }
        const field = Object.entries(fields).find(([, v]) => squash(v) === squash(q) || squash(v).includes(squash(q)));
        return field ? { quote: q, in: `field:${field[0]}` } : undefined;
      };
      const problems: string[] = [];
      const grounded: Grounding[] = [];
      if (forensics.unavailable) problems.push(`the invoice reader could not answer (${String(forensics.reason ?? "no reply")})`);
      else {
        if (!sameName(String(forensics.supplier ?? ""), String(args.supplier ?? ""))) problems.push(`the reader names the supplier ${String(forensics.supplier || "(none)")}, the invoice ${String(args.supplier || "(none)")}`);
        if (squash(forensics.number) !== squash(args.number)) problems.push(`the reader read invoice number ${String(forensics.number || "(none)")}, the invoice says ${String(args.number || "(none)")}`);
        const a = toNumber(forensics.amount);
        const b = toNumber(args.amount);
        if (a === undefined || b === undefined || Math.round(a * 100) !== Math.round(b * 100)) problems.push(`the reader read ${fmt(a)}, the invoice says ${fmt(b)}`);
        if (forensics.po && args.po && squash(forensics.po) !== squash(args.po)) problems.push(`the reader read ${String(forensics.po)}, the invoice says ${String(args.po)}`);
        // The account the reader read: in the invoice text, or the account
        // field itself; anywhere else it is the reader's invention.
        const read = compactIban(String(forensics.iban ?? ""));
        const field = compactIban(String(args.iban ?? ""));
        const inText = text ? compactIban(text.replace(/-/g, "")).includes(read) : false;
        if (read && !inText && read !== field) problems.push(`the reader's account ${maskIban(read)} is not in the invoice${text ? " text" : ""} or its account field`);
        else if (read && inText && read !== field) problems.push(`the invoice text asks for ${maskIban(read)}, but its account field says ${field ? maskIban(field) : "nothing"}`);
        const quotes = Array.isArray(forensics.quotes) ? forensics.quotes : [];
        for (const q of quotes) {
          const g = ground(q);
          if (g) grounded.push(g);
        }
        const missing = quotes.length - grounded.length;
        if (missing) problems.push(`${missing} of the reader's ${quotes.length} quotes are not in the invoice${text ? " text" : "'s fields"}`);
      }
      const findings: ({ claim: string } & Grounding)[] = [];
      const dropped: string[] = [];
      if (investigator.unavailable) problems.push(`the investigator could not answer (${String(investigator.reason ?? "no reply")})`);
      else {
        for (const f of Array.isArray(investigator.findings) ? investigator.findings : []) {
          const claim = typeof f === "string" ? f : String((f as Record<string, unknown>)?.claim ?? "");
          const quote = typeof f === "string" ? "" : String((f as Record<string, unknown>)?.quote ?? "");
          const g = ground(quote);
          if (g) findings.push({ claim, ...g });
          else dropped.push(claim);
        }
        if (investigator.verdict !== "clear") {
          problems.push(findings.length
            ? `the investigator found: ${findings.map((f) => `${f.claim} ("${f.quote}")`).join("; ")}`
            : `the investigator called it ${String(investigator.verdict ?? "unclear")} but quoted nothing that is in the invoice`);
        }
      }
      return {
        ok: problems.length === 0,
        findings,
        dropped,
        // Each quote, and where it was found: offsets in the invoice text, or
        // the structured field it repeats when there is no text.
        quotes: grounded,
        grounding: text ? "invoice text" : "structured fields only (no invoice text)",
        detail: problems.length === 0
          ? `the reader's figures match the invoice, every quote is in ${text ? "its text" : "its fields (there is no invoice text)"}, and the investigator found nothing${dropped.length ? ` (${dropped.length} claim${dropped.length > 1 ? "s" : ""} without a quote from the invoice set aside)` : ""}`
          : problems.join("; "),
      };
    },
  },

  // Who the bank says holds the account (Verification of Payee). args: doc
  // (the payment-mandates document), vendor, iban. Passes when the bank
  // confirms the vendor holds it, or a holder the vendor is paid through
  // under an attested row of the mandates document (a factoring company).
  // A close match, no match, or no answer does not pass: a person looks, and
  // on no match nothing is paid. The bank's word is evidence of a different
  // kind from the room's: it does not come from the email or the vendor
  // master, so a fooled callback or an edited row cannot supply it.
  payee: {
    needsDoc: true,
    basis: false,
    run: () => ({ ok: false, result: "unavailable", detail: "payee verification needs the bank" }),
    async runAsync(args, docs, ctx) {
      const iban = compactIban(String(args.iban ?? ""));
      const vendor = String(args.vendor ?? "");
      if (!ibanValid(iban) || !vendor) return { ok: false, result: "unavailable", detail: "there is no valid account and vendor to verify" };
      if (!ctx.payee) return { ok: false, result: "unavailable", detail: `no bank was asked who holds ${maskIban(iban)}` };
      const first = await ctx.payee(iban, vendor);
      if (first.result === "match") return { ok: true, result: "match", holder: vendor, detail: `the bank confirms ${maskIban(iban)} is held by ${vendor}` };
      const doc = docs.find((d) => d.name === args.doc);
      const mandates = doc ? tableRows(doc.content).filter(([v = ""]) => sameName(v, vendor)) : [];
      for (const [key = "", holder = ""] of mandates) {
        if (!holder) continue;
        const through = await ctx.payee(iban, holder);
        if (through.result === "match") {
          return {
            ok: true,
            result: "mandate",
            holder,
            rows: { [doc!.name]: key },
            watch: { [doc!.name]: { hash: basisHash(doc!.content, key), row: key } },
            detail: `the bank confirms ${maskIban(iban)} is held by ${holder}, who is paid on ${vendor}'s behalf under a mandate in ${doc!.name}`,
          };
        }
      }
      if (first.result === "close_match") return { ok: false, result: "close_match", holder: first.holder, detail: `the bank holds ${maskIban(iban)} under a similar but different name: ${first.holder ?? "not given"}, not ${vendor}` };
      if (first.result === "no_match") return { ok: false, result: "no_match", detail: `the bank says ${maskIban(iban)} is not held by ${vendor}${mandates.length ? " or anyone it is paid through" : ""}` };
      return { ok: false, result: "unavailable", detail: `the bank could not say who holds ${maskIban(iban)}${first.reason ? ` (${first.reason})` : ""}` };
    },
  },

  // args: lines (each with qty, unit and amount), total.
  sum_lines: {
    needsDoc: false,
    run(args) {
      const lines = Array.isArray(args.lines) ? (args.lines as Record<string, unknown>[]) : [];
      const total = toNumber(args.total);
      const wrong = lines.filter((l) => {
        const qty = toNumber(l.qty);
        const unit = toNumber(l.unit ?? l.unit_price);
        const amount = toNumber(l.amount);
        return qty !== undefined && unit !== undefined && (amount === undefined || Math.round(qty * unit * 100) !== Math.round(amount * 100));
      });
      const sum = lines.reduce((n, l) => n + (toNumber(l.amount) ?? 0), 0);
      const sumOk = total !== undefined && Math.round(sum * 100) === Math.round(total * 100);
      const problems = [
        lines.length === 0 && "the quote has no line items",
        wrong.length > 0 && `${wrong.length} line${wrong.length > 1 ? "s" : ""} where qty × unit ≠ amount`,
        !sumOk && `the lines add up to ${fmt(sum)}, not ${fmt(total)}`,
      ].filter(Boolean);
      return {
        ok: problems.length === 0,
        sum,
        detail: problems.length === 0 ? `${lines.length} lines add up to ${fmt(total)}` : problems.join("; "),
      };
    },
  },

  // A request to change a supplier's bank account. args: doc (the vendor
  // master), vendor, sender (the email address it came from), iban (the new
  // account), text (the email, which must contain that account). Passes only when the vendor is on file, the request came from
  // the vendor's own domain, and the new account is a valid IBAN that differs
  // from the current one. A pass still needs a callback and a second person.
  bank_change: {
    needsDoc: true,
    run(args, docs, now = Date.now()) {
      const master = vendorMaster(docs, args.doc);
      if ("error" in master) return { ok: false, detail: master.error };
      const vendor = master.find(String(args.vendor ?? ""));
      if (!vendor) return { ok: false, detail: `${String(args.vendor || "(no vendor)")} is not in ${String(args.doc)}` };
      const sender = String(args.sender ?? "").toLowerCase();
      const senderDomain = sender.split("@")[1]?.replace(/>$/, "") ?? "";
      if (!vendor.domain) return { ok: false, detail: `${vendor.vendor} has no domain on file, so the sender cannot be checked` };
      const distance = editDistance(senderDomain, vendor.domain);
      const iban = compactIban(String(args.iban ?? ""));
      const auth = args.auth && typeof args.auth === "object" ? (args.auth as MailAuth) : undefined;
      const replyDomain = String(args.reply_to ?? "").toLowerCase().split("@")[1]?.replace(/>$/, "") ?? "";
      const problems = [
        senderDomain !== vendor.domain &&
          (distance <= 2
            ? `the request came from ${senderDomain}, ${distance} character${distance === 1 ? "" : "s"} away from ${vendor.domain} on file: a look-alike domain`
            : `the request came from ${senderDomain || "an unknown sender"}, not ${vendor.domain} on file`),
        !ibanValid(iban) && `${iban || "(no account)"} is not a valid IBAN`,
        iban === vendor.iban && "the new account is the one already on file",
        // The agent read the account from the email; code confirms it is there.
        args.text !== undefined && iban !== "" && !compactIban(String(args.text)).includes(iban) && `${maskIban(iban)} does not appear in the email, so the agent's reading of it cannot be confirmed`,
        // Replies would go somewhere other than the sender's domain.
        replyDomain && replyDomain !== senderDomain && !replyDomain.endsWith(`.${senderDomain}`) && `replies to it go to ${replyDomain}, not ${senderDomain}`,
        // The company's mail gateway says the From address is forged.
        auth?.available && auth.dmarc === "fail" && `the mail gateway ${auth.gateway} reports DMARC failed for ${senderDomain}: the From address is forged`,
        auth?.available && auth.dmarc === undefined && auth.spf !== "pass" && !authenticated(auth, senderDomain) && `the mail gateway ${auth.gateway} could not verify ${senderDomain} by SPF or DKIM`,
      ].filter(Boolean);
      const vouched = authenticated(auth, senderDomain);
      const authText = !auth
        ? "sender not authenticated (no mail gateway result)"
        : auth.available
          ? vouched ? `sender authenticated by ${auth.gateway}` : `sender not authenticated by ${auth.gateway}`
          : `sender not authenticated (${auth.reason})`;
      return {
        ok: problems.length === 0,
        rows: { [String(args.doc)]: vendor.vendor },
        vendor: vendor.vendor,
        domain: vendor.domain,
        sender_domain: senderDomain,
        lookalike: senderDomain !== vendor.domain && distance <= 2,
        contact: vendor.contact,
        phone: vendor.phone,
        current_iban: vendor.iban,
        new_iban: iban,
        new_tail: iban.slice(-4),
        in_email: args.text === undefined ? undefined : compactIban(String(args.text)).includes(iban),
        // Evidence, never a pass on its own: absent means "not authenticated".
        authenticated: vouched,
        // The gateway says the From address is forged: the domain is not who sent it.
        forged: Boolean(auth?.available && auth.dmarc === "fail"),
        auth: authText,
        today: new Date(now).toISOString().slice(0, 10),
        detail: problems.length === 0 ? `${vendor.vendor}: ${maskIban(vendor.iban)} → ${maskIban(iban)}, requested from ${senderDomain}; ${authText}` : problems.join("; "),
      };
    },
  },

  // Across cases. args: doc (the vendor master), vendor, iban (the account
  // this case would pay or write), printed (an account an invoice printed,
  // never paid). Fails when another case or vendor is linked to an account:
  // one a person blocked in a bank-change request, or another vendor's.
  links: {
    needsDoc: true,
    history: true,
    basis: false,
    run(args, docs, now = Date.now(), history) {
      const master = docs.find((d) => d.name === args.doc)?.content ?? "";
      const iban = compactIban(String(args.iban ?? ""));
      const found = findLinks(
        { iban, printed: String(args.printed ?? ""), vendor: String(args.vendor ?? ""), caseId: history?.caseId },
        master,
        history?.blocked ?? [],
        now,
      );
      const digest = linkDigest(found);
      return {
        ok: found.length === 0,
        links: found,
        linked_cases: [...new Set(found.map((l) => l.caseId).filter(Boolean))],
        subject: iban || null,
        digest,
        // What an approval rests on: the kinds of link on the account it would
        // pay or write. If that changes, the approval stops counting.
        watch: iban ? { [`links:${iban}`]: { hash: digest, row: String(args.vendor ?? "") } } : undefined,
        detail: found.length === 0
          ? iban ? `no other case or vendor is linked to ${maskIban(iban)}` : "no account to link"
          : found.map((l) => (l.role === "printed" ? `the account the invoice printed: ${l.detail}` : l.detail)).join("; "),
      };
    },
  },

  // Before paying: where the money goes. args: doc (the vendor master),
  // vendor, iban (the account printed on the invoice, if any). The payment
  // always goes to the account on file, never to one taken from the invoice.
  vendor_bank: {
    needsDoc: true,
    run(args, docs, now = Date.now()) {
      const master = vendorMaster(docs, args.doc);
      if ("error" in master) return { ok: false, detail: master.error };
      const vendor = master.find(String(args.vendor ?? ""));
      if (!vendor) return { ok: false, detail: `${String(args.vendor || "(no vendor)")} is not in ${String(args.doc)}` };
      const printed = compactIban(String(args.iban ?? ""));
      // Only an ISO date (2026-11-05) is read; Date.parse would guess at others.
      const day = vendor.changed.trim();
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day) : Number.NaN;
      // 2026-02-30 parses as 2 March; only a date that reads back the same counts.
      const changed = Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? parsed : Number.NaN;
      // A date that cannot be read could be yesterday: treat it as recent.
      const recent = !Number.isFinite(changed) || now - changed < 30 * DAY;
      const problems = [
        printed && printed !== vendor.iban && `the invoice asks for payment to ${maskIban(printed)}, but ${maskIban(vendor.iban)} is on file`,
        !ibanValid(vendor.iban) && `the account on file is not a valid IBAN`,
        !vendor.verified && `the account on file was never verified by a callback`,
      ].filter(Boolean);
      return {
        ok: problems.length === 0,
        rows: { [String(args.doc)]: vendor.vendor },
        vendor: vendor.vendor,
        iban: vendor.iban,
        recent,
        changed: vendor.changed,
        detail: problems.length === 0
          ? `pays ${maskIban(vendor.iban)} on file${recent ? `, changed ${vendor.changed} (first payment since: a person approves)` : ""}`
          : problems.join("; "),
      };
    },
  },
};

interface Vendor {
  vendor: string;
  domain: string;
  iban: string;
  contact: string;
  phone: string;
  changed: string;
  verified: string;
}

// The vendor master: | vendor | domain | iban | contact | phone | changed | verified |
function vendorMaster(docs: RoomDocument[], name: unknown): { error: string } | { find: (vendor: string) => Vendor | undefined } {
  const doc = docs.find((d) => d.name === name);
  if (!doc) return { error: `no document "${String(name)}" in this room` };
  const rows = tableRows(doc.content).map(([vendor = "", domain = "", iban = "", contact = "", phone = "", changed = "", verified = ""]) => ({
    vendor,
    domain: domain.toLowerCase(),
    iban: compactIban(iban),
    contact,
    phone,
    changed,
    verified: /^(callback|verified)\b/i.test(verified.trim()) && !/\bnot\b/i.test(verified) ? verified : "",
  }));
  return { find: (vendor) => rows.find((r) => sameName(r.vendor, vendor)) };
}

export function compactIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

// ISO 13616: move the first four characters to the end, letters become
// numbers (A=10 ... Z=35), and the result mod 97 must be 1.
export function ibanValid(iban: string): boolean {
  const s = compactIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const length = IBAN_LENGTH[s.slice(0, 2)];
  if (length && s.length !== length) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

// Lengths from the SWIFT IBAN registry, for the countries most often seen.
const IBAN_LENGTH: Record<string, number> = {
  AT: 20, BE: 16, CH: 21, CZ: 24, DE: 22, DK: 18, ES: 24, FI: 18, FR: 27, GB: 22, IE: 22,
  IT: 27, LU: 20, NL: 18, NO: 15, PL: 28, PT: 25, SE: 24,
};

const maskIban = (iban: string) => (iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : iban || "?");

// Damerau-Levenshtein distance (optimal string alignment): "fabrikam" and
// "fabrikarn" are 2 apart, "fabrlkam" 1.
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Replaces the row whose first cell is `row[0]` in the document's table, or
// appends it. Returns the new document.
export function setTableRow(markdown: string, row: string[]): string {
  const lines = markdown.replace(/\n+$/, "").split("\n");
  const line = `| ${row.join(" | ")} |`;
  const header = lines.findIndex((l) => l.trim().startsWith("|"));
  const at = lines.findIndex((l, i) => i !== header && l.trim().startsWith("|") && !/^\|[\s:|-]+\|?$/.test(l.trim()) && sameName(l.trim().replace(/^\|/, "").split("|")[0] ?? "", row[0]));
  if (at >= 0) lines[at] = line;
  else {
    const last = lines.map((l, i) => (l.trim().startsWith("|") ? i : -1)).filter((i) => i >= 0).at(-1);
    lines.splice(last === undefined ? lines.length : last + 1, 0, line);
  }
  return `${lines.join("\n")}\n`;
}

// Rows of every markdown table in a document, as trimmed cell strings,
// without header and separator rows.
export function tableRows(markdown: string): string[][] {
  const rows = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  return rows.filter((cells, i) => !cells.every((c) => /^:?-+:?$/.test(c)) && !(rows[i + 1]?.every((c) => /^:?-+:?$/.test(c))));
}

// Full SHA-256: a version a check rested on is compared again before any
// action, so it must not be short enough to collide on purpose.
export function docHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Hashes as people read them, in messages and on cards: the first 16 hex
// digits. The event log keeps the full hash.
export function short(hash: string): string {
  return hash.startsWith("row:") ? `row:${hash.slice(4, 20)}` : hash.slice(0, 16);
}

// Cases logged before hashes were full length stored 16 hex digits for an
// action or a read-back and 12 for a document version. Such a hash still
// matches the full hash it begins with, at that field's old length only, so
// an open case survives the upgrade; everything new is compared in full.
export const LEGACY = { action: 16, document: 12 } as const;
export function sameHash(stored: string, fresh: string, legacy: number): boolean {
  if (stored === fresh) return true;
  const row = stored.startsWith("row:");
  if (row !== fresh.startsWith("row:")) return false;
  const s = row ? stored.slice(4) : stored;
  const f = row ? fresh.slice(4) : fresh;
  return s.length === legacy && /^[0-9a-f]+$/.test(s) && /^[0-9a-f]{64}$/.test(f) && f.startsWith(s);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const n = Number(value.replace(/[,\s]/g, "").replace(/[^\d.-]/g, ""));
  return value.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

// Letters, combining marks and digits in any script, so "Άλφα ΑΕ" and
// "Δέλτα ΑΕ" stay different, and so do "कमल" and "कमला".
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
// For keys and comparisons outside this file: the same rule as names.
export const normalizeName = norm;
export const sameName = (a: string, b: string) => norm(a) !== "" && norm(a) === norm(b);

// A row's content, for attesting it: the cells of every table row whose first
// cell names `key`, trimmed, so the same row hashes the same however the
// room's editor spaced it. Empty when no row names `key`.
export function rowHash(content: string, key: string): string {
  const rows = tableRows(content).filter((cells) => sameName(cells[0] ?? "", key));
  return rows.length === 0 ? "" : createHash("sha256").update(rows.map((cells) => cells.join("\u001f")).join("\n")).digest("hex");
}

// The version of what a result rests on: the rows named by `key`, or the
// whole document when the result named no row.
export function basisHash(content: string, key?: string): string {
  if (key === undefined) return docHash(content);
  const lines = content.split("\n").filter((l) => l.trim().startsWith("|") && sameName(l.trim().replace(/^\|/, "").split("|")[0] ?? "", key));
  return `row:${docHash(lines.join("\n"))}`;
}
const fmt = (n: number | undefined) => (n === undefined ? "?" : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
