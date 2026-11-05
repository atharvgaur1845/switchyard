import nodemailer, { type Transporter } from "nodemailer";
import type { Outlet } from "../engine/flow-schema.ts";
import type { Chat, OutletResult, Outlets } from "../engine/ports.ts";
import { setTableRow } from "../engine/verifiers.ts";
import { hashOutlet } from "./payload.ts";
import type { Store } from "../engine/store.ts";
import { appendCsv } from "./csv.ts";

export interface OutletConfig {
  dataDir: string;
  bankUrl?: string;
  smtp: { host: string; port: number; from: string; user?: string; pass?: string };
}

// The only code in Switchyard that acts outside Switch. The runner calls it
// with a payload that was approved (or matched an auto_approve rule) and
// whose hash it has just re-checked.
export class LiveOutlets implements Outlets {
  private readonly config: OutletConfig;
  private readonly chat: Chat;
  private readonly mailer: Transporter;
  private readonly store: Store;

  constructor(config: OutletConfig, chat: Chat, store: Store) {
    this.config = config;
    this.chat = chat;
    this.store = store;
    const { host, port, user, pass } = config.smtp;
    this.mailer = nodemailer.createTransport({ host, port, auth: user ? { user, pass } : undefined });
  }

  async execute(outlet: Outlet, key: string): Promise<OutletResult> {
    if ("csv" in outlet) return appendCsv(this.config.dataDir, outlet.csv.file, outlet.csv.row, key);

    if ("email" in outlet) {
      const { to, subject, body } = outlet.email;
      // The key as Message-ID makes a resend after a crash recognisable.
      const info = await this.mailer.sendMail({
        from: this.config.smtp.from,
        to,
        subject,
        text: body,
        messageId: `<${key.replace("/", ".")}@switchyard>`,
      });
      return `emailed ${to} (${info.messageId})`;
    }

    if ("webhook" in outlet) {
      const response = await fetch(outlet.webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(outlet.webhook.body),
      });
      if (!response.ok) throw new Error(`webhook ${outlet.webhook.url} answered ${response.status}`);
      return `posted to ${new URL(outlet.webhook.url).host} (${response.status})`;
    }

    if ("visitor" in outlet) {
      const caseId = key.split("/")[0];
      this.store.addVisitorReply(key, caseId, outlet.visitor.body);
      return "replied to the visitor";
    }

    if ("document" in outlet) {
      const { room, name, row } = outlet.document;
      if (!this.chat.documents || !this.chat.updateDocument) throw new Error("this Switch connection cannot change room documents");
      const doc = (await this.chat.documents(room)).find((d) => d.name === name);
      if (!doc) throw new Error(`no document "${name}" in ${room}`);
      await this.chat.updateDocument(room, doc.id, setTableRow(doc.content, row));
      return `set ${row[0]}'s row in ${name}`;
    }

    if ("pay" in outlet) return this.pay(outlet.pay, key);

    await this.chat.post(outlet.post.room, outlet.post.body);
    return `posted to ${outlet.post.room}`;
  }

  // Pays through the sandbox bank, then reads the payment back by its key and
  // hashes what the bank holds, so the receipt can show it equals the
  // approved action. A retry after a crash sends the same key: the bank
  // returns the payment it already made instead of paying again.
  private async pay(pay: Extract<Outlet, { pay: unknown }>["pay"], key: string): Promise<OutletResult> {
    const bank = this.config.bankUrl ?? "http://localhost:4300";
    const sent = await fetch(`${bank}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(pay),
    });
    if (!sent.ok) throw new Error(`the bank refused the payment: ${sent.status} ${await sent.text()}`);
    const back = await fetch(`${bank}/payments/${encodeURIComponent(key)}`);
    if (!back.ok) throw new Error(`the bank cannot find payment ${key} after accepting it (${back.status})`);
    const held = (await back.json()) as Record<string, string>;
    const readback = hashOutlet({ pay: { payee: held.payee, to: held.to, amount: held.amount, currency: held.currency, reference: held.reference } });
    return { receipt: `paid ${held.amount} ${held.currency} to ${held.payee} (sandbox bank ${held.id})`, readback };
  }
}
