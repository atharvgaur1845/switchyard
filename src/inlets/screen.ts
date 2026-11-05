// A deterministic first look at text from outside the company. It does not
// decide anything on its own; it sets `case.flagged`, which flows use to
// keep a person in the loop (e.g. `auto_approve: ... and case.flagged == false`).
// The agent's own judgement is the second layer, never the only one.

const PATTERNS: [string, RegExp][] = [
  ["instruction override", /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|your|all)\b.{0,20}\b(instructions?|rules?|prompts?)\b/i],
  ["role play", /\b(you are now|act as|pretend to be|new instructions?)\b/i],
  ["system prompt probe", /\b(system prompt|developer message|hidden instructions?)\b/i],
  ["money request", /\b(refund|discount|credit|wire|transfer|gift card)\b.{0,40}\b(now|immediately|approve|issue|send)\b/i],
  ["impersonation", /\b(i am|this is)\b.{0,20}\b(the )?(ceo|admin|administrator|owner|manager)\b/i],
  ["markup injection", /<\/?(untrusted-data|system|assistant)>|```/i],
];

export function screen(text: string): { flagged: boolean; flags: string[] } {
  const flags = PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { flagged: flags.length > 0, flags };
}
