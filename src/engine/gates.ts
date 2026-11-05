import type { GateStep } from "./flow-schema.ts";

// switchyard.yaml `people:` maps a role a flow names (@manager) to the
// people who fill it. A role nobody mapped is taken as a person's handle.
export type People = Record<string, string[]>;

export function fills(people: People, role: string, handle: string): boolean {
  return handle === role || (people[role] ?? []).includes(handle);
}

// Who to @mention for a role: the people filling it, or the role itself.
export function mention(people: People, role: string): string {
  return (people[role] ?? [role]).join(" ");
}

// The first option of a gate is the one that authorizes its outlets ("approve",
// "send", "pay"). Any other answer is recorded but authorizes nothing.
export function isApproval(gate: GateStep["gate"], answer: string): boolean {
  return answer === gate.options[0];
}

// A Switch approval card can be answered by anyone the room admits, so the
// engine decides whose answer counts.
//
//   gate       the gate's approver, optional backup and options
//   answerer   the @handle of the person who clicked, or undefined when
//              Switch's opaque id could not be mapped to anyone in the room
//   escalated  true once the deadline passed and the card went to the backup
//   people     role handles (@manager) to the real handles that fill them
//
// Returns true when this person's answer should decide the gate. When false,
// the runner tells the room who may answer and re-opens the card.
export function mayAnswer(
  gate: GateStep["gate"],
  answerer: string | undefined,
  escalated: boolean,
  people: People = {},
): boolean {
  if (answerer === undefined) return false;
  // The approver keeps the decision after escalation: being late should not
  // lock them out. The backup only decides once the deadline has passed.
  if (fills(people, gate.approver, answerer)) return true;
  return escalated && gate.backup !== undefined && fills(people, gate.backup, answerer);
}
