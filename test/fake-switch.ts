import type { ApprovalCard, Chat, InboundMessage, Outlets, RoomDocument } from "../src/engine/ports.ts";
import type { Outlet } from "../src/engine/flow-schema.ts";

type Agent = (request: string) => string;

// An in-memory Switch: records what @yard posts, and lets scripted agents
// answer targeted messages. Replies are queued, not delivered, so a test
// decides when they arrive (`deliver`).
export class FakeSwitch implements Chat {
  readonly posts: { room: string; body: string; threadId?: string }[] = [];
  readonly cards: ApprovalCard[] = [];
  readonly inbox: InboundMessage[] = [];
  private readonly agents = new Map<string, Agent>();
  readonly docs = new Map<string, RoomDocument[]>();
  private nextId = 1;

  agent(handle: string, reply: Agent): this {
    this.agents.set(handle, reply);
    return this;
  }

  doc(room: string, name: string, content: string): this {
    this.docs.set(room, [...(this.docs.get(room) ?? []), { id: `d-${name}`, name, content }]);
    return this;
  }

  async documents(room: string): Promise<RoomDocument[]> {
    return this.docs.get(room) ?? [];
  }

  async updateDocument(room: string, id: string, content: string): Promise<void> {
    const doc = this.docs.get(room)?.find((d) => d.id === id);
    if (doc) doc.content = content;
  }

  async createDocument(room: string, doc: Omit<RoomDocument, "id">): Promise<string> {
    this.doc(room, doc.name, doc.content);
    return `d-${doc.name}`;
  }

  async post(room: string, body: string, threadId?: string): Promise<string> {
    this.posts.push({ room, body, threadId });
    return `m${this.nextId++}`;
  }

  async sendTargeted(room: string, handle: string, body: string, threadId: string): Promise<void> {
    const reply = this.agents.get(handle);
    if (!reply) return;
    this.inbox.push({ room, threadId, sender: handle, body: reply(body), messageId: `m${this.nextId++}`, fromPerson: false });
  }

  async openApproval(card: ApprovalCard): Promise<void> {
    this.cards.push(card);
  }

  // Answered-by ids look like "mx:@handle" here; anything else is unknown.
  async handleOf(answeredBy: string): Promise<string | undefined> {
    return answeredBy.startsWith("mx:") ? answeredBy.slice(3) : undefined;
  }

  // Hands queued replies to the engine until no agent has anything left to say.
  async deliver(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    while (this.inbox.length > 0) await onMessage(this.inbox.shift()!);
  }

  said(text: string): boolean {
    return this.posts.some((p) => p.body.includes(text));
  }
}

export class RecordingOutlets implements Outlets {
  readonly executed: { outlet: Outlet; key: string }[] = [];
  get payments() {
    return this.executed.filter((e) => "pay" in e.outlet);
  }

  async execute(outlet: Outlet, key: string): Promise<string> {
    this.executed.push({ outlet, key });
    return `executed ${key}`;
  }
}

// A scripted agent reply: some prose, then the contract block echoing the token.
export function replyWith(fields: Record<string, unknown>): Agent {
  return (request) => {
    const token = /"token": "([^"]+)"/.exec(request)![1];
    return `Checked it.\n\n\`\`\`json\n${JSON.stringify({ token, ...fields })}\n\`\`\``;
  };
}
