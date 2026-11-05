import type { Flow } from "../engine/flow-schema.ts";
import { isAgent, isParallel } from "../engine/flow-schema.ts";
import { vendorOf } from "./lockdown.ts";

// A backup agent only helps if it fails differently from the agent it backs
// up, and two parallel checkers only check each other if they are different
// models. This lists every place a flow's config breaks that, so `up` can
// say so before the first case instead of during an outage.

export interface VendorProblem {
  flow: string;
  step: string;
  agents: string[];
  vendor: string;
}

export function vendorProblems(flows: Flow[], commands: Record<string, string[]>): VendorProblem[] {
  const vendor = (handle: string) => {
    const command = commands[handle.slice(1)];
    return command ? vendorOf(command) : undefined; // not run by Switchyard: unknown
  };
  const problems: VendorProblem[] = [];
  for (const flow of flows) {
    for (const step of flow.steps) {
      const group = isAgent(step) && step.bench ? [step.agent, step.bench] : isParallel(step) ? step.parallel : [];
      const known = group.map((h) => [h, vendor(h)] as const).filter(([, v]) => v !== undefined);
      const seen = new Map<string, string[]>();
      for (const [handle, v] of known) seen.set(v!, [...(seen.get(v!) ?? []), handle]);
      for (const [v, agents] of seen) {
        if (agents.length > 1) problems.push({ flow: flow.flow, step: step.id, agents, vendor: v });
      }
    }
  }
  return problems;
}
