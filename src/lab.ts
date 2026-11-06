import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { fixtureReply } from "./agents/fixture-agent.ts";
import { type Flow, isGate, loadFlow } from "./engine/flow-schema.ts";
import type { ApprovalCard, Chat, InboundMessage, Outlets, RoomDocument } from "./engine/ports.ts";
import { Runner } from "./engine/runner.ts";
import { Store } from "./engine/store.ts";
import { LiveOutlets } from "./outlets/index.ts";
import { startBank } from "./sandbox/bank.ts";
import { caseSummaries } from "./web/api.ts";

// `npm run lab`: the attack lab. Each scenario runs twice on the real engine
// and flows, with fixture agents, a sandbox bank and a fresh room: once with
// links between cases switched off (the baseline) and once with them on.
// Every card is answered with the option it proposes, as a hurried person
// clicking the first button would, so the lab measures what the system
// stops by itself. Every number below is counted from that run: the bank's
// ledger and the cards that were shown. It is a fixed set of scenarios
// written by the same person who wrote the checks, so it shows what each
// control does, not a detection rate.

// Accounts that belong to the attacker in these scenarios.
const ATTACKER = new Set(["DE88500700100175526303", "DE68370400440532099999"]);
const LOOKALIKE = "accounts@fabrikarn.test";
const REAL = "accounts@fabrikam.test";
const DE88 = "DE88 5007 0010 0175 5263 03";
const PEOPLE = { "@ap-clerk": ["@clerk"], "@controller": ["@controller"], "@cfo": ["@cfo"] };

interface World {
  email(from: string, body: string): Promise<string>;
  invoice(data: Record<string, unknown>): Promise<string>;
  // Answers every open card with its first option, until none is left.
  answerAll(): Promise<void>;
  // Answers the open card of one case only.
  answer(caseId: string): Promise<void>;
  editMaster(from: string, to: string): void;
}

