import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { loadFlow } from "./engine/flow-schema.ts";

// `switchyard setup-local <flow...>`: everything Switch Console would do for
// a flow, done through Switch's HTTP API against a local server. It signs in
// as the local admin, mints a personal API key, registers @yard and the
// flow's agents, creates each room on the server's default messaging app
// with the chat user in it, and writes switchyard.yaml.
//
// The admin's email and password are read from the environment
// (SWITCH_ADMIN_EMAIL / SWITCH_ADMIN_PASSWORD) and never printed.

interface Options {
  baseUrl: string;
  flows: string[];
  chatUser: string;
  agentCommand: string[];
  // For agents the template puts on `{backup_provider}`: another vendor.
  backupCommand: string[];
}

export async function setupLocal(options: Options): Promise<void> {
  const api = new LocalApi(options.baseUrl);
  await api.login(requireEnv("SWITCH_ADMIN_EMAIL"), requireEnv("SWITCH_ADMIN_PASSWORD"));
  const token = (await api.post<{ key: string }>("/gateway/api-keys", { label: "switchyard" })).key;
  const env = readEnv();

  const yardId = env.SWITCHYARD_AGENT_ID ?? (await registerAgent(options.baseUrl, token, "yard", "Switchyard", YARD_DESCRIPTION, env));

  const config = existsSync("switchyard.yaml") ? (parse(readFileSync("switchyard.yaml", "utf8")) ?? {}) : {};
  config.switch = { url: options.baseUrl };
  config.rooms ??= {};
  config.cli_agents ??= {};
  config.people ??= {};

  for (const name of options.flows) {
    const flow = loadFlow(readFileSync(`flows/${name}.flow.yaml`, "utf8"));
    const templatePath = `templates/${name}.template.yaml`;
    const template = parse(readFileSync(templatePath, "utf8"));

    const agentIds: string[] = [yardId];
    for (const agent of template.agents as { name: string; description: string; provider: string }[]) {
      const key = envKey(agent.name);
      const id = env[`${key}_ID`] ?? (await registerAgent(options.baseUrl, token, agent.name, agent.name, agent.description, env));
      agentIds.push(id);
      const backup = agent.provider === "{backup_provider}";
      config.cli_agents[agent.name] = { template: templatePath, command: backup ? options.backupCommand : options.agentCommand };
    }

    const rooms = [flow.room, ...outletRooms(flow)];
    for (const room of rooms) {
      if (config.rooms[room]) continue;
      const created = await api.post<{ id: string }>("/gateway/rooms", {
        name: room,
        description: room === flow.room ? template.room.description : `Where Switchyard posts for ${flow.flow}`,
        instructions: room === flow.room ? template.room.instructions : undefined,
        agent_ids: room === flow.room ? agentIds : [yardId],
        user_names: [options.chatUser],
      });
      config.rooms[room] = created.id;
      console.log(`Created room #${room} (${created.id})`);
    }

    for (const step of flow.steps) {
      if (!("gate" in step)) continue;
      for (const role of [step.gate.approver, step.gate.backup]) {
        if (role && !config.people[role]) config.people[role] = `@${options.chatUser}`;
      }
    }
  }

  writeFileSync("switchyard.yaml", stringify(config));
  console.log("Wrote switchyard.yaml. Start with: npm run switchyard up");
}

const YARD_DESCRIPTION =
  "Runs this room's flows: brings in work from email, forms, schedules and webhooks, " +
  "asks agents for each step, opens approval cards, and carries out only what was approved.";

async function registerAgent(
  baseUrl: string,
  token: string,
  name: string,
  displayName: string,
  description: string,
  env: Record<string, string>,
): Promise<string> {
  const response = await fetch(new URL("/agents", baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      display_name: displayName,
      description,
      connector_type: name === "yard" ? "switchyard" : "switchyard-cli-agent",
      integration_profile: {
        connection_model: "always_on",
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    }),
  });
  if (!response.ok) throw new Error(`registering @${name}: ${response.status} ${await response.text()}`);
  const { id, api_key } = (await response.json()) as { id: string; api_key: string };
  const key = name === "yard" ? "SWITCHYARD_AGENT" : envKey(name);
  const idName = name === "yard" ? "SWITCHYARD_AGENT_ID" : `${key}_ID`;
  const keyName = name === "yard" ? "SWITCHYARD_API_KEY" : `${key}_KEY`;
  appendFileSync(".env", `${idName}=${id}\n${keyName}=${api_key}\n`);
  env[idName] = id;
  env[keyName] = api_key;
  console.log(`Registered @${name}`);
  return id;
}

export function envKey(agentName: string): string {
  return `AGENT_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function outletRooms(flow: ReturnType<typeof loadFlow>): string[] {
  return flow.steps.flatMap((s) => ("outlet" in s && "post" in s.outlet ? [s.outlet.post.room] : []));
}

function readEnv(): Record<string, string> {
  if (!existsSync(".env")) return {};
  return Object.fromEntries(
    readFileSync(".env", "utf8")
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=./.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// The Gateway signs people in with a session cookie.
class LocalApi {
  private readonly baseUrl: string;
  private cookie = "";

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async login(email: string, password: string): Promise<void> {
    const response = await fetch(new URL("/gateway/auth/login", this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(`signing in to Switch: ${response.status}`);
    this.cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.cookie },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }
}
