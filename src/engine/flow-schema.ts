import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { compile, ExprError } from "./expr.ts";
import { CHECKS } from "./checks.ts";

// Field types an agent step can demand in its JSON reply. An array of strings
// is an enum; a trailing "?" makes the field optional.
const FieldType = z.union([
  z.enum(["str", "str?", "number", "number?", "bool", "bool?", "list", "list?", "object", "object?"]),
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
    // Earlier gates whose answerer may not answer this one: four eyes, e.g.
    // the person who did the callback cannot also approve the change.
    not_same_as: z.array(z.string()).default([]),
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
    // Sets one row (matched on its first cell) of a table in a Switch room
    // document, such as a vendor's bank account in the vendor master.
    z.object({ document: z.object({ room: z.string(), name: z.string(), row: z.array(z.string()).min(1) }) }),
    // A payment instruction to the bank, keyed so it is made at most once.
    z.object({
      pay: z.object({ payee: z.string(), to: z.string(), amount: z.string(), currency: z.string().default("EUR"), reference: z.string() }),
    }),
  ]),
  // Runs with no human gate: always (true) or when a condition holds, such as
  // `case.amount <= 500`. Each use is a deliberate, reviewable exception.
  auto_approve: z.union([z.boolean(), z.string()]).default(false),
});

// Several agents work the step at once. The result holds each agent's
// answer under its name, plus `agreed`: whether every answer gave the same
// value for each enum and number field in `expect` (e.g. both said
// "accurate"), and `complete`: whether every agent answered.
// With `roles`, each agent has its own job: its role's `ask` comes before
// the shared one, and its `expect` adds to the shared fields. Agents with
// different jobs are not compared, so the flow decides with a code check.
const Role = z.object({ title: z.string(), ask: z.string(), expect: z.record(z.string(), FieldType).default({}) });
const ParallelStep = z.object({
  ...base,
  parallel: z.array(Handle).min(2),
  ask: z.string(),
  expect: z.record(z.string(), FieldType),
  roles: z.record(Handle, Role).optional(),
  sla: Duration.optional(),
});

// What one agent of a parallel step is asked, and must reply.
export function roleOf(step: ParallelStep, agent: string): { ask: string; expect: Record<string, FieldType>; title?: string } {
  const role = step.roles?.[agent];
  return role ? { ask: `${role.ask}\n\n${step.ask}`, expect: { ...step.expect, ...role.expect }, title: role.title } : { ask: step.ask, expect: step.expect };
}

// A check done by code (src/engine/verifiers.ts), not by a model. Its args
// may use {placeholders}; a value that is only a placeholder keeps its type.
const VerifyStep = z.object({
  ...base,
  verify: z.object({ check: z.string() }).catchall(z.unknown()),
});

// Pauses the case, e.g. three days before a follow-up. A person can end it
// early with `@yard resume <case>`.
const WaitStep = z.object({ ...base, wait: Duration });

export const Step = z.union([AgentStep, ParallelStep, GateStep, OutletStep, WaitStep, VerifyStep]);
export type Step = z.infer<typeof Step>;
export type AgentStep = z.infer<typeof AgentStep>;
export type GateStep = z.infer<typeof GateStep>;
export type OutletStep = z.infer<typeof OutletStep>;
export type WaitStep = z.infer<typeof WaitStep>;
export type ParallelStep = z.infer<typeof ParallelStep>;
export type VerifyStep = z.infer<typeof VerifyStep>;
export type Outlet = OutletStep["outlet"];

export const Flow = z.object({
  flow: z.string().regex(/^[a-z][a-z0-9-]*$/),
  room: z.string(),
  description: z.string().optional(),
  inlet: z.record(z.string(), z.unknown()).optional(),
  // Case fields that identify one business item (an invoice: supplier and
  // number). A second case for the same item is never opened, whichever way
  // it arrives.
  once_per: z.array(z.string().regex(/^case\.[a-z0-9_]+$/, "a case field like case.number")).optional(),
  steps: z.array(Step).min(1),
  // Assumption Watch: what a decision rests on after it is carried out. On
  // each tick, a closed case that carried out an action has each `recheck`
  // step run again on the room's documents as they are now; when `holds` is
  // false, the case is marked and a new case decides again.
  assumptions: z
    .array(z.object({ id: z.string(), title: z.string(), recheck: z.string(), holds: z.string().optional() }))
    .default([]),
});
export type Flow = z.infer<typeof Flow>;

