import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { compile, ExprError } from "./expr.ts";

// Field types an agent step can demand in its JSON reply. An array of strings
// is an enum; a trailing "?" makes the field optional.
const FieldType = z.union([
  z.enum(["str", "str?", "number", "number?", "bool", "bool?", "list", "list?"]),
  z.array(z.string()).min(1),
]);
export type FieldType = z.infer<typeof FieldType>;

const Duration = z.string().regex(/^\d+(s|m|h|d)$/, "a duration like 30s, 10m, 4h or 2d");
const Handle = z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/, "an @handle in lower case");

const base = {
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "a lower-case identifier"),
  when: z.string().optional(),
};

const AgentStep = z.object({
  ...base,
  agent: Handle,
  ask: z.string(),
  expect: z.record(z.string(), FieldType),
  sla: Duration.optional(),
  bench: Handle.optional(),
});

const GateStep = z.object({
  ...base,
  gate: z.object({
    approver: Handle,
    backup: Handle.optional(),
    title: z.string(),
    options: z.array(z.string()).min(2),
    deadline: Duration.optional(),
    // The outlet steps whose exact payload this approval covers.
    approves: z.array(z.string()).default([]),
  }),
});

const OutletStep = z.object({
  ...base,
  outlet: z.union([
    z.object({ csv: z.object({ file: z.string(), row: z.array(z.string()) }) }),
    z.object({ email: z.object({ to: z.string(), subject: z.string(), body: z.string() }) }),
    z.object({ webhook: z.object({ url: z.string().url(), body: z.record(z.string(), z.string()) }) }),
    z.object({ post: z.object({ room: z.string(), body: z.string() }) }),
    // A reply to the front-desk visitor who opened the case.
    z.object({ visitor: z.object({ body: z.string() }) }),
  ]),
  // Runs with no human gate: always (true) or when a condition holds, such as
  // `case.amount <= 500`. Each use is a deliberate, reviewable exception.
  auto_approve: z.union([z.boolean(), z.string()]).default(false),
});

// Several agents do the same step independently. The result holds each
// agent's answer under its name, plus `agreed`: whether every answer gave the
// same value for each enum field (e.g. both said "accurate").
const ParallelStep = z.object({
  ...base,
  parallel: z.array(Handle).min(2),
  ask: z.string(),
  expect: z.record(z.string(), FieldType),
  sla: Duration.optional(),
});

// Pauses the case, e.g. three days before a follow-up. A person can end it
// early with `@yard resume <case>`.
const WaitStep = z.object({ ...base, wait: Duration });

export const Step = z.union([AgentStep, ParallelStep, GateStep, OutletStep, WaitStep]);
export type Step = z.infer<typeof Step>;
export type AgentStep = z.infer<typeof AgentStep>;
export type GateStep = z.infer<typeof GateStep>;
export type OutletStep = z.infer<typeof OutletStep>;
export type WaitStep = z.infer<typeof WaitStep>;
export type ParallelStep = z.infer<typeof ParallelStep>;
export type Outlet = OutletStep["outlet"];

export const Flow = z.object({
  flow: z.string().regex(/^[a-z][a-z0-9-]*$/),
  room: z.string(),
  description: z.string().optional(),
  inlet: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(Step).min(1),
});
export type Flow = z.infer<typeof Flow>;

export const isAgent = (step: Step): step is AgentStep => "agent" in step;
export const isGate = (step: Step): step is GateStep => "gate" in step;
export const isOutlet = (step: Step): step is OutletStep => "outlet" in step;
export const isParallel = (step: Step): step is ParallelStep => "parallel" in step;
export const isWait = (step: Step): step is WaitStep => "wait" in step;

export class FlowError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

