import { DatabaseSync } from "node:sqlite";
import { normalizeName } from "./verifiers.ts";

// Everything that happens to a case is one row in an append-only log. The
// state of a case is never stored: it is rebuilt by folding its events, so
// after a crash the engine knows exactly what it had done and what it hadn't.

export type CaseEvent =
  // `key` identifies the delivery that opened it (e.g. a webhook body's
  // hash), so the same delivery sent twice opens one case.
  | { type: "opened"; flow: string; room: string; data: Record<string, unknown>; source?: string; key?: string; once?: string }
  | { type: "thread"; threadId: string }
  | { type: "skipped"; step: string }
  // `attempt` counts every request for the step (it makes tokens unique);
  // `tries` counts this agent's requests, so a bench agent starts fresh.
  | {
      type: "asked";
      step: string;
      agent: string;
      token: string;
      attempt: number;
      tries?: number;
      at: number;
      parallel?: boolean;
      // Room document name -> hash of its content when the agent was asked:
      // which version of the rules a verdict was based on.
      docs?: Record<string, string>;
    }
  | { type: "verified"; step: string; check: string; value: unknown; docs?: Record<string, string>; rows?: Record<string, string> }
  | { type: "fanned_out"; step: string; agents: string[]; at: number }
  | { type: "partial"; step: string; agent: string; value: unknown }
  | { type: "failed_over"; step: string; from: string; to: string; reason: string }
  | { type: "reply_rejected"; step: string; error: string }
  | { type: "answered"; step: string; value: unknown }
  | {
      type: "gate_opened";
      step: string;
      requestId: string;
      approver: string;
      hashes: Record<string, string>;
      // The exact rendered actions the card shows, so anyone can recompute the hashes.
      payloads?: Record<string, unknown>;
      at: number;
    }
  | { type: "reminded"; step: string }
  | { type: "card_reopened"; step: string; requestId: string }
  | { type: "escalated"; step: string; requestId: string; to?: string }
  | { type: "gate_answered"; step: string; answer: string; answeredBy: string; approved: boolean }
  // Written just before an outlet acts outside Switch, and `executed` just
  // after. One without the other means the process stopped in between, and
  // nobody knows whether the action happened: the case is "in doubt".
  | { type: "executing"; step: string; hash: string; payload: unknown }
  | { type: "executed"; step: string; hash: string; receipt: string; payload?: unknown; readback?: string }
  // A room document a check read changed before an action ran. The listed
  // steps are run again, from the check on, with the new version.
  | { type: "rewound"; step: string; steps: string[]; docs: Record<string, [string, string]> }
  | { type: "in_doubt"; step: string; requestId: string; hash: string; at: number }
  | { type: "doubt_resolved"; step: string; answer: string; answeredBy: string }
  | { type: "failed"; step: string; reason: string }
  | { type: "cancelled"; by: string }
  | { type: "waiting"; step: string; until: number; at?: number }
  | { type: "waited"; step: string; by?: string }
  | { type: "done" };

// What a case is waiting on. `at` is when the wait began (epoch ms), which the
// deadline timers measure from.
export type Pending =
  | { kind: "in_doubt"; step: string; requestIds: string[]; hash: string; at: number }
  | {
      kind: "parallel";
      step: string;
      at: number;
      // Each agent's outstanding request, and its answer once it is in.
      agents: Record<string, { token: string; attempt: number; tries: number; value?: unknown }>;
    }
  | { kind: "wait"; step: string; until: number; at: number }
  | { kind: "agent"; step: string; agent: string; token: string; attempt: number; tries: number; at: number }
  | {
      kind: "gate";
      step: string;
      // The first card, then one more per escalation; any of them may answer.
      requestIds: string[];
      hashes: Record<string, string>;
      at: number;
      reminded: boolean;
      escalated: boolean;
    };

export interface CaseState {
  id: string;
  flow: string;
  room: string;
  threadId?: string;
  data: Record<string, unknown>;
  results: Record<string, unknown>;
  // Outlet step id -> the payload hash a human approved for it.
  approved: Record<string, { hash: string; by: string; gate: string }>;
  finished: Set<string>;
  // Outlets that started and never recorded finishing (see `executing`).
  executing: Record<string, { hash: string; payload: unknown }>;
  // Room document -> the version a check read, and which check: what every
  // later decision in the case rests on.
  basis: Record<string, { hash: string; step: string; row?: string }>;
  // Room documents this case itself changed (a document outlet ran).
  wrote: Set<string>;
  // Gate id -> who answered it, for {by.<gate>} in later steps.
  deciders: Record<string, string>;
  pending?: Pending;
  status: "open" | "done" | "failed" | "cancelled";
}

