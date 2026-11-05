import { createHash, randomUUID } from "node:crypto";
import type { ApprovalCard, ApprovalOutcome, Chat, InboundMessage, RoomDocument } from "../engine/ports.ts";
import { SseParser } from "./sse.ts";

// Speaks the Switch agent protocol as @yard: server-sent events in, HTTP out
// (docs/official/internals/agent-protocol.md in the Switch repository).
//
// @yard keeps one connection per room. A connection that has claimed a room
// is what `post_message` and `send_targeted_message` act in, so every room a
// flow lives in gets its own stream, heartbeat and claim.

export interface SwitchConfig {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  // Flow room names to Switch room ids.
  rooms: Record<string, string>;
}

type Listener = (message: InboundMessage) => void | Promise<void>;
type ApprovalListener = (outcome: ApprovalOutcome) => void | Promise<void>;

const HEARTBEAT_MS = 2_000;
const OUTCOME_POLL_MS = 2_000;
const RECONNECT_MS = 3_000;

export class SwitchHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class SwitchClient implements Chat {
  private readonly config: SwitchConfig;
  private readonly connections = new Map<string, RoomConnection>();
  private readonly listeners: Listener[] = [];
  private readonly approvalListeners: ApprovalListener[] = [];
  // Switch groups cards under a session id. It is derived from the agent id
  // so that it survives restarts: an answer to a card opened before a crash
  // is still found and delivered after it.
  private readonly sessionId: string;
  private outcomeTimer?: NodeJS.Timeout;

  constructor(config: SwitchConfig) {
    this.config = config;
    this.sessionId = stableUuid(`switchyard:${config.agentId}`);
  }

  onMessage(listener: Listener): void {
    this.listeners.push(listener);
  }

  onApproval(listener: ApprovalListener): void {
    this.approvalListeners.push(listener);
  }

  async start(): Promise<void> {
    await this.request("GET", "/health", undefined, { auth: false });
    for (const [name, roomId] of Object.entries(this.config.rooms)) {
      const connection = new RoomConnection(this, name, roomId, (m) => this.dispatch(m));
      this.connections.set(name, connection);
      await connection.open();
    }
    this.outcomeTimer = setInterval(() => void this.pollOutcomes(), OUTCOME_POLL_MS);
  }

  stop(): void {
    clearInterval(this.outcomeTimer);
    for (const connection of this.connections.values()) connection.close();
  }

  async post(room: string, body: string, threadId?: string): Promise<string> {
    const result = await this.connection(room).op<{ event_id: string }>("post_message", {
      body,
      ...(threadId ? { thread_id: threadId } : {}),
    });
    return result.event_id;
  }

  async sendTargeted(room: string, handle: string, body: string, threadId: string): Promise<void> {
    const result = await this.connection(room).op<{ target_statuses?: Record<string, string> }>(
      "send_targeted_message",
      { body, target_names: [handle.replace(/^@/, "")], thread_id: threadId },
    );
    const status = Object.values(result.target_statuses ?? {})[0];
    if (status === "not_permitted" || status === "no_session") {
      // The engine's SLA timer moves the step to the bench agent; say why.
      console.warn(`[switchyard] ${handle} in ${room}: ${status}`);
    }
  }

  async openApproval(card: ApprovalCard): Promise<void> {
    await this.request("POST", `/agent-sessions/${this.sessionId}/approvals`, {
      request_id: card.requestId,
      turn_id: card.requestId,
      kind: "approval",
      title: card.title,
      detail: card.detail,
      options: card.options.map((option, i) => ({
        id: option,
        label: option,
        // Switch draws the first option as the accepting one.
        decision: i === 0 ? "accept" : "decline",
      })),
      questions: [],
      room_id: this.roomId(card.room),
      thread_id: card.threadId,
      expires_at: null,
    });
  }

