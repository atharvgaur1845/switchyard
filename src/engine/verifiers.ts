import { createHash } from "node:crypto";
import type { RoomDocument } from "./ports.ts";

// Checks done by code, not by a model. Agents read messy input and draft;
// these confirm the facts a decision rests on (a purchase order exists and
// matches, a quote adds up), so an automatic action never rests on what two
// models happened to agree on.

export interface VerifyResult {
  ok: boolean;
  // One line a person can read on the approval card.
  detail: string;
  [field: string]: unknown;
}

type Check = (args: Record<string, unknown>, docs: RoomDocument[]) => VerifyResult;

export const CHECKS: Record<string, { needsDoc: boolean; run: Check }> = {
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
      const supplierOk = norm(supplier).includes(norm(String(args.supplier ?? ""))) || norm(String(args.supplier ?? "")).includes(norm(supplier));
      const amountOk = poAmount !== undefined && invoiced !== undefined && Math.round(poAmount * 100) === Math.round(invoiced * 100);
      const open = /open/i.test(status);
      const problems = [
        !supplierOk && `supplier is ${supplier}, not ${String(args.supplier)}`,
        !amountOk && `${po} is for ${fmt(poAmount)}, the invoice is ${fmt(invoiced)}`,
        !open && `${po} is ${status || "not open"}`,
      ].filter(Boolean);
      return {
        ok: problems.length === 0,
        found: true,
        po_amount: poAmount,
        detail: problems.length === 0 ? `${po} (${supplier}, ${fmt(poAmount)}) matches the invoice` : problems.join("; "),
      };
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
};

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

export function docHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const n = Number(value.replace(/[,\s]/g, "").replace(/[^\d.-]/g, ""));
  return value.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const fmt = (n: number | undefined) => (n === undefined ? "?" : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
