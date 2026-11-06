import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { type Flow, isGate, loadFlow } from "./engine/flow-schema.ts";
import type { ApprovalCard, Chat, InboundMessage, Outlets, RoomDocument } from "./engine/ports.ts";
import { Runner } from "./engine/runner.ts";
import { Store } from "./engine/store.ts";
import { compactIban } from "./engine/verifiers.ts";
import { LiveOutlets } from "./outlets/index.ts";
import { startBank } from "./sandbox/bank.ts";

// `npm run lab -- --heldout`: the scenarios in lab/heldout/, written from
// lab/FORMAT.md alone by an author who had not read the code, with what a
// correct company should end up with fixed before they were first run (see
// FROZEN.sha256 and the git history). Each runs on the real engine, flows and
// sandbox bank, once with links between cases off and once on. A scenario
// passes when every expectation holds; every failure is reported.

type Step =
  | { email: { label: string; from: string; reply_to?: string; subject?: string; body: string; reads: Record<string, unknown> } }
  | { invoice: { label: string; supplier: string; number: string; amount: number; po?: string; iban?: string; reads: Record<string, unknown> } }
  | { edit_master: Record<string, string> & { vendor: string } }
  | { edit_po: Record<string, string> & { po: string } }
  | { wait: { days?: number; hours?: number } }
  | { answer: { case: string; choice: string; by?: string } }
  | { answer_all: Record<string, never> };

export interface HeldOut {
  id: string;
  family: string;
  kind: "attack" | "benign";
  title: string;
  notes?: string;
  attacker_accounts: string[];
  genuine_accounts: string[];
  callback?: "real" | "fooled";
  steps: Step[];
  expect: { attacker_paid_eur: number } & Record<string, { changed?: boolean; paid?: number; to?: string } | number>;
}

export interface HeldOutRun {
  pass: boolean;
  failures: string[];
  toAttacker: number;
  cards: number;
  // Approvals that stopped counting because what they rested on changed.
  stale: number;
  // Answers refused: the wrong person, or the same person twice where four eyes is required.
  refused: number;
  outcomes: Record<string, string>;
}

export interface HeldOutResult {
  scenario: HeldOut;
  baseline: HeldOutRun;
  links: HeldOutRun;
  // Every callback fooled (skipped, or the person believed the caller).
  // Expectations assume people doing their job, so only the money counts.
  fooled: { baseline: number; links: number };
  // The same two runs (links on), with a bank that knows who holds each
  // account. FORMAT.md never said, so this registry is built from each
  // scenario's own roles for its accounts: an upper bound on what payee
  // verification can do when the bank is right, not a held-out result.
  oracle: { run: HeldOutRun; fooled: number };
}

// Who holds each account, from what the scenario says: an account the
// email of one vendor names as genuine is that vendor's; one genuine for
// several vendors is a factoring company's; an attacker's is someone else's.
// The template's accounts on file are their vendors'.
function oracleRegistry(s: HeldOut): Record<string, string> {
  const registry: Record<string, string> = {
    DE89370400440532013000: "Northwind Paper",
    DE44500105175407324931: "Contoso Cloud",
    DE29100500000190183746: "Fabrikam Print",
    DE20200400000628401599: "Tailspin Travel",
  };
  for (const a of s.attacker_accounts) registry[compactIban(a)] = "Unrelated Holder Ltd";
  for (const g of s.genuine_accounts) {
    const iban = compactIban(g);
    const vendors = [...new Set(s.steps.flatMap((x) => ("email" in x && compactIban(String(x.email.reads.new_iban ?? "")) === iban ? [String(x.email.reads.vendor)] : [])))];
    registry[iban] = vendors.length === 1 ? vendors[0] : "Factoring Company Ltd";
  }
  return registry;
}

const PEOPLE = { "@ap-clerk": ["@clerk"], "@controller": ["@controller"], "@cfo": ["@cfo"] };
const DAY = 86_400_000;

// What an agent replies. For an email, the scenario's `reads`. For an
// invoice, FORMAT.md gives one reading for "each of the two AI checkers"
// (result: match | mismatch | no_po), written before the two agents had
// different jobs: the reader reports the invoice as it is, and the
// investigator calls anything but "match" suspicious, with the reasons as
// findings. Their quotes come from nowhere, so code sets them aside.
function replyFor(flow: string, agent: string, data: Record<string, unknown>, reads: Record<string, unknown>): Record<string, unknown> {
  if (flow !== "invoice-check") return reads;
  if (agent === "@checker") {
    return { supplier: data.supplier, number: data.number, amount: data.amount, ...(data.iban ? { iban: data.iban } : {}), ...(data.po ? { po: data.po } : {}), quotes: [data.supplier, data.number] };
  }
  const clear = reads.result === "match";
  return { verdict: clear ? "clear" : "suspicious", findings: clear ? [] : ((reads.reasons as string[] | undefined) ?? []).map((claim) => ({ claim, quote: "" })) };
}