// Rules that span steps, which the schema alone cannot express.
export function lint(flow: Flow): string[] {
  const problems: string[] = [];
  const seen = new Map<string, Step>();
  const gated = new Set<string>();
  // Outlet id -> the steps that had run when its gate's card was shown.
  const knownAtGate = new Map<string, Set<string>>();

  for (const step of flow.steps) {
    if (seen.has(step.id)) problems.push(`step "${step.id}" is defined twice`);

    const conditions = [step.when, isOutlet(step) ? step.auto_approve : undefined];
    for (const condition of conditions) {
      if (typeof condition !== "string") continue;
      try {
        compile(condition);
      } catch (error) {
        if (!(error instanceof ExprError)) throw error;
        problems.push(`step "${step.id}": ${error.message}`);
      }
    }

    if (isGate(step)) {
      for (const target of step.gate.approves) {
        const outlet = flow.steps.find((s) => s.id === target);
        if (!outlet || !isOutlet(outlet)) {
          problems.push(`gate "${step.id}" approves "${target}", which is not an outlet step`);
        } else if (seen.has(target)) {
          problems.push(`gate "${step.id}" must come before the outlet "${target}" it approves`);
        }
        gated.add(target);
        knownAtGate.set(target, new Set(seen.keys()));
      }
    }

    // Case data and earlier results reach an agent only inside the fence
    // (contracts.ts). A placeholder in `ask` would paste them outside it, as
    // if they were part of the instruction.
    if ((isAgent(step) || isParallel(step)) && placeholderNames(step.ask).size > 0) {
      problems.push(`step "${step.id}": "ask" must not contain {placeholders}; the agent already receives the case data and earlier results, fenced`);
    }

    // An approved action may only use what the approver could see: results
    // of steps that ran before the card. A later step could change the action
    // after the approval, which the runtime hash would then refuse.
    const known = isOutlet(step) ? knownAtGate.get(step.id) : undefined;
    if (isOutlet(step) && known) {
      for (const name of placeholderNames(step.outlet)) {
        if (name !== "case" && seen.has(name) && !known.has(name)) {
          problems.push(`outlet "${step.id}" uses "${name}", which runs after its approval card, so the approver never saw it`);
        }
      }
    }

    if (isOutlet(step) && !step.auto_approve && !gated.has(step.id)) {
      problems.push(
        `outlet "${step.id}" acts outside Switch with no approval: list it in a gate's ` +
          `"approves", or give it an auto_approve rule`,
      );
    }

    for (const name of referencedNames(step)) {
      if (name !== "case" && !seen.has(name)) {
        problems.push(`step "${step.id}" refers to "${name}", which is not "case" or an earlier step`);
      }
    }

    seen.set(step.id, step);
  }
  return problems;
}

const WORDS = new Set(["and", "or", "not", "true", "false", "null"]);

// The first path segment of every name a step reads, from its conditions and
// from `{placeholders}` in its text, so a typo fails lint instead of
// rendering as an empty string in an email.
function referencedNames(step: Step): Set<string> {
  const names = new Set<string>();
  const conditions = [step.when, isOutlet(step) ? step.auto_approve : undefined];
  for (const condition of conditions) {
    if (typeof condition !== "string") continue;
    const unquoted = condition.replace(/"[^"]*"|'[^']*'/g, "");
    for (const [word] of unquoted.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*/g)) {
      if (!WORDS.has(word)) names.add(word.split(".")[0]);
    }
  }
  for (const name of placeholderNames(isAgent(step) || isParallel(step) ? step.ask : isGate(step) ? step.gate.title : isOutlet(step) ? step.outlet : "")) {
    names.add(name);
  }
  return names;
}

function placeholderNames(value: unknown): Set<string> {
  const names = new Set<string>();
  for (const [, path] of JSON.stringify(value).matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g)) names.add(path.split(".")[0]);
  return names;
}

export function loadFlow(source: string): Flow {
  const parsed = Flow.safeParse(parseYaml(source));
  if (!parsed.success) {
    throw new FlowError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const problems = lint(parsed.data);
  if (problems.length > 0) throw new FlowError(problems);
  return parsed.data;
}

export function durationMs(duration: string): number {
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[duration.at(-1) as "s"];
  return Number(duration.slice(0, -1)) * unit;
}
