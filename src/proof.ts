import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Flow } from "./engine/flow-schema.ts";
import { isGate, isOutlet } from "./engine/flow-schema.ts";
import type { Store } from "./engine/store.ts";
import { LEGACY, sameHash } from "./engine/verifiers.ts";
import { canonical, hashOutlet } from "./outlets/payload.ts";
import type { Outlet } from "./engine/flow-schema.ts";

// A payment's proof: one file that says why the money moved, checkable by
// anyone with no model, no Switch and no bank. It holds the case's event
// log, the evidence drawn from it in sections, a SHA-256 digest of each
// section, a root digest over them, and an Ed25519 signature over the root
// made with a key kept outside the event log. `verifyProof` checks the
// signature against a pinned key fingerprint, recomputes every digest,
// re-derives the sections from the log, and checks the evidence itself:
// each executed action hashes to what was approved and to what the bank
// read back, and each quote is at its offsets in the invoice text.
//
// What it proves: that this file is what Switchyard recorded and signed, and
// that the record is consistent. Not that the record is true: a proof is as
// good as the signing key, and the key holder could sign a false log.

export const FORMAT = "switchyard-proof/1";

type Event = Record<string, unknown> & { type: string; at_iso?: string; seq?: number };

export interface Proof {
  format: string;
  case: { id: string; flow: string; room: string; opened_at?: string };
  sections: Record<string, unknown>;
  // The flow the case ran under, as it was when the proof was made.
  flow: Flow;
  log: Event[];
  digests: Record<string, string>;
  root: string;
  signature?: { alg: "Ed25519"; public_key: string; fingerprint: string; value: string };
}

// Digests are taken over the value as JSON carries it (keys sorted, absent
// fields dropped), so a proof written to a file and read back hashes the same.
const sha = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value ?? null)))).digest("hex");

// The evidence, in the order a reader asks for it, drawn from the log only.
export function sections(log: Event[], flow: Flow | undefined): Record<string, unknown> {
  const opened = log.find((e) => e.type === "opened") as (Event & { data: Record<string, unknown>; source?: string }) | undefined;
  const data = opened?.data ?? {};
  const verified = log.filter((e) => e.type === "verified") as (Event & { step: string; check: string; value: Record<string, unknown> })[];
  const last = (check: string) => verified.filter((v) => v.check === check).at(-1)?.value;
  const step = (id: string) => flow?.steps.find((s) => s.id === id);
  let gate: (Event & { hashes?: Record<string, string> }) | undefined;
  const decisions: unknown[] = [];
  for (const e of log) {
    if (e.type === "gate_opened") gate = e as Event & { hashes?: Record<string, string> };
    if (e.type === "gate_answered") {
      const s = step(String(e.step));
      decisions.push({ step: e.step, answer: e.answer, by: e.answeredBy, approved: e.approved, role: s && isGate(s) ? s.gate.approver : undefined, at: e.at_iso, approves: gate?.hashes ?? {} });
    }
  }
  return {
    source: {
      via: opened?.source,
      data_digest: sha(data),
      text_digest: typeof data.text === "string" ? sha(data.text) : typeof data.body === "string" ? sha(data.body) : undefined,
      sender: data.from,
      reply_to: data.reply_to,
      mail_authentication: data.auth,
    },
    agents: log.filter((e) => e.type === "answered" || e.type === "partial").map((e) => ({ step: e.step, agent: e.agent, value: e.value, at: e.at_iso })),
    evidence: last("agent_evidence"),
    checks: verified.map((v) => ({ step: v.step, check: v.check, ok: v.value.ok, detail: v.value.detail, documents: v.docs, rows: v.rows, at: v.at_iso })),
    beneficiary: last("payee"),
    links: last("links"),
    stale_approvals: log.filter((e) => e.type === "rewound").map((e) => ({ step: e.step, changed: e.docs, at: e.at_iso })),
    decisions,
    executions: log.filter((e) => e.type === "executed").map((e) => {
      const s = step(String(e.step));
      return { step: e.step, kind: s && isOutlet(s) ? Object.keys(s.outlet)[0] : undefined, rule: s && isOutlet(s) && s.auto_approve !== false ? s.auto_approve : undefined, payload: e.payload, hash: e.hash, receipt: e.receipt, readback: e.readback, at: e.at_iso };
    }),
  };
}

export function buildProof(store: Store, flows: Flow[], caseId: string): Proof {
  if (!store.caseIds().includes(caseId)) throw new Error(`no case ${caseId}`);
  const state = store.load(caseId);
  const log = structuredClone(store.timeline(caseId)) as unknown as Event[];
  const flow = flows.find((f) => f.flow === state.flow);
  if (!flow) throw new Error(`no flow ${state.flow}`);
  // A copy: the sections must not share objects with the log, or an edit to
  // one would silently edit the other.
  const s = structuredClone(sections(log, flow));
  const digests = digestsOf(s, flow, log);
  return { format: FORMAT, case: { id: caseId, flow: state.flow, room: state.room, opened_at: log[0]?.at_iso }, sections: s, flow, log, digests, root: sha(digests) };
}