  // Room documents live in Switch. The list has no content, so each read is
  // a list plus one load: always the current text, never a cached copy.
  async documents(room: string): Promise<RoomDocument[]> {
    const connection = this.connection(room);
    const detail = await connection.op<{ documents?: { id: string; name: string; description?: string; instructions?: string }[] }>(
      "connect_to_room",
      { room_id: this.roomId(room), include_general_instructions: false },
    );
    const listed = detail.documents ?? [];
    if (listed.length === 0) return [];
    const loaded = await connection.op<{ id: string; content: string }[]>("load_internal_documents", { ids: listed.map((d) => d.id) });
    const content = new Map(loaded.map((d) => [d.id, d.content]));
    return listed.map((d) => ({ ...d, content: content.get(d.id) ?? "" }));
  }

  async updateDocument(room: string, id: string, content: string): Promise<void> {
    await this.connection(room).op("update_room_document", { document_id: id, content });
  }

  async createDocument(room: string, doc: Omit<RoomDocument, "id">): Promise<string> {
    const created = await this.connection(room).op<{ document_id: string }>("create_room_document", {
      name: doc.name,
      description: doc.description ?? "",
      instructions: doc.instructions ?? "",
      content: doc.content,
    });
    return created.document_id;
  }

  // Switch reports who answered as an internal id. A person from a chat app
  // is `@switch-<platform>-<bridge>-<username>[-<digest>]:<server>`, built
  // from their username the way core does it (collaboration_core.py), so the
  // room's participant list maps it back to the @handle a flow names.
  async handleOf(answeredBy: string): Promise<string | undefined> {
    for (const connection of this.connections.values()) {
      const participants = await connection.op<Participant[]>("list_participants", {});
      const match = whoAnswered(answeredBy, participants);
      if (match) return `@${match.name.toLowerCase()}`;
    }
    return undefined;
  }

  private async pollOutcomes(): Promise<void> {
    try {
      const outcomes = await this.request<ApprovalView[]>("GET", "/agent-sessions/approvals/outcomes");
      for (const view of outcomes) {
        if (view.sessionId !== this.sessionId || view.answer == null || !view.answeredBy) continue;
        // Handled first, acknowledged second: if Switchyard stops in between,
        // Switch offers the answer again, and the engine ignores answers to
        // cards that are no longer open.
        const outcome = { requestId: view.requestId, answer: view.answer, answeredBy: view.answeredBy };
        for (const listener of this.approvalListeners) await listener(outcome);
        await this.request(
          "POST",
          `/agent-sessions/${view.sessionId}/approvals/${view.requestId}/delivered`,
        );
      }
    } catch (error) {
      console.warn(`[switchyard] polling approvals failed: ${(error as Error).message}`);
    }
  }

  private async dispatch(message: InboundMessage): Promise<void> {
    for (const listener of this.listeners) await listener(message);
  }

  private connection(room: string): RoomConnection {
    const connection = this.connections.get(room);
    if (!connection) throw new Error(`room "${room}" is not in the Switchyard config`);
    return connection;
  }

