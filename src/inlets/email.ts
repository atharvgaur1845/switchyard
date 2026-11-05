import type { Flow } from "../engine/flow-schema.ts";
import type { Runner } from "../engine/runner.ts";
import type { Store } from "../engine/store.ts";

// `inlet.email` in a flow:
//   email: { to: quotes@acme.test }
//
// Mail is read from Mailpit's HTTP API (https://mailpit.axllent.org), which
// is also where Switchyard's own outgoing mail lands in a local setup, so
// the whole loop runs without a real mail account.
export interface EmailInlet {
  to: string;
}

export function emailInlet(flow: Flow): EmailInlet | undefined {
  return flow.inlet?.email as EmailInlet | undefined;
}

interface MailpitSummary {
  ID: string;
  To: { Address: string }[];
}

interface MailpitMessage {
  ID: string;
  From: { Name: string; Address: string };
  Subject: string;
  Text: string;
  Date: string;
}

export class MailpitInbox {
  private readonly baseUrl: string;
  private readonly flows: { flow: Flow; inlet: EmailInlet }[];
  private readonly runner: Runner;
  private readonly store: Store;
  private timer?: NodeJS.Timeout;

  constructor(baseUrl: string, flows: Flow[], runner: Runner, store: Store) {
    this.baseUrl = baseUrl;
    this.runner = runner;
    this.store = store;
    this.flows = flows.flatMap((flow) => {
      const inlet = emailInlet(flow);
      return inlet ? [{ flow, inlet }] : [];
    });
  }

  start(intervalMs = 5_000): void {
    if (this.flows.length === 0) return;
    this.timer = setInterval(() => void this.poll().catch((e) => console.warn(`[switchyard] mail: ${e.message}`)), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // Opens one case per new message addressed to a flow's inbox.
  async poll(): Promise<number> {
    const { messages } = await this.get<{ messages: MailpitSummary[] }>("/api/v1/messages?limit=50");
    let opened = 0;
    for (const summary of messages.reverse()) {
      const to = summary.To.map((t) => t.Address.toLowerCase());
      const match = this.flows.find(({ inlet }) => to.includes(inlet.to.toLowerCase()));
      if (!match || !this.store.mark(`email:${summary.ID}`)) continue;

      const message = await this.get<MailpitMessage>(`/api/v1/message/${summary.ID}`);
      await this.runner.open(
        match.flow.flow,
        {
          from_name: message.From.Name,
          from: message.From.Address,
          subject: message.Subject,
          body: message.Text.slice(0, 20_000),
          received: message.Date,
        },
        `email from ${message.From.Address}`,
      );
      opened++;
    }
    return opened;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl));
    if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
    return (await response.json()) as T;
  }
}
