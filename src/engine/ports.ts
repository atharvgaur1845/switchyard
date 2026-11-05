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
  // The room's documents (business rules, price lists, policies) as they
  // are in Switch right now. Optional: without it, steps that need
  // documents stop and hand the case to a person.
  documents?(room: string): Promise<RoomDocument[]>;
  updateDocument?(room: string, id: string, content: string): Promise<void>;
  createDocument?(room: string, doc: Omit<RoomDocument, "id">): Promise<string>;
}

export interface RoomDocument {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  content: string;
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