export function fold(id: string, events: CaseEvent[]): CaseState {
  const state: CaseState = {
    id,
    flow: "",
    room: "",
    data: {},
    results: {},
    approved: {},
    finished: new Set(),
    executing: {},
    basis: {},
    wrote: new Set(),
    deciders: {},
    status: "open",
  };
  for (const event of events) {
    switch (event.type) {
      case "opened":
        Object.assign(state, { flow: event.flow, room: event.room, data: event.data });
        break;
      case "thread":
        state.threadId = event.threadId;
        break;
      case "skipped":
        state.finished.add(event.step);
        break;
      case "asked":
        if (event.parallel && state.pending?.kind === "parallel") {
          state.pending.agents[event.agent] = { token: event.token, attempt: event.attempt, tries: event.tries ?? 1 };
        } else {
          state.pending = { kind: "agent", ...event, tries: event.tries ?? event.attempt };
        }
        break;
      case "verified":
        state.results[event.step] = event.value;
        state.finished.add(event.step);
        for (const [doc, hash] of Object.entries(event.docs ?? {})) state.basis[doc] = { hash, step: event.step, row: event.rows?.[doc] };
        break;
      case "rewound":
        for (const step of event.steps) {
          state.finished.delete(step);
          delete state.results[step];
          delete state.deciders[step];
        }
        // Approvals are kept by outlet; drop every one a rewound gate gave.
        for (const [outlet, a] of Object.entries(state.approved)) if (event.steps.includes(a.gate)) delete state.approved[outlet];
        for (const [doc, b] of Object.entries(state.basis)) if (event.steps.includes(b.step)) delete state.basis[doc];
        state.pending = undefined;
        break;
      case "fanned_out":
        state.pending = { kind: "parallel", step: event.step, at: event.at, agents: {} };
        break;
      case "partial":
        if (state.pending?.kind === "parallel" && state.pending.agents[event.agent]) {
          state.pending.agents[event.agent].value = event.value;
        }
        break;
      case "failed_over":
        break;
      case "reply_rejected":
        break;
      case "answered":
        state.results[event.step] = event.value;
        state.finished.add(event.step);
        state.pending = undefined;
        break;
      case "gate_opened":
        state.pending = {
          kind: "gate",
          step: event.step,
          requestIds: [event.requestId],
          hashes: event.hashes,
          at: event.at,
          reminded: false,
          escalated: false,
        };
        break;
      case "card_reopened":
        if (state.pending?.kind === "gate" || state.pending?.kind === "in_doubt") state.pending.requestIds.push(event.requestId);
        break;
      case "reminded":
        if (state.pending?.kind === "gate") state.pending.reminded = true;
        break;
      case "escalated":
        if (state.pending?.kind === "gate") {
          state.pending.escalated = true;
          state.pending.requestIds.push(event.requestId);
        }
        break;
      case "gate_answered": {
        state.results[event.step] = event.answer;
        state.deciders[event.step] = event.answeredBy;
        state.finished.add(event.step);
        const gate = state.pending;
        if (event.approved && gate?.kind === "gate") {
          for (const [outlet, hash] of Object.entries(gate.hashes)) {
            state.approved[outlet] = { hash, by: event.answeredBy, gate: event.step };
          }
        }
        state.pending = undefined;
        break;
      }
      case "executing":
        state.executing[event.step] = { hash: event.hash, payload: event.payload };
        break;
      case "executed":
        state.results[event.step] = { receipt: event.receipt, hash: event.hash };
        state.finished.add(event.step);
        delete state.executing[event.step];
        state.pending = undefined;
        if (event.payload && typeof event.payload === "object" && "document" in event.payload) {
          state.wrote.add((event.payload as { document: { name: string } }).document.name);
        }
        break;
      case "in_doubt":
        state.pending = { kind: "in_doubt", step: event.step, requestIds: [event.requestId], hash: event.hash, at: event.at };
        break;
      case "doubt_resolved":
        state.pending = undefined;
        break;
      case "failed":
        state.status = "failed";
        state.pending = undefined;
        break;
      case "waiting":
        state.pending = { kind: "wait", step: event.step, until: event.until, at: event.at ?? event.until };
        break;
      case "waited":
        state.finished.add(event.step);
        state.pending = undefined;
        break;
      case "done":
        state.status = "done";
        break;
      case "cancelled":
        state.status = "cancelled";
        state.pending = undefined;
        break;
    }
  }
  return state;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL,
        at      TEXT NOT NULL,
        body    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_case ON events (case_id, seq);
      CREATE TABLE IF NOT EXISTS marks (key TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attested (
        room TEXT NOT NULL,
        doc  TEXT NOT NULL,
        row  TEXT NOT NULL,
        hash TEXT NOT NULL,
        by   TEXT NOT NULL,
        at   TEXT NOT NULL,
        PRIMARY KEY (room, doc, row)
      );
      CREATE TABLE IF NOT EXISTS visitor_replies (
        key     TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        at      TEXT NOT NULL,
        body    TEXT NOT NULL
      );
    `);
  }

  append(caseId: string, event: CaseEvent, at = new Date()): void {
    this.db
      .prepare("INSERT INTO events (case_id, at, body) VALUES (?, ?, ?)")
      .run(caseId, at.toISOString(), JSON.stringify(event));
  }

  // Events with the time each was recorded, for timelines.
  timeline(caseId: string): (CaseEvent & { at_iso: string; seq: number })[] {
    return this.db
      .prepare("SELECT seq, at, body FROM events WHERE case_id = ? ORDER BY seq")
      .all(caseId)
      .map((row) => ({ ...(JSON.parse(row.body as string) as CaseEvent), at_iso: row.at as string, seq: Number(row.seq) }));
  }

  events(caseId: string): CaseEvent[] {
    return this.db
      .prepare("SELECT body FROM events WHERE case_id = ? ORDER BY seq")
      .all(caseId)
      .map((row) => JSON.parse(row.body as string) as CaseEvent);
  }

  load(caseId: string): CaseState {
    return fold(caseId, this.events(caseId));
  }

  caseIds(): string[] {
    return this.db
      .prepare("SELECT case_id FROM events GROUP BY case_id ORDER BY MIN(seq)")
      .all()
      .map((row) => row.case_id as string);
  }

  caseWithOnce(flow: string, once: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT case_id FROM events WHERE json_extract(body, '$.type') = 'opened' AND json_extract(body, '$.flow') = ? AND json_extract(body, '$.once') = ? LIMIT 1",
      )
      .get(flow, once);
    return row ? (row.case_id as string) : undefined;
  }

  caseWithKey(flow: string, key: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT case_id FROM events WHERE json_extract(body, '$.type') = 'opened' AND json_extract(body, '$.flow') = ? AND json_extract(body, '$.key') = ? LIMIT 1",
      )
      .get(flow, key);
    return row ? (row.case_id as string) : undefined;
  }

  openCases(): CaseState[] {
    return this.caseIds()
      .map((id) => this.load(id))
      .filter((state) => state.status === "open");
  }

  // Records that an inlet has handled something (an email id, a schedule
  // slot). Returns false when it was already marked, so a restart never opens
  // the same case twice.
  mark(key: string, at = new Date()): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO marks (key, at) VALUES (?, ?)").run(key, at.toISOString());
    return result.changes === 1;
  }

  // The last version of a row in a room document that Switchyard itself
  // wrote or first saw. A row that no longer matches was changed in the room
  // directly, outside any case. `row` is the row's first cell, normalised.
  attest(room: string, doc: string, row: string, hash: string, by: string, at = new Date()): void {
    this.db
      .prepare("INSERT OR REPLACE INTO attested (room, doc, row, hash, by, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(room, doc, normalizeName(row), hash, by, at.toISOString());
  }

  attestedRows(room: string, doc: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM attested WHERE room = ? AND doc = ?").get(room, doc) as { n: number }).n;
  }

  attestation(room: string, doc: string, row: string): { hash: string; by: string; at: string } | undefined {
    return this.db.prepare("SELECT hash, by, at FROM attested WHERE room = ? AND doc = ? AND row = ?").get(room, doc, normalizeName(row)) as
      | { hash: string; by: string; at: string }
      | undefined;
  }

  // Front-desk replies waiting for the visitor's widget to fetch them. The
  // outlet key makes a replayed outlet a no-op.
  addVisitorReply(key: string, caseId: string, body: string, at = new Date()): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO visitor_replies (key, case_id, at, body) VALUES (?, ?, ?, ?)")
      .run(key, caseId, at.toISOString(), body);
    return result.changes === 1;
  }

  visitorReplies(caseId: string): { at: string; body: string }[] {
    return this.db
      .prepare("SELECT at, body FROM visitor_replies WHERE case_id = ? ORDER BY at")
      .all(caseId)
      .map((row) => ({ at: row.at as string, body: row.body as string }));
  }

  close(): void {
    this.db.close();
  }
}
