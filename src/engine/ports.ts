import type { Outlet } from "./flow-schema.ts";

// What the engine needs from Switch. The real implementation speaks the agent
// protocol; tests use an in-memory fake with scripted agents and people.
export interface Chat {
  // Posts as @yard and returns the message id (a thread root when top level).
  post(room: string, body: string, threadId?: string): Promise<string>;
  // Addresses one agent or person by handle inside a thread.
  sendTargeted(room: string, handle: string, body: string, threadId: string): Promise<void>;
  openApproval(card: ApprovalCard): Promise<void>;
  // Maps an approval's opaque `answered_by` to the person's @handle.
  handleOf(answeredBy: string): Promise<string | undefined>;
}

export interface ApprovalCard {
  requestId: string;
  room: string;
  threadId: string;
  title: string;
  detail: string;
  options: string[];
}

// Carries out an approved action outside Switch and returns a receipt line.
export interface Outlets {
  execute(outlet: Outlet, key: string): Promise<string>;
}

export interface InboundMessage {
  room: string;
  messageId: string;
  threadId?: string;
  sender: string;
  body: string;
  // True for a person (Switch sets sender_role only for claimed humans).
  fromPerson: boolean;
  // True when the message @mentions the receiving agent.
  addressed?: boolean;
}

export interface ApprovalOutcome {
  requestId: string;
  answer: string;
  answeredBy: string;
}
