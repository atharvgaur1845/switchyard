import nodemailer, { type Transporter } from "nodemailer";
import type { Outlet } from "../engine/flow-schema.ts";
import type { Chat, Outlets } from "../engine/ports.ts";
import type { Store } from "../engine/store.ts";
import { appendCsv } from "./csv.ts";

export interface OutletConfig {
  dataDir: string;
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

  async execute(outlet: Outlet, key: string): Promise<string> {
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

    await this.chat.post(outlet.post.room, outlet.post.body);
    return `posted to ${outlet.post.room}`;
  }
}
