#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, loadFlows, requireEnv } from "./config.ts";
import { Commands } from "./engine/commands.ts";
import { type Flow, FlowError, loadFlow } from "./engine/flow-schema.ts";
import { Runner } from "./engine/runner.ts";
import { Store } from "./engine/store.ts";
import { MailpitInbox } from "./inlets/email.ts";
import { startSchedules } from "./inlets/schedule.ts";
import { LiveOutlets } from "./outlets/index.ts";
import { CliAgent } from "./agents/cli-agent.ts";
import { vendorOf } from "./agents/lockdown.ts";
import { vendorProblems } from "./agents/vendors.ts";
import { seedDocuments } from "./switch/seed-docs.ts";
import { envKey, setupLocal } from "./setup-local.ts";
import { DEMO_INPUTS, demoOffline, demoReset, demoSend } from "./demo.ts";
import { startServer } from "./server.ts";
import { parse as parseYaml } from "yaml";
import { SwitchClient } from "./switch/client.ts";
import { sandboxPayees, startBank } from "./sandbox/bank.ts";

const USAGE = `switchyard <command>

  lint [file...]   check flow files (default: every flow in the flows folder)
  register         register @yard with Switch (needs SWITCH_REGISTRATION_TOKEN)
  up               run the engine, forms, webhooks and timers
  cancel <case>    cancel a case from the command line (e.g. one stuck in a removed room)
  proof <case> [--out <file>]
                   write a signed proof of a case: its evidence, decisions and actions
  verify-proof <file> [--fingerprint <hex>]
                   check a proof with no model, Switch or bank
  bank             run the sandbox bank (a separate process with its own ledger)
  demo offline     run the flows in this process: no Switch, no model, no account
  demo send <what> send a recorded demo input to a running Switchyard
                   (${DEMO_INPUTS.join(", ")})
  setup-local <flow...> [--user <chat user>] [--agent "<command>"] [--backup-agent "<command>"] [--bridge <bridge id>]
                   against a local Switch: register @yard and the flows'
                   agents, create their rooms, write switchyard.yaml`;

try {
  process.loadEnvFile();
} catch {
  // No .env: the environment alone is used.
}

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();

