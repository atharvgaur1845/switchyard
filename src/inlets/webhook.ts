import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "../engine/expr.ts";

// `inlet.webhook` in a flow:
//   webhook:
//     secret_env: SALES_HOOK_SECRET   # optional; checks X-Switchyard-Signature
//     map: { amount: data.total, customer: data.customer.name }
export interface WebhookInlet {
  secret_env?: string;
  map?: Record<string, string>;
}

export function webhookInlet(inlet: Record<string, unknown> | undefined): WebhookInlet | undefined {
  return inlet?.webhook as WebhookInlet | undefined;
}

// Senders sign the raw body: `X-Switchyard-Signature: sha256=<hex hmac>`.
export function verifySignature(secret: string, raw: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function mapPayload(inlet: WebhookInlet, payload: unknown): Record<string, unknown> {
  if (!inlet.map) {
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { payload };
  }
  return Object.fromEntries(
    Object.entries(inlet.map).map(([field, path]) => [field, lookup(payload, path.split("."))]),
  );
}