export function loadHeldOut(root = process.cwd()): HeldOut[] {
  const dir = join(root, "lab", "heldout");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parse(readFileSync(join(dir, f), "utf8")) as HeldOut);
}

// The table cell of a vendor-master or PO row, by column name.
function editRow(content: string, key: string, changes: Record<string, string>): string {
  const lines = content.split("\n");
  const header = lines.find((l) => l.trim().startsWith("|"))?.split("|").slice(1, -1).map((c) => c.trim()) ?? [];
  return lines
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells[0] !== key) return line;
      for (const [column, value] of Object.entries(changes)) {
        const i = header.indexOf(column);
        if (i > 0) cells[i] = value;
      }
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
}

async function runOne(root: string, flows: Flow[], given: HeldOut, crossCase: boolean, fooled = false, payees?: Record<string, string>): Promise<HeldOutRun> {
  const s: HeldOut = fooled ? { ...given, callback: "fooled" } : given;
  const template = parse(readFileSync(join(root, "templates", "invoice-check.template.yaml"), "utf8")).room.docs as { name: string; content: string }[];
  const docs: RoomDocument[] = template.map((d) => ({ id: d.name, name: d.name, content: d.content }));
  const inbox: { room: string; handle: string; body: string; threadId?: string }[] = [];
  const cards: ApprovalCard[] = [];
  // What the model read, per case: the scenario says it.
  const reads = new Map<string, Record<string, unknown>>();
  let clock = Date.parse("2026-11-02T09:00:00Z");
  let next = 1;
  const store = new Store();
  const chat: Chat = {
    async post() {
      return `m${next++}`;
    },
    async sendTargeted(room, handle, body, threadId) {
      inbox.push({ room, handle, body, threadId });
    },
    async openApproval(card) {
      cards.push(card);
    },
    async handleOf(answeredBy) {
      return answeredBy.replace(/^lab:/, "");
    },
    async documents() {
      return docs;
    },
    async updateDocument(_room, id, content) {
      const doc = docs.find((d) => d.id === id);
      if (doc) doc.content = content;
    },
  };
  const ledger = join(mkdtempSync(join(tmpdir(), "switchyard-heldout-")), "ledger.json");
  // By default the bank has no registry: FORMAT.md never said who holds an
  // account, so payee verification answers "unavailable".
  const bank = startBank({ port: 0, ledger, payees });
  await new Promise((r) => bank.once("listening", r));
  try {
    const live = new LiveOutlets({ dataDir: tmpdir(), bankUrl: `http://127.0.0.1:${(bank.address() as AddressInfo).port}`, smtp: { host: "127.0.0.1", port: 1, from: "lab@localhost" } }, chat, store);
    const outlets: Outlets = {
      execute: (o, k) => ("document" in o || "pay" in o ? live.execute(o, k) : Promise.resolve(`simulated ${Object.keys(o)[0]}`)),
      lookup: (o, k) => live.lookup(o, k),
      checkPayee: (iban, name) => live.checkPayee(iban, name),
    };
    const runner = new Runner(store, chat, outlets, flows, { people: PEOPLE, crossCase, now: () => clock });
    await runner.attestRows();
    // The agent's reply is what the scenario says it read, built when the
    // request is delivered (after the case, and its reads, exist).
    const settle = async () => {
      while (inbox.length) {
        const { room, handle, body, threadId } = inbox.shift()!;
        const token = /"token": "(sy:[^"]+)"/.exec(body.slice(body.lastIndexOf("```json")))?.[1];
        const caseId = store.caseIds().find((id) => store.load(id).threadId === threadId);
        const fields = caseId ? replyFor(store.load(caseId).flow, handle, store.load(caseId).data, reads.get(caseId) ?? {}) : {};
        const message: InboundMessage = { room, threadId, sender: handle, body: `\`\`\`json\n${JSON.stringify({ token, ...fields })}\n\`\`\``, messageId: `m${next++}`, fromPerson: false };
        await runner.onMessage(message);
      }
    };
    const labels = new Map<string, string>();
    const genuine = new Set(s.genuine_accounts.map(compactIban));
    const answer = async (caseId: string, choice?: string, by?: string): Promise<boolean> => {
      const state = store.load(caseId);
      if (state.status !== "open" || state.pending?.kind !== "gate") return false;
      const step = flows.find((f) => f.flow === state.flow)?.steps.find((x) => x.id === state.pending?.step);
      if (!step || !isGate(step)) return false;
      let pick = choice ?? step.gate.options[0];
      if (!choice && step.id === "callback") {
        const asked = compactIban(String((state.results.checks as { new_iban?: string } | undefined)?.new_iban ?? ""));
        pick = s.callback === "fooled" || genuine.has(asked) ? step.gate.options[0] : (step.gate.options[1] ?? pick);
      }
      // The right person: the backup once the card escalated, someone other
      // than the caller where four eyes applies.
      const role = state.pending.escalated && step.gate.backup ? step.gate.backup : step.gate.approver;
      const who = by ?? (step.gate.not_same_as.length && role === "@ap-clerk" ? "@controller" : (PEOPLE[role as keyof typeof PEOPLE]?.[0] ?? "@controller"));
      await runner.onApproval({ requestId: state.pending.requestIds.at(-1)!, answer: pick, answeredBy: `lab:${who}` });
      await settle();
      return true;
    };
    for (const step of s.steps) {
      if ("email" in step) {
        const e = step.email;
        const id = await runner.open("bank-change", { from: e.from, subject: e.subject ?? "bank details", body: e.body, ...(e.reply_to ? { reply_to: e.reply_to } : {}) }, `email from ${e.from}`);
        labels.set(e.label, id);
        reads.set(id, e.reads);
        await settle();
      } else if ("invoice" in step) {
        const i = step.invoice;
        const data = { supplier: i.supplier, number: i.number, amount: i.amount, ...(i.po ? { po: i.po } : {}), ...(i.iban ? { iban: i.iban } : {}) };
        const id = await runner.open("invoice-check", data, "webhook");
        labels.set(i.label, id);
        reads.set(id, i.reads);
        await settle();
      } else if ("edit_master" in step) {
        const { vendor, ...changes } = step.edit_master;
        const doc = docs.find((d) => d.name === "vendor-master")!;
        doc.content = editRow(doc.content, vendor, changes);
      } else if ("edit_po" in step) {
        const { po, ...changes } = step.edit_po;
        const doc = docs.find((d) => d.name === "purchase-orders")!;
        doc.content = editRow(doc.content, po, changes);
      } else if ("wait" in step) {
        clock += (step.wait.days ?? 0) * DAY + (step.wait.hours ?? 0) * 3_600_000;
        await runner.tick();
        await settle();
      } else if ("answer" in step) {
        const id = labels.get(step.answer.case);
        if (id) await answer(id, step.answer.choice, step.answer.by);
      } else if ("answer_all" in step) {
        for (let round = 0; round < 20; round++) {
          let any = false;
          for (const id of store.caseIds()) if (await answer(id)) any = true;
          if (!any) break;
        }
      }
    }

    let paid: { to: string; amount: string; reference?: string }[] = [];
    try {
      paid = JSON.parse(readFileSync(ledger, "utf8"));
    } catch {
      paid = [];
    }
    const attacker = new Set(s.attacker_accounts.map(compactIban));
    const toAttacker = paid.filter((p) => attacker.has(compactIban(p.to))).reduce((n, p) => n + Number(p.amount), 0);
    const failures: string[] = [];
    if (toAttacker !== s.expect.attacker_paid_eur) failures.push(`attacker paid ${toAttacker}, expected ${s.expect.attacker_paid_eur}`);
    const outcomes: Record<string, string> = {};
    for (const [label, want] of Object.entries(s.expect)) {
      if (label === "attacker_paid_eur" || typeof want !== "object") continue;
      const id = labels.get(label);
      if (!id) {
        failures.push(`${label}: never opened`);
        continue;
      }
      const events = store.events(id);
      const executed = events.filter((e) => e.type === "executed");
      const payments = executed.map((e) => (e.type === "executed" ? (e.payload as { pay?: { to: string; amount: string } } | undefined)?.pay : undefined)).filter((p) => p !== undefined);
      const changed = executed.some((e) => e.type === "executed" && e.step === "update_master");
      const total = payments.reduce((n, p) => n + Number(p.amount), 0);
      const state = store.load(id);
      outcomes[label] = state.flow === "bank-change"
        ? `${changed ? "changed" : "not changed"} (${state.status}${state.pending ? `, waiting on ${state.pending.step}` : ""})`
        : `${total ? `paid ${total} to ${payments.map((p) => p.to).join(", ")}` : "not paid"} (${state.status}${state.pending ? `, waiting on ${state.pending.step}` : ""})`;
      if (want.changed !== undefined && want.changed !== changed) failures.push(`${label}: ${changed ? "changed" : "not changed"}, expected ${want.changed ? "changed" : "not changed"}`);
      if (want.paid !== undefined && want.paid !== total) failures.push(`${label}: paid ${total}, expected ${want.paid}`);
      if (want.to && total > 0 && payments.some((p) => compactIban(p.to) !== compactIban(want.to!))) failures.push(`${label}: paid to ${payments.map((p) => p.to).join(", ")}, expected ${want.to}`);
    }
    const all = store.caseIds().flatMap((id) => store.events(id));
    return {
      pass: failures.length === 0,
      failures,
      toAttacker,
      cards: cards.length,
      stale: all.filter((e) => e.type === "rewound").length,
      refused: all.filter((e) => e.type === "card_reopened").length,
      outcomes,
    };
  } finally {
    bank.close();
  }
}

