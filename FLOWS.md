# Writing a Switchyard flow

A flow is one YAML file in `flows/`, named `<flow>.flow.yaml`. These rules are complete and short, so a person or an agent can write a flow from a plain description of a process. Check the result with `npm run lint`.

## Shape

```yaml
flow: purchase-request        # lower-case, dashes allowed
room: ops-requests            # the Switch room the cases live in
description: Purchase request # shown when a case opens
inlet: { ... }                # where cases come from (one inlet per flow)
steps: [ ... ]                # run top to bottom
```

## Inlets

| Inlet | Example | The case data is |
|---|---|---|
| `form` | `form: { fields: [name, email:email, amount:number, details:long] }` | the submitted fields; types are `text` (default), `email`, `number`, `long` |
| `email` | `email: { to: quotes@acme.test, trusted_gateway: mx.acme.test }` | `from`, `from_name`, `subject`, `body`, `received`, `reply_to`, and `auth`: what the trusted gateway's topmost `Authentication-Results` header says (SPF, DKIM, DMARC), or why it is unavailable |
| `schedule` | `schedule: { cron: "0 9 * * MON", data: { period: last week } }` | `data` plus `scheduled_for` |
| `webhook` | `webhook: { secret_env: HOOK_SECRET, map: { amount: order.total } }` | the JSON body, or the `map`ped fields |
| `frontdesk` | `frontdesk: { title: Ask us }` | `question`, plus `flagged` and `flags` from the screen |

## Steps

Every step has an `id` (lower case, `_` allowed) and an optional `when:` condition. A step whose condition is false is skipped.

**Agent step.** Asks one agent in the room to do one thing, and requires a structured answer.

```yaml
- id: check
  agent: "@policy"                 # lower-case handle of an agent in the room
  ask: Check this against the policy document in this room.
  expect:                          # the JSON fields the reply must end with
    verdict: [ok, needs_review]    # a list means "one of these"
    reasons: list                  # str, number, bool, list; add ? for optional (str?)
  sla: 10m                         # optional: no answer by then -> the bench agent
  bench: "@policy-backup"          # optional: the agent that takes over
```

**Parallel.** Several agents do the same step independently, ideally on different vendors.

```yaml
- id: match
  parallel: ["@checker", "@checker-backup"]
  ask: Match this invoice against the purchase orders.
  expect: { result: [match, mismatch, no_po], reasons: list }
  sla: 10m                         # a missing answer by then -> a person
```

The result holds each agent's answer under its name (`match.checker.result`), plus `match.agreed` and `match.complete`. `agreed` is true when every agent gave the same value for every enum and number field; `complete` when every agent answered. A typical rule: `when: match.agreed == false` sends the case to a person.

With `roles`, the agents still work at once but each has its own job. A role's `ask` comes before the shared one, and its `expect` adds to the shared fields. Agents with different jobs are not compared, so follow the step with a code check that weighs what they said. The invoice flow does this with `agent_evidence`, which keeps a quote only if it is in the invoice.

```yaml
- id: review
  parallel: ["@checker", "@checker-backup"]
  ask: Every quote you give must be copied word for word from the invoice data.
  expect: {}
  roles:
    "@checker":
      title: invoice reader
      ask: Report the supplier, number, amount, account and PO, with quotes.
      expect: { supplier: str, number: str, amount: number, iban: str?, po: str?, quotes: list }
    "@checker-backup":
      title: fraud investigator
      ask: Look for signs that this invoice is an attack, each with a quote.
      expect: { verdict: [clear, suspicious], findings: list }
- id: evidence
  verify: { check: agent_evidence, forensics: "{review.checker}", investigator: "{review.checker-backup}", supplier: "{case.supplier}", number: "{case.number}", amount: "{case.amount}", iban: "{case.iban}", po: "{case.po}", text: "{case.text}" }
```

**Wait.** Pauses the case, e.g. before a follow-up. A person can end it early with `@yard resume <case>`.

```yaml
- id: three_days
  wait: 3d
```

**Gate.** A person decides, on an approval card in the room.

```yaml
- id: manager
  gate:
    approver: "@manager"           # a role; switchyard.yaml `people:` says who fills it
    backup: "@finance-lead"        # optional: may decide once the deadline passes
    title: "approve {case.name}'s expense?"
    options: [approve, reject]     # the FIRST option is the one that authorizes
    deadline: 4h                   # optional: reminder at half, escalation at the end
    approves: [record]             # the outlet steps this answer authorizes
```