export const isAgent = (step: Step): step is AgentStep => "agent" in step;
export const isGate = (step: Step): step is GateStep => "gate" in step;
export const isOutlet = (step: Step): step is OutletStep => "outlet" in step;
export const isParallel = (step: Step): step is ParallelStep => "parallel" in step;
export const isVerify = (step: Step): step is VerifyStep => "verify" in step;
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

    if (isGate(step)) {
      for (const other of step.gate.not_same_as) {
        const earlier = seen.get(other);
        if (!earlier || !isGate(earlier)) problems.push(`gate "${step.id}": not_same_as "${other}" is not an earlier gate`);
      }
    }

    if (isVerify(step) && !CHECKS[step.verify.check]) {
      problems.push(`step "${step.id}": unknown check "${step.verify.check}"; known checks: ${Object.keys(CHECKS).join(", ")}`);
    }

    // Case data and earlier results reach an agent only inside the fence
    // (contracts.ts). A placeholder in `ask` would paste them outside it, as
    // if they were part of the instruction.
    if (isParallel(step) && step.roles) {
      for (const agent of Object.keys(step.roles)) {
        if (!step.parallel.includes(agent)) problems.push(`step "${step.id}": role for ${agent}, who is not in "parallel"`);
        if (placeholderNames(step.roles[agent].ask).size > 0) problems.push(`step "${step.id}": the role "ask" for ${agent} must not contain {placeholders}`);
      }
    }
    if ((isAgent(step) || isParallel(step)) && placeholderNames(step.ask).size > 0) {
      problems.push(`step "${step.id}": "ask" must not contain {placeholders}; the agent already receives the case data and earlier results, fenced`);
    }

    // An approved action may only use what the approver could see: results
    // of steps that ran before the card. A later step could change the action
    // after the approval, which the runtime hash would then refuse.
    const known = isOutlet(step) ? knownAtGate.get(step.id) : undefined;
    // {by.<gate>} is who answered that gate. On the approving card it is not
    // known yet for that gate or any later one, so the action would hash
    // differently at execution and always be refused.
    if (isOutlet(step)) {
      for (const [, gate] of JSON.stringify(step.outlet).matchAll(/\{by\.([a-z][a-z0-9_]*)\}/g)) {
        const target = flow.steps.find((s) => s.id === gate);
        if (!target || !isGate(target)) problems.push(`outlet "${step.id}" uses {by.${gate}}, but "${gate}" is not a gate`);
        else if (known && !known.has(gate)) problems.push(`outlet "${step.id}" uses {by.${gate}}, which is not known until after its approval card`);
      }
    }
    if (isOutlet(step) && known) {
      for (const name of placeholderNames(step.outlet)) {
        if (!ROOTS.has(name) && seen.has(name) && !known.has(name)) {
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
      if (!ROOTS.has(name) && !seen.has(name)) {
        problems.push(`step "${step.id}" refers to "${name}", which is not "case", "this" or an earlier step`);
      }
    }

    seen.set(step.id, step);
  }
  for (const a of flow.assumptions) {
    const step = seen.get(a.recheck);
    if (!step || !isVerify(step)) problems.push(`assumption "${a.id}" re-checks "${a.recheck}", which is not a verify step of this flow`);
    if (a.holds) {
      try {
        compile(a.holds);
      } catch (error) {
        problems.push(`assumption "${a.id}": ${(error as Error).message}`);
      }
    }
  }
  return problems;
}

const WORDS = new Set(["and", "or", "not", "true", "false", "null"]);
// Names every step may read besides earlier steps: the case's data, who
// answered each gate, and the case itself ({this.id}).
const ROOTS = new Set(["case", "by", "this"]);

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
  for (const name of placeholderNames(isAgent(step) || isParallel(step) ? step.ask : isGate(step) ? step.gate.title : isOutlet(step) ? step.outlet : isVerify(step) ? step.verify : "")) {
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