  private roomId(room: string): string {
    const id = this.config.rooms[room];
    if (!id) throw new Error(`room "${room}" is not in the Switchyard config`);
    return id;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { auth?: boolean; connectionId?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.config.apiKey}`;
    if (options.connectionId) headers["X-Switch-Connection-Id"] = options.connectionId;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(new URL(path, this.config.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new SwitchHttpError(response.status, `${method} ${path}: ${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  streamUrl(connectionId: string, roomId: string): URL {
    const url = new URL(`/agents/${this.config.agentId}/events`, this.config.baseUrl);
    url.search = new URLSearchParams({
      connection_id: connectionId,
      scope: "single",
      filter: "all",
      rooms: roomId,
      start_from: "head",
      client: "switchyard",
    }).toString();
    return url;
  }

  get agentId(): string {
    return this.config.agentId;
  }

  get apiKey(): string {
    return this.config.apiKey;
  }
}

// A UUID-shaped id that is always the same for the same input.
function stableUuid(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// The id ends in a sanitized username, so "x-bob" also ends in "-bob": the
// longest matching name is the one that answered.
export function whoAnswered<P extends { id: string; name: string; type: string }>(answeredBy: string, participants: P[]): P | undefined {
  const localpart = /^@(switch-[^:]+):/.exec(answeredBy)?.[1];
  return participants
    .filter((p) => p.type === "user" && (answeredBy === `user:${p.id}` || (localpart !== undefined && personIdMatches(localpart, p.name))))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

export function personIdMatches(localpart: string, username: string): boolean {
  const sanitized = username.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return new RegExp(`-${escapeRegExp(sanitized)}(-[0-9a-f]{8})?$`).test(localpart);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Participant {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

interface ApprovalView {
  sessionId: string;
  requestId: string;
  answer: string | null;
  answeredBy: string | null;
}

interface MessagePayload {
  // The sender's internal room id (`@switch-agent-…:localhost`); the handle
  // people and flows use is `sender_name`.
  sender: string;
  sender_name: string;
  body: string;
  message_id: string;
  thread_id: string | null;
  sender_role: string | null;
  addressed: boolean;
}

// One room's stream: opens it with the room claimed, beats every two seconds,
// and reopens from the last event id when the stream drops or a beat is refused.
class RoomConnection {
  private readonly id = randomUUID();
  private lastEventId?: string;
  private generation: number | null = null;
  private beat?: NodeJS.Timeout;
  private abort?: AbortController;
  private closed = false;
  private readonly client: SwitchClient;
  private readonly name: string;
  private readonly roomId: string;
  private readonly deliver: Listener;

  constructor(client: SwitchClient, name: string, roomId: string, deliver: Listener) {
    this.client = client;
    this.name = name;
    this.roomId = roomId;
    this.deliver = deliver;
  }

  async open(): Promise<void> {
    this.abort = new AbortController();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.client.apiKey}`,
      Accept: "text/event-stream",
    };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

    const response = await fetch(this.client.streamUrl(this.id, this.roomId), {
      headers,
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) {
      throw new SwitchHttpError(response.status, `stream for ${this.name}: ${response.status} ${await response.text()}`);
    }
    void this.read(response.body);
    clearInterval(this.beat);
    this.beat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
  }

  op<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.client
      .request<{ result: T }>("POST", `/agents/${this.client.agentId}/ops/${name}`, args, { connectionId: this.id })
      .then((response) => response.result);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.beat);
    this.abort?.abort();
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
          await this.handle(frame.event, frame.data, frame.id);
        }
      }
    } catch (error) {
      if (this.closed) return;
      console.warn(`[switchyard] stream for ${this.name} broke: ${(error as Error).message}`);
    }
    this.reconnect();
  }

  private async handle(event: string, data: string, id?: string): Promise<void> {
    if (id) this.lastEventId = id;
    if (process.env.SWITCHYARD_DEBUG) console.log(`[switchyard:${this.client.agentId.slice(0, 8)}] ${event} ${data.slice(0, 400)}`);
    const frame = JSON.parse(data);
    if (event === "connection_state") {
      this.generation = frame.generation ?? null;
    } else if (event === "evicted") {
      this.reconnect();
    } else if (event === "message") {
      const payload = frame.payload as MessagePayload;
      await this.deliver({
        room: this.name,
        messageId: payload.message_id,
        threadId: payload.thread_id ?? undefined,
        sender: `@${payload.sender_name.toLowerCase()}`,
        body: payload.body,
        fromPerson: payload.sender_role != null,
        addressed: payload.addressed,
      });
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.client.request("POST", `/agents/${this.client.agentId}/connection/beat`, {
        connection_id: this.id,
        generation: this.generation,
      });
    } catch (error) {
      // A refused beat means the server dropped this connection: reopen it.
      if (error instanceof SwitchHttpError && (error.status === 404 || error.status === 409)) this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    clearInterval(this.beat);
    this.abort?.abort();
    setTimeout(() => {
      this.open().catch((error) => {
        console.warn(`[switchyard] reopening ${this.name} failed: ${(error as Error).message}`);
        this.reconnect();
      });
    }, RECONNECT_MS);
  }
}
