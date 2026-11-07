// A tiny expression language for `when:` conditions. It is parsed, never
// eval'd: flow files are written by people and agents, so they must not be
// able to run code.
//
//   case.amount > 500 or check.verdict == "needs_review"
//   not (manager == "reject")
//
// Names are dotted paths into the case context; a missing path is undefined,
// which compares unequal to everything and makes ordering comparisons false.

export type Scope = Record<string, unknown>;

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

const OPERATORS = ["==", "!=", ">=", "<=", ">", "<", "(", ")"];
const KEYWORDS: Record<string, unknown> = { true: true, false: false, null: null };

export class ExprError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
    } else if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) throw new ExprError(`unterminated string in: ${source}`);
      tokens.push({ kind: "str", value: source.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(i))!;
      tokens.push({ kind: "name", value: match[0] });
      i += match[0].length;
    } else {
      const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
      if (!op) throw new ExprError(`unexpected "${ch}" in: ${source}`);
      tokens.push({ kind: "op", value: op });
      i += op.length;
    }
  }
  return tokens;
}

// The parsed form is a closure over the scope, so a condition is parsed once
// at lint time and evaluated many times.
export type Compiled = (scope: Scope) => unknown;

export function compile(source: string): Compiled {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const isWord = (word: string) => peek()?.kind === "name" && peek()?.value === word;
  const isOp = (op: string) => peek()?.kind === "op" && peek()?.value === op;

  function parseOr(): Compiled {
    let left = parseAnd();
    while (isWord("or")) {
      pos++;
      const l = left;
      const r = parseAnd();
      left = (s) => Boolean(l(s)) || Boolean(r(s));
    }
    return left;
  }

  function parseAnd(): Compiled {
    let left = parseNot();
    while (isWord("and")) {
      pos++;
      const l = left;
      const r = parseNot();
      left = (s) => Boolean(l(s)) && Boolean(r(s));
    }
    return left;
  }

  function parseNot(): Compiled {
    if (isWord("not")) {
      pos++;
      const inner = parseNot();
      return (s) => !inner(s);
    }
    return parseComparison();
  }

  function parseComparison(): Compiled {
    const left = parseAtom();
    const token = peek();
    if (token?.kind !== "op" || token.value === "(" || token.value === ")") return left;
    pos++;
    const right = parseAtom();
    return (s) => compare(token.value, left(s), right(s));
  }

  function parseAtom(): Compiled {
    const token = tokens[pos++];
    if (!token) throw new ExprError(`unexpected end of: ${source}`);
    if (token.kind === "op" && token.value === "(") {
      const inner = parseOr();
      if (!isOp(")")) throw new ExprError(`missing ")" in: ${source}`);
      pos++;
      return inner;
    }
    if (token.kind === "num" || token.kind === "str") return () => token.value;
    if (token.kind === "name") {
      if (token.value in KEYWORDS) return () => KEYWORDS[token.value];
      const path = token.value.split(".");
      return (s) => lookup(s, path);
    }
    throw new ExprError(`unexpected "${token.value}" in: ${source}`);
  }

  const expression = parseOr();
  if (pos !== tokens.length) throw new ExprError(`unexpected "${tokens[pos].value}" in: ${source}`);
  return expression;
}

// The values a condition reads, by name: what a rule was decided on, recorded
// next to the action so anyone can evaluate the rule again.
export function inputsOf(source: string, scope: Scope): Record<string, unknown> {
  const names = tokenize(source).filter((t) => t.kind === "name" && !(t.value in KEYWORDS) && !["and", "or", "not"].includes(t.value));
  return Object.fromEntries(names.map((t) => [String(t.value), lookup(scope, String(t.value).split("."))]));
}

export function lookup(scope: unknown, path: string[]): unknown {
  let value: unknown = scope;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case "==":
      return (a ?? null) === (b ?? null);
    case "!=":
      return (a ?? null) !== (b ?? null);
  }
  if (typeof a !== "number" || typeof b !== "number") return false;
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
  }
  throw new ExprError(`unknown operator ${op}`);
}

// `{case.email}` placeholders in outlet fields and step instructions.
export function render(template: string, scope: Scope): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_, path: string) => {
    const value = lookup(scope, path.split("."));
    return value === undefined || value === null ? "" : String(value);
  });
}