switch (command) {
  case "lint":
    lint(args);
    break;
  case "register":
    await register();
    break;
  case "up":
    await up();
    break;
  case "demo": {
    if (args[0] === "offline") await demoOffline(process.cwd(), { serve: args.includes("--serve") ? 4101 : undefined });
    else if (args[0] === "send" && args[1]) await demoSend(args[1], config);
    else if (args[0] === "reset") await demoReset(config);
    else throw new Error(`usage: switchyard demo offline [--serve] | demo reset | demo send <${DEMO_INPUTS.join("|")}>`);
    break;
  }
  case "lab": {
    if (process.argv.includes("--heldout")) {
      const { heldOutLab, heldOutTable } = await import("./lab-heldout.ts");
      console.log(heldOutTable(await heldOutLab()));
      break;
    }
    const { attackLab, labTable } = await import("./lab.ts");
    console.log(labTable(await attackLab()));
    break;
  }
  case "bank": {
    // A local test bank, not a real one; see src/sandbox/bank.ts.
    const port = Number(new URL(config.bank.url).port || 4300);
    startBank({ port, ledger: join(config.data, "sandbox-bank.json"), payees: sandboxPayees() });
    console.log(`Sandbox bank (not a real bank) on ${config.bank.url}; ledger in ${join(config.data, "sandbox-bank.json")}`);
    break;
  }
  case "proof": {
    const { buildProof, loadOrCreateKey, signProof } = await import("./proof.ts");
    const id = args[0];
    if (!id) throw new Error("usage: switchyard proof <case id> [--out <file>]");
    const store = new Store(join(config.data, "switchyard.db"));
    const proof = signProof(buildProof(store, loadFlows(config.flows), id), loadOrCreateKey(config.proof.key));
    const out = parseFlags(args).out ?? join(config.data, "proofs", `${id}.proof.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(`Wrote ${out}\n  root ${proof.root}\n  signed by key ${proof.signature!.fingerprint}`);
    if (config.proof.fingerprint !== proof.signature!.fingerprint) console.log(`  To trust this key, set proof.fingerprint: ${proof.signature!.fingerprint} in switchyard.yaml (or pass --fingerprint to verify-proof).`);
    break;
  }
  case "verify-proof": {
    const { verifyProof } = await import("./proof.ts");
    if (!args[0]) throw new Error("usage: switchyard verify-proof <file> [--fingerprint <hex>]");
    const findings = verifyProof(JSON.parse(readFileSync(args[0], "utf8")), parseFlags(args).fingerprint ?? config.proof.fingerprint);
    for (const f of findings) console.log(`${f.ok ? "✓" : "✗"} ${f.what}`);
    const failed = findings.filter((f) => !f.ok).length;
    console.log(failed ? `\n${failed} check${failed > 1 ? "s" : ""} failed.` : `\nAll ${findings.length} checks hold.`);
    if (failed) process.exitCode = 1;
    break;
  }
  case "cancel": {
    // For a case stuck in a room that is no longer configured, where
    // `@yard cancel` in chat cannot reach it. Only touches the local log.
    const store = new Store(join(config.data, "switchyard.db"));
    if (!args[0] || !store.caseIds().includes(args[0])) throw new Error(`usage: switchyard cancel <case id>`);
    store.append(args[0], { type: "cancelled", by: "switchyard cancel (CLI)" });
    console.log(`Cancelled case ${args[0]}.`);
    break;
  }
  case "setup-local": {
    const flags = parseFlags(args);
    await setupLocal({
      baseUrl: config.switch.url,
      flows: flags.rest,
      chatUser: flags.user ?? "user",
      agentCommand: (flags.agent ?? "claude -p --model haiku").split(" "),
      // Backups default to a different vendor: an outage should not take both.
      backupCommand: (flags.backup ?? "pi -p --model gemini-flash-lite-latest").split(" "),
      // Re-running keeps each agent's command unless a flag says otherwise.
      replaceCommands: flags.agent !== undefined || flags.backup !== undefined,
      bridgeId: flags.bridge,
    });
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
}

function lint(files: string[]): void {
  if (files.length === 0) {
    const flows = loadFlows(config.flows);
    console.log(`${flows.length} flows OK: ${flows.map((f) => f.flow).join(", ")}`);
    return;
  }
  let failed = false;
  for (const file of files) {
    try {
      loadFlow(readFileSync(file, "utf8"));
      console.log(`${file}: OK`);
    } catch (error) {
      if (!(error instanceof FlowError)) throw error;
      failed = true;
      console.log(`${file}:\n  ${error.problems.join("\n  ")}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function register(): Promise<void> {
  const response = await fetch(new URL("/agents", config.switch.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("SWITCH_REGISTRATION_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "yard",
      display_name: "Switchyard",
      description:
        "Runs this room's flows: brings in work from email, forms, schedules and webhooks, " +
        "asks agents for each step, opens approval cards, and carries out only what was approved.",
      connector_type: "switchyard",
      integration_profile: {
        connection_model: "always_on",
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    }),
  });
  if (!response.ok) throw new Error(`registering @yard failed: ${response.status} ${await response.text()}`);
  const { id, api_key } = (await response.json()) as { id: string; api_key: string };
  // The key is shown once by Switch; it goes straight to .env, never to the screen.
  appendFileSync(".env", `\nSWITCHYARD_AGENT_ID=${id}\nSWITCHYARD_API_KEY=${api_key}\n`);
  console.log(`Registered @yard (${id}); its key is saved in .env. Add @yard to each flow's room next.`);
}

async function up(): Promise<void> {
  // A flow runs once every room it uses has an id in switchyard.yaml, so
  // a team can turn flows on one at a time.
  const roomsOf = (flow: Flow) => [
    flow.room,
    ...flow.steps.flatMap((s) => ("outlet" in s && "post" in s.outlet ? [s.outlet.post.room] : [])),
  ];
  const all = loadFlows(config.flows);
  const flows = all.filter((flow) => roomsOf(flow).every((room) => config.rooms[room]));
  for (const flow of all.filter((f) => !flows.includes(f))) {
    const missing = roomsOf(flow).filter((room) => !config.rooms[room]);
    console.log(`Skipping ${flow.flow}: no room id for ${missing.join(", ")} in switchyard.yaml`);
  }
  if (flows.length === 0) throw new Error("No flow has all its rooms in switchyard.yaml yet.");
  const usedRooms = Object.fromEntries(flows.flatMap(roomsOf).map((room) => [room, config.rooms[room]]));

  mkdirSync(config.data, { recursive: true });
  const store = new Store(join(config.data, "switchyard.db"));
  const client = new SwitchClient({
    baseUrl: config.switch.url,
    agentId: requireEnv("SWITCHYARD_AGENT_ID"),
    apiKey: requireEnv("SWITCHYARD_API_KEY"),
    rooms: usedRooms,
  });
  const outlets = new LiveOutlets(
    {
      dataDir: config.data,
      bankUrl: config.bank.url,
      smtp: { ...config.smtp, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    },
    client,
    store,
  );
  const runnerVendors = Object.fromEntries(Object.entries(config.cli_agents).map(([n, a]) => [`@${n}`, vendorOf(a.command) ?? "unknown"]));
  const runner = new Runner(store, client, outlets, flows, { people: config.people, vendors: runnerVendors });

  // Agents come up before any case is resumed, so a resumed step is asked of
  // an agent that is already listening. Every command is locked down (and
  // refused if it can't be) before anything starts.
  const agentCommands = Object.fromEntries(Object.entries(config.cli_agents).map(([n, a]) => [n, a.command]));
  for (const p of vendorProblems(flows, agentCommands)) {
    console.warn(`Warning: ${p.flow}.${p.step}: ${p.agents.join(" and ")} all run on ${p.vendor}, so one provider outage stops them all. Give them different vendors in switchyard.yaml.`);
  }
  const agents = Object.entries(config.cli_agents).map(([name, spec]) => {
    const room = parseYaml(readFileSync(spec.template, "utf8")).room.name as string;
    const agentClient = new SwitchClient({
      baseUrl: config.switch.url,
      agentId: requireEnv(`${envKey(name)}_ID`),
      apiKey: requireEnv(`${envKey(name)}_KEY`),
      rooms: { [room]: config.rooms[room] },
    });
    return { name, client: agentClient, agent: new CliAgent({ name, command: spec.command, template: spec.template }, agentClient) };
  });
  for (const { name, client: agentClient, agent } of agents) {
    agent.start();
    await agentClient.start();
    console.log(`@${name} is up (${vendorOf(agent.command) ?? "unknown vendor"}): ${agent.command.map((a) => a || '""').join(" ")}`);
  }

  const commands = new Commands(runner, store, client, flows, config.people);
  client.onMessage(async (message) => {
    if (!(await commands.handle(message))) await runner.onMessage(message);
  });
  client.onApproval((outcome) => runner.onApproval(outcome));
  await client.start();
  const seeded = await seedDocuments(client, flows);
  if (seeded.length) console.log(`Created room documents in Switch: ${seeded.join(", ")}`);
  const adopted = await runner.attestRows();
  if (adopted.length) console.log(`Attested every row of ${adopted.join(", ")}: from now on only a case may change them`);
  await runner.resumeAll();
  const vendors = Object.fromEntries(agents.map(({ name, agent }) => [`@${name}`, vendorOf(agent.command) ?? "unknown"]));
  startServer({
    port: config.port,
    flows,
    runner,
    store,
    available: all.filter((f) => !flows.includes(f)),
    extras: { vendors, people: config.people },
    proofKey: (await import("./proof.ts")).loadOrCreateKey(config.proof.key),
  });
  new MailpitInbox(config.mailpit.url, flows, runner, store).start();
  startSchedules(flows, runner, store);
  setInterval(() => void runner.tick().catch((e) => console.error("[switchyard] tick:", e)), config.tick_seconds * 1000);

  console.log(`Switchyard is up: ${flows.length} flows, forms at http://localhost:${config.port}/f/<flow>`);
}

function parseFlags(args: string[]): { rest: string[]; user?: string; agent?: string; backup?: string; bridge?: string; out?: string; fingerprint?: string } {
  const result: { rest: string[]; user?: string; agent?: string; backup?: string; bridge?: string; out?: string; fingerprint?: string } = { rest: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user") result.user = args[++i];
    else if (args[i] === "--agent") result.agent = args[++i];
    else if (args[i] === "--backup-agent") result.backup = args[++i];
    else if (args[i] === "--bridge") result.bridge = args[++i];
    else if (args[i] === "--out") result.out = args[++i];
    else if (args[i] === "--fingerprint") result.fingerprint = args[++i];
    else result.rest.push(args[i]);
  }
  return result;
}
