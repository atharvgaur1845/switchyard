import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "yaml";
import { compactIban, editDistance, ibanValid } from "../engine/verifiers.ts";

// A SANDBOX bank, not a real one: a separate process with its own ledger
// file, so Switchyard can show that what the bank holds is exactly what a
// person approved. It behaves like a careful payments API in three ways:
// every payment needs an Idempotency-Key, a key is paid at most once (a
// retry with the same key gets the same payment back, a different body with
// the same key is refused), and any payment can be read back by its key.
//
// It also answers "who holds this account?" the way Verification of Payee
// schemes do: given an IBAN and the name the payer means to pay, it says
// match, close match (with the name it holds), no match, or unavailable
// (it has no record). Its answers come from a registry file, and they are
// only as true as that file: this is a sandbox, not a bank's records.

export type PayeeResult = "match" | "close_match" | "no_match" | "unavailable";

const LEGAL = new Set(["gmbh", "ag", "ltd", "limited", "inc", "llc", "plc", "pvt", "sa", "sas", "bv", "nv", "co", "kg", "sro", "oy", "ab", "srl", "spa"]);
const tokens = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t));

// How the name held for an account compares with the name a payer gave.
export function comparePayee(held: string, given: string): Exclude<PayeeResult, "unavailable"> {
  const a = tokens(held);
  const b = tokens(given);
  if (!a.length || !b.length) return "no_match";
  if (a.join(" ") === b.join(" ")) return "match";
  // A typo, or every word given is in the name held ("Fabrikam Print" for
  // "Fabrikam Print Services"): close, so a person looks.
  if (editDistance(a.join(""), b.join("")) <= 2 || b.every((t) => a.includes(t)) || a.every((t) => b.includes(t))) return "close_match";
  return "no_match";
}

export interface Payment {
  id: string;
  key: string;
  payee: string;
  to: string;
  amount: string;
  currency: string;
  reference: string;
  status: "accepted";
  at: string;
}

const FIELDS = ["payee", "to", "amount", "currency", "reference"] as const;

// The demo world's registry (fixtures/payees.yaml): IBAN -> holder.
export function sandboxPayees(): Record<string, string> {
  return parse(readFileSync(new URL("../../fixtures/payees.yaml", import.meta.url), "utf8")) as Record<string, string>;
}

// What the bank answers for `iban` and `name`, from a registry.
export function answerPayee(payees: Record<string, string>, iban: string, name: string): { result: PayeeResult; holder?: string; reason?: string } {
  const held = Object.entries(payees).find(([i]) => compactIban(i) === compactIban(iban))?.[1];
  if (!held) return { result: "unavailable", reason: "the bank has no record of this account" };
  const result = comparePayee(held, name);
  // As in the schemes: the name held is disclosed only on a close match.
  return result === "close_match" ? { result, holder: held } : { result };
}

// `payees`: IBAN -> the name the account is held under.
export function startBank(opts: { port: number; ledger: string; payees?: Record<string, string> }): Server {
  const payees = new Map(Object.entries(opts.payees ?? {}).map(([iban, holder]) => [compactIban(iban), holder]));
  const load = (): Payment[] => (existsSync(opts.ledger) ? (JSON.parse(readFileSync(opts.ledger, "utf8")) as Payment[]) : []);
  const save = (payments: Payment[]) => {
    mkdirSync(dirname(opts.ledger), { recursive: true });
    writeFileSync(`${opts.ledger}.tmp`, JSON.stringify(payments, null, 2));
    renameSync(`${opts.ledger}.tmp`, opts.ledger);
  };
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bank");
    if (req.method === "POST" && url.pathname === "/payments") {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return json(res, 400, { error: "Idempotency-Key is required" });
      let body: Record<string, unknown>;
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "body is not JSON" });
      }
      const missing = FIELDS.filter((f) => typeof body[f] !== "string" || !body[f]);
      if (missing.length) return json(res, 400, { error: `missing ${missing.join(", ")}` });
      if (!ibanValid(String(body.to))) return json(res, 422, { error: `${String(body.to)} is not a valid IBAN` });
      if (!(Number(String(body.amount).replace(/,/g, "")) > 0)) return json(res, 422, { error: "amount must be positive" });

      const payments = load();
      const existing = payments.find((p) => p.key === key);
      if (existing) {
        const same = FIELDS.every((f) => existing[f] === body[f]);
        return same ? json(res, 200, existing) : json(res, 409, { error: "this Idempotency-Key was used for a different payment" });
      }
      const payment: Payment = {
        id: `SBX-${String(payments.length + 1).padStart(6, "0")}`,
        key,
        ...(Object.fromEntries(FIELDS.map((f) => [f, String(body[f])])) as Pick<Payment, (typeof FIELDS)[number]>),
        status: "accepted",
        at: new Date().toISOString(),
      };
      save([...payments, payment]);
      return json(res, 201, payment);
    }
    if (req.method === "POST" && url.pathname === "/payee-check") {
      let body: Record<string, unknown>;
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "body is not JSON" });
      }
      return json(res, 200, answerPayee(Object.fromEntries(payees), String(body.iban ?? ""), String(body.name ?? "")));
    }
    if (req.method === "GET" && url.pathname.startsWith("/payments/")) {
      const key = decodeURIComponent(url.pathname.slice("/payments/".length));
      const payment = load().find((p) => p.key === key);
      return payment ? json(res, 200, payment) : json(res, 404, { error: "no payment with that key" });
    }
    if (req.method === "GET" && url.pathname === "/") {
      const rows = load()
        .map((p) => `<tr><td>${p.id}</td><td>${esc(p.at)}</td><td>${esc(p.payee)}</td><td><code>${esc(p.to)}</code></td><td style="text-align:right">${esc(p.amount)} ${esc(p.currency)}</td><td>${esc(p.reference)}</td><td><code>${esc(p.key)}</code></td></tr>`)
        .join("");
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Sandbox bank</title>
<style>body{font:14px system-ui;margin:24px;background:#faf9f6;color:#17171a}.b{background:#fbe9e4;color:#a2311b;padding:10px 14px;border-radius:8px;font-weight:600}table{border-collapse:collapse;margin-top:16px;width:100%}td,th{border-bottom:1px solid #e6e4de;padding:6px 10px;text-align:left}code{font-size:12px}</style>
<p class="b">SANDBOX BANK: a local test service for Switchyard's demo. No real money, no real bank.</p>
<h1>Ledger</h1><table><tr><th>id</th><th>accepted</th><th>payee</th><th>account</th><th>amount</th><th>reference</th><th>idempotency key</th></tr>${rows || '<tr><td colspan="7">No payments yet.</td></tr>'}</table>`);
    }
    json(res, 404, { error: "not found" });
  }).listen(opts.port);
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
