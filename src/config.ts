import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type Flow, loadFlow } from "./engine/flow-schema.ts";

// switchyard.yaml holds everything that is safe to commit. Secrets (the
// agent's API key, SMTP password) come from the environment or .env.
const Config = z.object({
  switch: z.object({ url: z.string().url().default("http://localhost:8000") }).prefault({}),
  rooms: z.record(z.string(), z.string()).prefault({}),
  // Roles flows name (@manager) to the chat handles of the people in them.
  people: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .prefault({})
    .transform((map) => Object.fromEntries(Object.entries(map).map(([role, who]) => [role, [who].flat()]))),
  // Agents run by Switchyard itself through a coding-agent CLI (no Console).
  cli_agents: z
    .record(z.string(), z.object({ template: z.string(), command: z.array(z.string()).min(1) }))
    .prefault({}),
  flows: z.string().default("flows"),
  data: z.string().default("data"),
  port: z.number().int().default(4100),
  mailpit: z.object({ url: z.string().url().default("http://localhost:8025") }).prefault({}),
  tick_seconds: z.number().positive().default(15),
  smtp: z
    .object({ host: z.string().default("localhost"), port: z.number().default(1025), from: z.string().default("switchyard@localhost") })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(dir = process.cwd()): Config {
  const path = join(dir, "switchyard.yaml");
  const raw = existsSync(path) ? parseYaml(readFileSync(path, "utf8")) : {};
  const config = Config.parse(raw ?? {});
  return { ...config, flows: resolve(dir, config.flows), data: resolve(dir, config.data) };
}

export function loadFlows(dir: string): Flow[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".flow.yaml"))
    .sort()
    .map((file) => {
      try {
        return loadFlow(readFileSync(join(dir, file), "utf8"));
      } catch (error) {
        throw new Error(`${file}:\n${(error as Error).message}`);
      }
    });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (put it in .env; see .env.example)`);
  return value;
}
