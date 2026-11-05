import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isAgent, loadFlow } from "../src/engine/flow-schema.ts";

const flows = readdirSync("flows").map((file) => loadFlow(readFileSync(`flows/${file}`, "utf8")));

describe.each(flows)("starter flow $flow", (flow) => {
  const template = parse(readFileSync(`templates/${flow.flow}.template.yaml`, "utf8"));
  const created = new Set<string>(template.agents.map((a: { name: string }) => `@${a.name}`));

  it("has a template that creates its room", () => {
    expect(template.room.name).toBe(flow.room);
    expect(template.room.users).toContain("{$creator}");
  });

  it("names only agents its template creates and puts in the room", () => {
    const named = flow.steps.filter(isAgent).flatMap((s) => [s.agent, ...(s.bench ? [s.bench] : [])]);
    for (const handle of named) {
      expect(created, `${handle} in ${flow.flow}`).toContain(handle);
      expect(template.room.agents).toContain(handle.slice(1));
    }
  });

  it("gives every backup agent a different provider param than its main agent", () => {
    const providers = new Map(template.agents.map((a: { name: string; provider: string }) => [`@${a.name}`, a.provider]));
    for (const step of flow.steps.filter(isAgent)) {
      if (step.bench) expect(providers.get(step.bench)).not.toBe(providers.get(step.agent));
    }
  });
});
