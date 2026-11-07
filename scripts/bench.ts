// Benchmarks of the deterministic engine alone: no model, no Switch, no
// network. Every number in docs/BENCHMARKS.md comes from running this file
// (`npm run bench`); it prints the machine, Node version and method with
// the results. Agents and Switch dominate end-to-end latency and are not
// measured here.
import { fork } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_CHECKS } from "../src/engine/decisions.ts";
import { Store } from "../src/engine/store.ts";

const WARMUP = 50;
const REPEATS = 500;

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: at(0.5), p95: at(0.95), n: s.length };
}
const ms = (n: number) => `${n < 1 ? n.toFixed(3) : n.toFixed(2)} ms`;
function time(fn: () => void, repeats = REPEATS): ReturnType<typeof stats> {
  for (let i = 0; i < WARMUP; i++) fn();
  const out: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return stats(out);
}

const HEAD = "| id | kind | to | resource | amount | until | decided by | basis |\n|---|---|---|---|---|---|---|---|\n";
const CAP = "| resource | available | unit | as of |\n|---|---|---|---|\n| gpu-hours | 10000000 | a month | 2026-11-01 |\n| engineers | 1000000 | people | 2026-11-01 |\n";
const rows = (n: number) => Array.from({ length: n }, (_, i) => `| C-${i} | capacity | Customer ${i} | ${i % 2 ? "gpu-hours" : "engineers"} | ${(i % 9) + 1} | 2027-0${(i % 9) + 1}-15 | @cto | contract ${i} |`).join("\n");
const NOW = Date.parse("2026-11-07T09:00:00Z");
const args = { doc: "commitments", capacity: "capacity", max_age_days: 31, start: "2026-12-01", weeks: 6, gpu_hours: 400, engineers: 3 };

if (process.argv[2] === "--worker") {
  // One of several processes reserving from the same database at once.
  const [path, worker, attempts] = [process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
  const store = new Store(path);
  let won = 0;
  for (let i = 0; i < attempts; i++) {
    const id = `w${worker}-${i}`;
    store.append(id, { type: "opened", flow: "contract-decision", room: "finance", data: {}, source: "bench" } as never);
    const r = store.reserve(id, [{ resource: "gpu-hours", amount: 7, start: "2026-12-01", until: "2027-12-01", to: id }], () => ({ capacity: 1000, committed: 0 }), new Date(NOW), new Date(NOW + 86_400_000));
    if (r.ok) won++;
  }
  store.close();
  process.send!({ won });
  process.exit(0);
}

console.log(`Switchyard engine benchmarks`);
console.log(`machine: ${cpus()[0].model}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB; Node ${process.version}; ${process.platform}`);
console.log(`method: ${WARMUP} warm-up runs, then ${REPEATS} timed runs each (performance.now), one process, nothing else of ours running\n`);

console.log("1. The commitments check (fail closed, full validation), by size of the commitments document");
for (const n of [100, 1000, 10000]) {
  const docs = [{ id: "c", name: "commitments", content: HEAD + rows(n) }, { id: "k", name: "capacity", content: CAP }];
  const ok = DECISION_CHECKS.commitments.run(args, docs, NOW).ok;
  const r = time(() => DECISION_CHECKS.commitments.run(args, docs, NOW), n >= 10000 ? 100 : REPEATS);
  console.log(`   ${String(n).padStart(6)} commitments: p50 ${ms(r.p50)}, p95 ${ms(r.p95)} (n=${r.n}, passes: ${ok})`);
}

console.log("\n2. Store.reserve (one SQLite transaction, file on disk), by number of open holds already there");
for (const n of [10, 100, 1000]) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sy-bench-")), "s.db"));
  for (let i = 0; i < n; i++) {
    store.append(`h${i}`, { type: "opened", flow: "contract-decision", room: "finance", data: {}, source: "bench" } as never);
    store.reserve(`h${i}`, [{ resource: "gpu-hours", amount: 1, start: "2026-12-01", until: "2027-12-01", to: "x" }], () => ({ capacity: 1e9, committed: 0 }), new Date(NOW), new Date(NOW + 86_400_000));
  }
  store.append("probe", { type: "opened", flow: "contract-decision", room: "finance", data: {}, source: "bench" } as never);
  const r = time(() => store.reserve("probe", [{ resource: "gpu-hours", amount: 1, start: "2026-12-01", until: "2027-12-01", to: "x" }], () => ({ capacity: 1e9, committed: 0 }), new Date(NOW), new Date(NOW + 86_400_000)), n >= 1000 ? 50 : 200);
  console.log(`   ${String(n).padStart(6)} open holds: p50 ${ms(r.p50)}, p95 ${ms(r.p95)} (n=${r.n})`);
  store.close();
}

console.log("\n3. Concurrency safety: 8 processes reserving 7 GPU-hours at a time from one 1,000 GPU-hour pool, same database file");
{
  const path = join(mkdtempSync(join(tmpdir(), "sy-bench-")), "s.db");
  new Store(path).close();
  const t = performance.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, w) => new Promise<number>((resolve, reject) => {
      const child = fork(new URL(import.meta.url).pathname, ["--worker", path, String(w), "40"], { execArgv: ["--disable-warning=ExperimentalWarning"] });
      child.on("message", (m: { won: number }) => resolve(m.won));
      child.on("error", reject);
    })),
  );
  const store = new Store(path);
  const held = store.holds(new Date(NOW)).reduce((n, h) => n + h.amount, 0);
  const won = results.reduce((a, b) => a + b, 0);
  console.log(`   320 attempts in ${Math.round(performance.now() - t)} ms: ${won} holds taken (at most ${Math.floor(1000 / 7)} fit), ${held} of 1,000 GPU-hours held: ${held <= 1000 && won === Math.floor(1000 / 7) ? "never over-allocated" : "OVER-ALLOCATED"}`);
  store.close();
}

console.log("\n4. A decision's proof: build and sign, then verify (re-running the five decision checks)");
{
  const { buildProof, signProof, verifyProof } = await import("../src/proof.ts");
  const store = await decisionStore();
  const key = generateKeyPairSync("ed25519").privateKey;
  const id = store.store.caseIds()[0];
  const proof = signProof(buildProof(store.store, store.flows, id), key);
  const b = time(() => signProof(buildProof(store.store, store.flows, id), key), 200);
  const v = time(() => verifyProof(proof, proof.signature!.fingerprint), 200);
  console.log(`   a ${proof.log.length}-event decision log, ${verifyProof(proof, proof.signature!.fingerprint).length} checks: build+sign p50 ${ms(b.p50)}, p95 ${ms(b.p95)}; verify p50 ${ms(v.p50)}, p95 ${ms(v.p95)}`);
}

console.log("\n5. Memory: heap after 2,000 commitments checks on a 10,000-row document");
{
  const docs = [{ id: "c", name: "commitments", content: HEAD + rows(10000) }, { id: "k", name: "capacity", content: CAP }];
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) DECISION_CHECKS.commitments.run(args, docs, NOW);
  globalThis.gc?.();
  const after = process.memoryUsage().heapUsed;
  console.log(`   heap used ${(before / 2 ** 20).toFixed(1)} MB before, ${(after / 2 ** 20).toFixed(1)} MB after${globalThis.gc ? " (after GC)" : " (run with --expose-gc for post-GC figures)"}`);
}
process.exit(0);

async function decisionStore() {
  const { decisionWorld } = await import("../src/chaos.ts");
  return decisionWorld();
}
