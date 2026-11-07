# Benchmarks

The deterministic engine on its own: the decision checks, the reservation ledger, and proofs. No model, no Switch, no network. Agents and Switch dominate end-to-end latency (seconds), so they are not in these numbers, and nothing here is compared with a model call.

Run it yourself:

```bash
npm run bench
```

`scripts/bench.ts` prints the machine, the Node version and the method with its results. The figures below are one run of it, pasted as printed.

## Method

- One process, 50 warm-up runs, then 500 timed runs per measurement (100 for the 10,000-row check, 50 for 1,000 open holds), timed with `performance.now()`. p50 and p95 are the 50th and 95th percentile of those runs.
- The commitments check runs with full validation (every row parsed and checked; fail closed) on a generated document of the given size, half GPU-hour and half engineer promises.
- `Store.reserve` runs against a SQLite file on disk (not `:memory:`), with the given number of other open decisions already holding capacity.
- Concurrency: 8 separate processes, each with its own connection to the same database file, each trying 40 holds of 7 GPU-hours from one 1,000 GPU-hour pool at the same time. At most 142 fit. The check is that the holds taken never exceed the pool.
- The proof is a carried-out contract decision from the Chaos Lab's world (fixture agents).

## Results

```
Switchyard engine benchmarks
machine: 13th Gen Intel(R) Core(TM) i7-13620H, 16 threads, 15 GB; Node v24.14.0; linux
method: 50 warm-up runs, then 500 timed runs each (performance.now), one process, nothing else of ours running

1. The commitments check (fail closed, full validation), by size of the commitments document
      100 commitments: p50 0.081 ms, p95 0.160 ms (n=500, passes: true)
     1000 commitments: p50 0.686 ms, p95 0.909 ms (n=500, passes: true)
    10000 commitments: p50 6.84 ms, p95 7.79 ms (n=100, passes: true)

2. Store.reserve (one SQLite transaction, file on disk), by number of open holds already there
       10 open holds: p50 0.066 ms, p95 0.085 ms (n=200)
      100 open holds: p50 0.232 ms, p95 0.276 ms (n=200)
     1000 open holds: p50 1.87 ms, p95 1.98 ms (n=50)

3. Concurrency safety: 8 processes reserving 7 GPU-hours at a time from one 1,000 GPU-hour pool, same database file
   320 attempts in 256 ms: 142 holds taken (at most 142 fit), 994 of 1,000 GPU-hours held: never over-allocated

4. A decision's proof: build and sign, then verify (re-running the five decision checks)
   a 34-event decision log, 52 checks: build+sign p50 1.42 ms, p95 1.52 ms; verify p50 2.55 ms, p95 2.79 ms

5. Memory: heap after 2,000 commitments checks on a 10,000-row document
   heap used 20.7 MB before, 20.3 MB after (after GC)
```

## What the numbers say

- The commitments check is linear in the size of the commitments document: about 0.7 µs per promise. A company with 10,000 open promises is checked in under 8 ms.
- A hold costs under 2 ms with 1,000 other decisions holding capacity. The first version took 380 ms at 1,000 holds, because it rebuilt every holding case from its log to see whether it was still open; the benchmark found it, and one SQL query replaced it.
- Eight processes on one database file never over-allocated: exactly the 142 holds that fit were taken. `BEGIN IMMEDIATE` takes the write lock before reading, and a 5-second busy timeout makes a second engine wait for it instead of failing.
- Verifying a decision's proof, including running its five decision checks again, takes under 3 ms.
- Memory stays flat over 2,000 checks of a 10,000-row document.

These are one laptop's figures; run the script on yours.
