import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A Switch server reduced to the agent-protocol routes @yard uses, speaking
// the real wire format: SSE frames with ids, heartbeats, ops with a
// connection header, and approval cards answered through polling.
export class FakeSwitchHttp {
  readonly posts: { room: string; body: string; thread_id?: string }[] = [];
  readonly cards: Record<string, unknown>[] = [];
  readonly beats = new Set<string>();
  private readonly streams = new Map<string, { res: ServerResponse; room: string }>();
  private readonly outcomes: Record<string, unknown>[] = [];
  private readonly agents = new Map<string, (request: string) => string>();
  private seq = 0;
  private server!: Server;
  readonly participants = [
    { id: "u-1", name: "manager", type: "user" },
    { name: "policy", type: "agent" },
  ];

  agent(name: string, reply: (request: string) => string): this {
    this.agents.set(name, reply);
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://fake");
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => resolve(data));
      });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== "Bearer key-1" && url.pathname !== "/health") return json(401, {});

      if (url.pathname === "/health") return json(200, { ok: true });

      if (url.pathname === "/agents/yard-1/events") {
        const id = url.searchParams.get("connection_id")!;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: connection_state\ndata: ${JSON.stringify({ generation: 1 })}\n\n`);
        this.streams.set(id, { res, room: url.searchParams.get("rooms")! });
        return;
      }

      if (url.pathname === "/agents/yard-1/connection/beat") {
        const { connection_id } = JSON.parse(body);
        this.beats.add(connection_id);
        return json(this.streams.has(connection_id) ? 200 : 404, { ok: true });
      }

      const op = /^\/agents\/yard-1\/ops\/(\w+)$/.exec(url.pathname)?.[1];
      if (op) {
        const stream = this.streams.get(String(req.headers["x-switch-connection-id"]));
        if (!stream) return json(409, { detail: "connection is not live" });
        const args = JSON.parse(body);
        if (op === "post_message") {
          const eventId = `ev-${++this.seq}`;
          this.posts.push({ room: stream.room, body: args.body, thread_id: args.thread_id });
          return json(200, { result: { event_id: eventId } });
        }
        if (op === "send_targeted_message") {
          const [target] = args.target_names;
          const reply = this.agents.get(target);
          if (reply) {
            setTimeout(() => this.emit(stream.room, target, reply(args.body), args.thread_id), 10);
          }
          return json(200, { result: { event_id: `ev-${++this.seq}`, target_statuses: { [target]: reply ? "live" : "no_session" } } });
        }
        if (op === "list_participants") return json(200, { result: this.participants });
        return json(404, { detail: `unknown op ${op}` });
      }

      const approval = /^\/agent-sessions\/([^/]+)\/approvals(?:\/([^/]+)\/delivered)?$/.exec(url.pathname);
      if (approval && req.method === "POST" && !approval[2]) {
        this.cards.push({ session_id: approval[1], ...JSON.parse(body) });
        return json(200, { ok: true });
      }
      if (approval?.[2]) {
        const outcome = this.outcomes.find((o) => o.requestId === approval[2]);
        if (outcome) outcome.deliveredAt = new Date().toISOString();
        return json(200, { ok: true });
      }
      if (url.pathname === "/agent-sessions/approvals/outcomes") {
        return json(200, this.outcomes.filter((o) => !o.deliveredAt));
      }
      json(404, { detail: "not found" });
    });
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  // A person presses a button on a card.
  answer(requestId: string, answer: string, answeredBy: string): void {
    const card = this.cards.find((c) => c.request_id === requestId)!;
    this.outcomes.push({ sessionId: card.session_id, requestId, answer, answeredBy, deliveredAt: null });
  }

  private emit(room: string, sender: string, body: string, threadId: string | null): void {
    const sequence = ++this.seq;
    const frame = {
      type: "message",
      room_id: room,
      sequence,
      payload: { addressed: true, sender: `@switch-agent-${sender}:localhost`, sender_name: sender, message_id: `ev-${sequence}`, body, thread_id: threadId },
    };
    for (const stream of this.streams.values()) {
      if (stream.room === room) stream.res.write(`id: ${sequence}\nevent: message\ndata: ${JSON.stringify(frame)}\n\n`);
    }
  }

  async stop(): Promise<void> {
    for (const { res } of this.streams.values()) res.end();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
