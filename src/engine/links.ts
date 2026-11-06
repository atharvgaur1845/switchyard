import { compactIban, ibanValid, sameName, tableRows } from "./verifiers.ts";

// Links between cases, found by code from what people already decided.
// A link never blocks and never changes an action: it sends the case to a
// person with the evidence, and an approval that rested on "no link" stops
// counting when one appears.

// A bank-change request a person blocked. Recorded only when it is good
// evidence (see `blockedAccount`), so an attacker cannot get a genuine
// account listed just by naming it in a look-alike email.
export interface Blocked {
  iban: string;
  caseId: string;
  vendor: string;
  sender: string;
  by: string;
  at: number;
  // "block": a person blocked the request. "callback": the supplier, called
  // on the number on file, said the account is not theirs.
  how?: "block" | "callback";
}

export interface Link {
  kind: "blocked" | "other-vendor";
  iban: string;
  // The account's role in this case: the one paid or requested, or one an
  // invoice printed (evidence only; it is never paid).
  role: "subject" | "printed";
  caseId?: string;
  // For a blocked link: the domain the blocked request came from.
  sender?: string;
  // For an other-vendor link: the vendor the account is on file for.
  owner?: string;
  detail: string;
}

const DAY = 86_400_000;
export const BLOCKED_WINDOW_DAYS = 180;

const mask = (iban: string) => (iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : iban);

// What a blocked bank-change case says about its account, or nothing when it
// is not safe to remember. `checks` is the bank_change result; `email` the
// email's text.
export function blockedAccount(
  checks: Record<string, unknown>,
  email: string,
  master: string,
  meta: { caseId: string; by: string; at: number; how?: "block" | "callback" },
): Blocked | undefined {
  const iban = compactIban(String(checks.new_iban ?? ""));
  const vendor = String(checks.vendor ?? "");
  const sender = String(checks.sender_domain ?? "");
  if (!ibanValid(iban) || !vendor) return undefined;
  // The account must be written in the email itself, not only in an agent's
  // reading of it (spaces and hyphens between groups are fine).
  if (!compactIban(email.replace(/-/g, "")).includes(iban)) return undefined;
  // An account on file for any vendor is never listed: a look-alike email
  // naming a vendor's real account must not get that account flagged.
  if (tableRows(master).some(([, , onFile = ""]) => compactIban(onFile) === iban)) return undefined;
  // A block of a request from the vendor's own domain (or a subdomain of it)
  // says nothing about the account; only a request from elsewhere does. A
  // failed callback does, from any sender: the supplier itself, on the phone
  // number on file, said the account is not theirs. That is how a
  // compromised mailbox is found out.
  const domain = String(checks.domain ?? "").toLowerCase();
  const how = meta.how ?? "block";
  // A From address the company's mail gateway called forged is not the
  // vendor's domain speaking, so that block is evidence too.
  const own = sender && domain && (sender.toLowerCase() === domain || sender.toLowerCase().endsWith(`.${domain}`));
  if (how === "block" && own && checks.forged !== true) return undefined;
  return { iban, caseId: meta.caseId, vendor, sender, by: meta.by, at: meta.at, how };
}

// The links for one case. `iban` is the account the case would pay or write;
// `printed` an account an invoice printed; `vendor` whom the case is for.
export function findLinks(args: { iban?: string; printed?: string; vendor?: string; caseId?: string }, master: string, blocked: Blocked[], now: number): Link[] {
  const links: Link[] = [];
  const recent = blocked.filter((b) => now - b.at <= BLOCKED_WINDOW_DAYS * DAY && b.caseId !== args.caseId);
  const vendor = args.vendor ?? "";
  const check = (raw: string | undefined, role: Link["role"]) => {
    const iban = compactIban(raw ?? "");
    if (!ibanValid(iban)) return;
    for (const b of recent.filter((b) => b.iban === iban)) {
      links.push({
        kind: "blocked",
        iban,
        role,
        caseId: b.caseId,
        sender: b.sender,
        detail: b.how === "callback"
          ? `${mask(iban)} was requested for ${b.vendor} from ${b.sender || "an unknown sender"}, and ${b.vendor}, called by ${b.by} on the number on file, said it is not their account (case ${b.caseId})`
          : `${mask(iban)} was requested for ${b.vendor} from ${b.sender || "an unknown sender"}, and ${b.by} blocked that request (case ${b.caseId})`,
      });
    }
    for (const [other = "", , onFile = ""] of tableRows(master)) {
      if (compactIban(onFile) === iban && vendor && !sameName(other, vendor)) {
        links.push({ kind: "other-vendor", iban, role, owner: other, detail: `${mask(iban)} is on file for ${other}, not ${vendor}` });
      }
    }
  };
  check(args.iban, "subject");
  if (args.printed && compactIban(args.printed) !== compactIban(args.iban ?? "")) check(args.printed, "printed");
  return links;
}

// What an approval rests on: the kinds of link on the account it would pay
// or write. Kinds, not cases, so a flood of blocks cannot keep re-checking a
// case. One step finer for blocks: blocks of requests from two or more
// different senders are stronger evidence than one (two unrelated senders
// asking for the same unknown account), so an approval given when there was
// one stops counting when a second sender is blocked. A third sender, or the
// same sender again, changes nothing: the digest has at most four values.
export function linkDigest(links: Link[]): string {
  const subject = links.filter((l) => l.role === "subject");
  const senders = new Set(subject.filter((l) => l.kind === "blocked").map((l) => (l.sender ?? "").toLowerCase()));
  const kinds = [...new Set(subject.map((l) => (l.kind === "blocked" && senders.size >= 2 ? "blocked-by-2-senders" : l.kind)))].sort();
  return kinds.length ? kinds.join("+") : "none";
}