function digestsOf(s: Record<string, unknown>, flow: Flow, log: Event[]): Record<string, string> {
  return Object.fromEntries([...Object.entries(s).map(([k, v]) => [k, sha(v)]), ["flow", sha(flow)], ["log", sha(log)]]);
}

// The signing key lives in its own file, outside the event log: whoever can
// rewrite the SQLite file cannot re-sign a proof with it.
export function loadOrCreateKey(path: string): KeyObject {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(path));
}

export const fingerprint = (publicKeyPem: string) =>
  createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex");

export function signProof(proof: Proof, key: KeyObject): Proof {
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { ...proof, signature: { alg: "Ed25519", public_key: pub, fingerprint: fingerprint(pub), value: sign(null, Buffer.from(proof.root, "hex"), key).toString("base64") } };
}

export interface Finding {
  ok: boolean;
  what: string;
}

// Checks a proof with nothing but the file (and, to trust the signer, a
// pinned fingerprint). Returns each check and whether it held.
export function verifyProof(proof: Proof, pinned?: string): Finding[] {
  const out: Finding[] = [];
  const add = (ok: boolean, what: string) => out.push({ ok, what });
  add(proof.format === FORMAT, `format is ${FORMAT}`);

  // The signature, and whose it is.
  if (!proof.signature) add(false, "the proof is signed");
  else {
    const sig = proof.signature;
    const good = verify(null, Buffer.from(proof.root, "hex"), createPublicKey(sig.public_key), Buffer.from(sig.value, "base64"));
    add(good, "the Ed25519 signature over the root is valid");
    add(fingerprint(sig.public_key) === sig.fingerprint, "the stated key fingerprint is the key's");
    if (pinned) add(sig.fingerprint === pinned.toLowerCase(), `the signer is the pinned key ${pinned.slice(0, 16)}…`);
    else add(false, "the signer's key is pinned (pass --fingerprint, or set proof.fingerprint in switchyard.yaml)");
  }

  // The digests, and the sections against the log they were drawn from.
  const digests = digestsOf(proof.sections, proof.flow, proof.log);
  add(sha(proof.digests) === proof.root, "the root is the digest of the section digests");
  for (const [name, d] of Object.entries(digests)) add(proof.digests[name] === d, `section "${name}" matches its digest`);
  const flow = proof.flow;
  add(flow?.flow === proof.case.flow, `the flow inside is ${proof.case.flow}`);
  add(sha(sections(proof.log, flow)) === sha(proof.sections), "the sections are exactly what the log says");
  const seqs = proof.log.map((e) => Number(e.seq));
  add(seqs.every((n, i) => i === 0 || n > seqs[i - 1]), "the log is in recorded order");

  // The evidence itself.
  const opened = proof.log.find((e) => e.type === "opened") as (Event & { data: Record<string, unknown> }) | undefined;
  const text = typeof opened?.data?.text === "string" ? opened.data.text : undefined;
  const evidence = proof.sections.evidence as { quotes?: { quote: string; in: string; start?: number; end?: number }[]; findings?: { quote: string; in: string; start?: number; end?: number }[] } | undefined;
  const squash = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  for (const q of [...(evidence?.quotes ?? []), ...(evidence?.findings ?? [])]) {
    if (q.in === "text") add(text !== undefined && q.start !== undefined && squash(text.slice(q.start, q.end)) === squash(q.quote), `"${q.quote}" is at ${q.start}–${q.end} in the invoice text`);
  }
  let approvals: Record<string, string> = {};
  let gate: Record<string, string> = {};
  for (const e of proof.log) {
    if (e.type === "gate_opened") gate = (e.hashes as Record<string, string>) ?? {};
    if (e.type === "rewound") for (const step of e.steps as string[]) delete approvals[step];
    if (e.type === "gate_answered" && e.approved) approvals = { ...approvals, ...gate };
    if (e.type === "executed") {
      const step = String(e.step);
      const payload = e.payload as Outlet | undefined;
      if (payload) add(sameHash(String(e.hash), hashOutlet(payload), LEGACY.action), `${step}: the action recorded hashes to ${String(e.hash).slice(0, 16)}`);
      const rule = flow?.steps.find((s) => s.id === step);
      if (approvals[step]) add(sameHash(approvals[step], String(e.hash), LEGACY.action), `${step}: what was sent is what a person approved`);
      else add(Boolean(rule && isOutlet(rule) && rule.auto_approve !== false), `${step}: sent under the flow's rule, with no approval needed`);
      if (e.readback !== undefined) add(sameHash(String(e.readback), String(e.hash), LEGACY.action), `${step}: the bank's copy hashes the same as what was sent`);
    }
  }
  return out;
}
