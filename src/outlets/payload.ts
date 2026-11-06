import { createHash } from "node:crypto";
import { render, type Scope } from "../engine/expr.ts";
import type { Outlet } from "../engine/flow-schema.ts";

// Fills every `{placeholder}` in an outlet, giving the exact action that will
// run. This rendered form is what a person approves and what gets hashed.
export function renderOutlet(outlet: Outlet, scope: Scope): Outlet {
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") return render(value, scope);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    }
    return value;
  };
  return fill(outlet) as Outlet;
}

export function hashOutlet(outlet: Outlet): string {
  return createHash("sha256").update(canonical(outlet)).digest("hex");
}

// JSON with sorted keys, so the same action always hashes the same.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// A readable preview for the approval card.
export function describeOutlet(outlet: Outlet): string {
  if ("csv" in outlet) return `Append to ${outlet.csv.file}: ${outlet.csv.row.join(" | ")}`;
  if ("email" in outlet) return `Email ${outlet.email.to}\nSubject: ${outlet.email.subject}\n\n${outlet.email.body}`;
  if ("webhook" in outlet) return `POST ${outlet.webhook.url}\n${JSON.stringify(outlet.webhook.body, null, 2)}`;
  if ("visitor" in outlet) return `Reply to the visitor:\n${outlet.visitor.body}`;
  if ("document" in outlet) return `Set the row for ${outlet.document.row[0]} in ${outlet.document.name}: ${outlet.document.row.join(" | ")}`;
  if ("pay" in outlet) {
    const { payee, to, amount, currency, reference } = outlet.pay;
    return `Pay ${amount} ${currency} to ${payee}\nAccount: ${to}\nReference: ${reference}`;
  }
  return `Post to ${outlet.post.room}:\n${outlet.post.body}`;
}