**Outlet.** Switchyard acts outside Switch. An outlet must be listed in an earlier gate's `approves`, or carry an `auto_approve` rule.

```yaml
- id: record
  outlet:
    csv: { file: ledger.csv, row: ["{case.name}", "{case.amount}"] }
  # or  email:   { to: "{case.email}", subject: "...", body: "{draft.text}" }
  # or  webhook: { url: https://..., body: { id: "{case.id}" } }
  # or  post:    { room: leadership, body: "..." }
  # or  visitor: { body: "{answer.reply}" }      (front desk only)
  auto_approve: case.amount <= 500 and check.verdict == "ok"   # optional
```

**Assumptions.** What a decision rests on after it is carried out. On each tick, a closed case that carried out an action has each `recheck` step (a verify step) run again on the room's documents as they are now. When `holds` is false (default: the step's `ok`), the case is marked, its thread says why, and a new case of the same flow decides again with `case.reconsider` set to the first case's id. Nothing the first case did is undone.

```yaml
assumptions:
  - id: capacity
    title: the capacity the counteroffer reserved is still there
    recheck: counter_fit
```

**Checks for company decisions** (`src/engine/decisions.ts`):
- `commitments` reads the `commitments` document (one row per promise: id, kind, to, resource, amount, until, decided by, basis) and the `capacity` document, and passes when the resources asked for are free for the whole window after the promises already made. It names every promise in the way and who made it, and watches `capacity`, so an approval stops counting when capacity changes. It fails closed: any shortfall fails, whether or not a promise explains it; a missing, negative or non-numeric request, a missing or duplicated capacity row, a capacity report older than `max_age_days` (or undated, or dated ahead), and a promise without a readable amount or `YYYY-MM-DD` date each stop the check.
- `constitution` reads the `policy` document (rule, limit, set by) and computes the margin and any new fixed cost itself from the policy's own rates. The margin is for the first contract year (a year of revenue after the discount, against a year of GPU-hours and the one-off rollout team); every term it needs, including GPU-hours and engineers, must be there, or the check fails.
- Each decision check records its arguments, the documents it read and the clock, so `verify-proof` runs it again and compares the result.
- `dissent` keeps every objection from each role (`by_<role>` arguments), with its quote and where it is in the proposal; an objection whose quote is not there is set aside. What code found binding against the proposal is listed too, and no card answer overrides it.

An agent's `expect` can also ask for an `object` (or `object?`), such as a counteroffer.

## Names you can use

- `case.<field>` is the case data from the inlet.
- `<step id>` is that step's result:
  - for an agent step, its JSON fields (`check.verdict`);
  - for a gate, the chosen option (`manager == "reject"`);
  - for a parallel step, each agent's answer by name plus `agreed` and `complete`.
- A name may only point at `case` or at a step **above** it. Lint rejects anything else.

Placeholders `{like.this}` work in `ask`, gate titles and outlet fields. Conditions use `==`, `!=`, `>`, `>=`, `<`, `<=`, `and`, `or`, `not`, parentheses, numbers and quoted strings.

## Rules lint enforces

- Every outlet is approved by an earlier gate or has an `auto_approve` rule.
- A gate comes before the outlets it approves.
- Step ids are unique, and conditions parse.
- Every name refers to `case` or to an earlier step.
- Handles are lower case, so chat apps turn them into real mentions.

## Checklist for a good flow

- Put the agents' reference material (policy, prices, FAQ) in **room documents**. Don't put it in `ask`.
- Every action that leaves the company sits behind a gate. Use `auto_approve` only for cases cheap enough that a mistake doesn't matter.
- Give every agent step an `sla` and a `bench` agent on a different vendor.
- Ship a Switch template next to the flow (`templates/<flow>.template.yaml`) that creates the room and its agents.

## Holding capacity, and noisy assumptions

- A gate can name a commitments check in `reserve:`. When the gate's first option is chosen, what that check found the decision needs is held in one SQLite transaction against the capacity, the commitments already written and every other open decision's hold. If it no longer fits, the answer does not count and the checks run again with the hold counted. A hold lapses when its decision ends or after two days, and is released when the decision's approval is voided. Lint checks that `reserve:` names an earlier commitments check.
- An assumption takes `confirm` (failing re-checks in a row before it breaks, default 1: a hard fact breaks at once) and `recover` (passing re-checks in a row before a suspect assumption clears, default 1). While an assumption is suspect, no new capacity is held in its room.
