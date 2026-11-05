// A stand-in for a model, for running Switchyard with no model account:
//   switchyard setup-local expense --agent "node src/agents/fixture-agent.ts"
// The CLI agent bridge runs it like `claude -p`: the request arrives on
// stdin and the reply goes to stdout. It answers from fixtures/replies.yaml,
// picking a rule by the case data, and echoes the step's token like a real
// agent must. Everything else (Switch, threads, cards, outlets) is real.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { lookup } from "../engine/expr.ts";

type Rule = { when?: Record<string, string>; reply?: Record<string, unknown>; default?: Record<string, unknown> };

export function fixtureReply(request: string, replies: Record<string, Rule[]>): string {
  // The last token in the request is the one in the reply format block; data
  // inside the fence has its quotes escaped, so it cannot supply a token.
  // The token in the reply-format block: the last ```json block of the request.
  const format = request.slice(request.lastIndexOf("```json"));
  const token = /"token": "(sy:[^"]+)"/.exec(format)?.[1];
  if (!token) return "I can only answer Switchyard step requests.";
  const step = token.split("/")[1].split(".")[0];

  const fences = [...request.matchAll(/<(untrusted-[0-9a-f]+)>\n([\s\S]*?)\n<\/\1>/g)];
  const data = fences.length > 0 ? (JSON.parse(fences.at(-1)![2]) as Record<string, unknown>) : {};

  const rules = replies[step];
  if (!rules) return `No fixture for step "${step}".`;
  const rule = rules.find((r) => r.default || matches(r.when ?? {}, data));
  if (!rule) return `No fixture rule matched for "${step}".`;
  const fields = fill(rule.reply ?? rule.default ?? {}, { case: data }) as Record<string, unknown>;

  return `(fixture agent, no model: canned reply for "${step}")\n\n\`\`\`json\n${JSON.stringify({ token, ...fields }, null, 2)}\n\`\`\``;
}

function matches(when: Record<string, string>, data: Record<string, unknown>): boolean {
  return Object.entries(when).every(([field, needle]) =>
    String(data[field] ?? "").toLowerCase().includes(String(needle).toLowerCase()),
  );
}

// Fills `{case.x}`. A value that is only a placeholder keeps the type of what
// it names, and a numeric string becomes a number, so `po_amount:
// "{case.amount}"` is a number whether the case holds 1240 or "1240".
function fill(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{([A-Za-z_][\w.-]*)\}$/.exec(value);
    if (whole) {
      const found = lookup(scope, whole[1].split("."));
      return typeof found === "string" && found.trim() !== "" && Number.isFinite(Number(found)) ? Number(found) : found;
    }
    return value.replace(/\{([A-Za-z_][\w.-]*)\}/g, (_, path: string) => String(lookup(scope, path.split(".")) ?? ""));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, scope)]));
  }
  return value;
}

if (import.meta.main) {
  const dir = process.argv[2] === "--fixtures" ? process.argv[3] : resolve(import.meta.dirname, "../../fixtures");
  const replies = parse(readFileSync(resolve(dir, "replies.yaml"), "utf8")) as Record<string, Rule[]>;
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => process.stdout.write(fixtureReply(Buffer.concat(chunks).toString("utf8"), replies)));
}