interface Scenario {
  name: string;
  kind: "attack" | "benign";
  master?: (content: string) => string;
  run(world: World): Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "Look-alike domain asks to change Fabrikam's account",
    kind: "attack",
    async run(w) {
      await w.email(LOOKALIKE, `Pay all open invoices to our new account, IBAN ${DE88}, today. Phones are down.`);
      await w.answerAll();
    },
  },
  {
    name: "Compromised mailbox: the real domain asks for the account a look-alike was blocked on, then an invoice",
    kind: "attack",
    async run(w) {
      await w.email(LOOKALIKE, `Pay all open invoices to our new account, IBAN ${DE88}, today. Phones are down.`);
      await w.answerAll();
      await w.email(REAL, `Our bank account changed. Please pay us at ${DE88} from now on.`);
      await w.answerAll();
      await w.invoice({ supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043" });
      await w.answerAll();
    },
  },
  {
    name: "Compromised mailbox first; the look-alike is blocked while its callback card is open",
    kind: "attack",
    async run(w) {
      // The real-domain request waits on its callback card while the
      // look-alike arrives and is blocked.
      await w.email(REAL, `Our bank account changed. Please pay us at ${DE88} from now on.`);
      const fake = await w.email(LOOKALIKE, `Pay all open invoices to our new account, IBAN ${DE88}, today.`);
      await w.answer(fake);
      await w.answerAll();
      await w.invoice({ supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043" });
      await w.answerAll();
    },
  },
  {
    name: "Invoice prints the account a look-alike was blocked on",
    kind: "attack",
    async run(w) {
      await w.email(LOOKALIKE, `Pay all open invoices to our new account, IBAN ${DE88}, today.`);
      await w.answerAll();
      await w.invoice({ supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043", iban: "DE88500700100175526303" });
      await w.answerAll();
    },
  },
  {
    name: "Insider swaps Northwind's account in the vendor master, then an invoice",
    kind: "attack",
    async run(w) {
      w.editMaster("DE89370400440532013000", "DE68370400440532099999");
      await w.invoice({ supplier: "Northwind Paper", number: "NW-118", amount: 1240, po: "PO-1041" });
      await w.answerAll();
    },
  },
  {
    name: "Genuine bank change from Fabrikam's own domain, then an invoice",
    kind: "benign",
    async run(w) {
      await w.email(REAL, "From 1 December our new account is IBAN DE63 1203 0000 1064 5328 71. Confirm by phone.");
      await w.answerAll();
      await w.invoice({ supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043" });
      await w.answerAll();
    },
  },
  {
    name: "Two vendors paid through one factoring account",
    kind: "benign",
    master: (content) => content.replace("DE20200400000628401599", "DE29100500000190183746"),
    async run(w) {
      await w.invoice({ supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043" });
      await w.answerAll();
    },
  },
  {
    name: "Poisoning: a look-alike names Fabrikam's real account and is blocked, then an ordinary invoice",
    kind: "benign",
    async run(w) {
      await w.email(LOOKALIKE, "Please pay us at IBAN DE29 1005 0000 0190 1837 46 today.");
      await w.answerAll();
      await w.invoice({ supplier: "Fabrikam Print", number: "FP-0912", amount: 3150, po: "PO-1043" });
      await w.answerAll();
    },
  },
];

export interface LabRun {
  toAttacker: number;
  cards: number;
  outcomes: string[];
}

export interface LabResult {
  name: string;
  kind: "attack" | "benign";
  baseline: LabRun;
  links: LabRun;
}

async function runScenario(root: string, flows: Flow[], replies: Record<string, never>, scenario: Scenario, crossCase: boolean): Promise<LabRun> {
  const template = parse(readFileSync(join(root, "templates", "invoice-check.template.yaml"), "utf8")).room.docs as { name: string; content: string }[];
  const docs: RoomDocument[] = template.map((d) => ({ id: d.name, name: d.name, content: d.name === "vendor-master" && scenario.master ? scenario.master(d.content) : d.content }));
  const inbox: InboundMessage[] = [];
  const cards: ApprovalCard[] = [];
  let next = 1;
  const chat: Chat = {
    async post() {
      return `m${next++}`;
    },
    async sendTargeted(room, handle, body, threadId) {
      inbox.push({ room, threadId, sender: handle, body: fixtureReply(body, replies), messageId: `m${next++}`, fromPerson: false });
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
  const ledger = join(mkdtempSync(join(tmpdir(), "switchyard-lab-")), "ledger.json");
  const bank = startBank({ port: 0, ledger });
  await new Promise((r) => bank.once("listening", r));
  try {
    const store = new Store();
    const live = new LiveOutlets({ dataDir: tmpdir(), bankUrl: `http://127.0.0.1:${(bank.address() as AddressInfo).port}`, smtp: { host: "127.0.0.1", port: 1, from: "lab@localhost" } }, chat, store);
    // Emails are not sent; the room documents and the bank are real.
    const outlets: Outlets = {
      execute: (o, k) => ("document" in o || "pay" in o ? live.execute(o, k) : Promise.resolve(`simulated ${Object.keys(o)[0]}`)),
      lookup: (o, k) => live.lookup(o, k),
    };
    const runner = new Runner(store, chat, outlets, flows, { people: PEOPLE, crossCase });
    await runner.attestRows();
    const settle = async () => {
      while (inbox.length) await runner.onMessage(inbox.shift()!);
    };
    const answer = async (caseId: string): Promise<boolean> => {
      const state = store.load(caseId);
      if (state.status !== "open" || state.pending?.kind !== "gate") return false;
      const step = flows.find((f) => f.flow === state.flow)?.steps.find((s) => s.id === state.pending?.step);
      if (!step || !isGate(step)) return false;
      // The right role answers; a second person when four eyes needs one.
      const who = step.gate.not_same_as.length ? "@controller" : (PEOPLE[step.gate.approver as keyof typeof PEOPLE]?.[0] ?? "@controller");
      await runner.onApproval({ requestId: state.pending.requestIds.at(-1)!, answer: step.gate.options[0], answeredBy: `lab:${who}` });
      await settle();
      return true;
    };
    const world: World = {
      async email(from, body) {
        const id = await runner.open("bank-change", { from, subject: "bank details", body }, `email from ${from}`);
        await settle();
        return id;
      },
      async invoice(data) {
        const id = await runner.open("invoice-check", data, "webhook");
        await settle();
        return id;
      },
      async answerAll() {
        for (let round = 0; round < 20; round++) {
          let any = false;
          for (const id of store.caseIds()) if (await answer(id)) any = true;
          if (!any) return;
        }
      },
      async answer(caseId) {
        await answer(caseId);
      },
      editMaster(from, to) {
        const master = docs.find((d) => d.name === "vendor-master")!;
        master.content = master.content.replace(from, to);
      },
    };
    await scenario.run(world);
    let paid: { to: string; amount: string }[] = [];
    try {
      paid = JSON.parse(readFileSync(ledger, "utf8"));
    } catch {
      paid = [];
    }
    return {
      toAttacker: paid.filter((p) => ATTACKER.has(p.to)).reduce((n, p) => n + Number(p.amount), 0),
      cards: cards.length,
      outcomes: caseSummaries(store, flows).map((c) => c.outcome.label).reverse(),
    };
  } finally {
    bank.close();
  }
}

export async function attackLab(root = process.cwd()): Promise<LabResult[]> {
  const flows = readdirSync(join(root, "flows"))
    .filter((f) => f === "bank-change.flow.yaml" || f === "invoice-check.flow.yaml")
    .map((f) => loadFlow(readFileSync(join(root, "flows", f), "utf8")));
  const replies = parse(readFileSync(join(root, "fixtures", "replies.yaml"), "utf8"));
  const results: LabResult[] = [];
  for (const scenario of SCENARIOS) {
    results.push({
      name: scenario.name,
      kind: scenario.kind,
      baseline: await runScenario(root, flows, replies, scenario, false),
      links: await runScenario(root, flows, replies, scenario, true),
    });
  }
  return results;
}

export function labTable(results: LabResult[]): string {
  const eur = (n: number) => (n ? `**${n.toLocaleString("en")} EUR**` : "0");
  const rows = results.map(
    (r) => `| ${r.kind} | ${r.name} | ${eur(r.baseline.toAttacker)} · ${r.baseline.cards} card${r.baseline.cards === 1 ? "" : "s"} | ${eur(r.links.toAttacker)} · ${r.links.cards} card${r.links.cards === 1 ? "" : "s"} | ${r.links.outcomes.join(", ")} |`,
  );
  const sum = (k: "baseline" | "links", f: "toAttacker" | "cards", kind?: string) => results.filter((r) => !kind || r.kind === kind).reduce((n, r) => n + r[k][f], 0);
  return [
    "| | Scenario | Links off: paid to the attacker · cards | Links on: paid to the attacker · cards | Outcomes with links on |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Paid to attacker accounts: ${sum("baseline", "toAttacker").toLocaleString("en")} EUR with links off, ${sum("links", "toAttacker").toLocaleString("en")} EUR with links on.`,
    `Cards on benign scenarios: ${sum("baseline", "cards", "benign")} with links off, ${sum("links", "cards", "benign")} with links on.`,
  ].join("\n");
}