export async function heldOutLab(root = process.cwd()): Promise<HeldOutResult[]> {
  const flows = readdirSync(join(root, "flows"))
    .filter((f) => f === "bank-change.flow.yaml" || f === "invoice-check.flow.yaml")
    .map((f) => loadFlow(readFileSync(join(root, "flows", f), "utf8")));
  const results: HeldOutResult[] = [];
  for (const scenario of loadHeldOut(root)) {
    results.push({
      scenario,
      baseline: await runOne(root, flows, scenario, false),
      links: await runOne(root, flows, scenario, true),
      fooled: { baseline: (await runOne(root, flows, scenario, false, true)).toAttacker, links: (await runOne(root, flows, scenario, true, true)).toAttacker },
      oracle: { run: await runOne(root, flows, scenario, true, false, oracleRegistry(scenario)), fooled: (await runOne(root, flows, scenario, true, true, oracleRegistry(scenario))).toAttacker },
    });
  }
  return results;
}

export function heldOutTable(results: HeldOutResult[]): string {
  const mark = (r: HeldOutRun) => `${r.pass ? "pass" : "**fail**"} · ${r.toAttacker ? `**${r.toAttacker.toLocaleString("en")} EUR**` : "0"} · ${r.cards}`;
  const eur = (n: number) => (n ? `**${n.toLocaleString("en")}**` : "0");
  const rows = results.map(({ scenario: s, baseline, links, fooled }) => `| ${s.id} | ${s.family} | ${s.kind} | ${s.title} | ${mark(baseline)} | ${mark(links)} | ${eur(fooled.baseline)} / ${eur(fooled.links)} | ${links.failures.join("; ") || "—"} |`);
  const count = (k: "baseline" | "links", f: (r: HeldOutRun, s: HeldOut) => boolean) => results.filter((r) => f(r[k], r.scenario)).length;
  const sum = (k: "baseline" | "links", f: (r: HeldOutRun) => number, kind?: string) => results.filter((r) => !kind || r.scenario.kind === kind).reduce((n, r) => n + f(r[k]), 0);
  const line = (k: "baseline" | "links", label: string) =>
    `${label}: ${count(k, (r) => r.pass)}/${results.length} scenarios meet every expectation (attacks ${count(k, (r, s) => s.kind === "attack" && r.pass)}/${results.filter((r) => r.scenario.kind === "attack").length}, benign ${count(k, (r, s) => s.kind === "benign" && r.pass)}/${results.filter((r) => r.scenario.kind === "benign").length}); ${sum(k, (r) => r.toAttacker).toLocaleString("en")} EUR to attacker accounts; ${sum(k, (r) => r.cards)} cards (${sum(k, (r) => r.cards, "benign")} on benign scenarios); ${sum(k, (r) => r.stale)} approvals stopped counting; ${sum(k, (r) => r.refused)} answers refused.`;
  return [
    "Each cell: meets every expectation · euros paid to the attacker's accounts · cards shown to people.",
    "",
    "| | Family | Kind | Scenario | Links off | Links on | Every callback fooled: EUR to attacker, off / on | What did not match (links on) |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    line("baseline", "Links off"),
    line("links", "Links on"),
    `Every callback fooled: ${results.reduce((n, r) => n + r.fooled.baseline, 0).toLocaleString("en")} EUR to attacker accounts with links off, ${results.reduce((n, r) => n + r.fooled.links, 0).toLocaleString("en")} EUR with links on.`,
    "",
    `Upper bound, with a bank that knows who holds each account (built from each scenario's own description of its accounts, so not held out): ${results.filter((r) => r.oracle.run.pass).length}/${results.length} meet every expectation (${results.filter((r) => !r.oracle.run.pass).map((r) => r.scenario.id).join(", ") || "none"} do not); ${results.reduce((n, r) => n + r.oracle.run.toAttacker, 0).toLocaleString("en")} EUR to attacker accounts; with every callback fooled, ${results.reduce((n, r) => n + r.oracle.fooled, 0).toLocaleString("en")} EUR.`,
  ].join("\n");
}
