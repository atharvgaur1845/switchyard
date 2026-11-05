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
| `email` | `email: { to: quotes@acme.test }` | `from`, `from_name`, `subject`, `body`, `received` |
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

The result holds each agent's answer under its name (`match.checker.result`), plus `match.agreed`. That is true when every agent gave the same value for every enum field. A typical rule: `when: match.agreed == false` sends the case to a person.

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

## Names you can use

- `case.<field>` is the case data from the inlet.
- `<step id>` is that step's result:
  - for an agent step, its JSON fields (`check.verdict`);
  - for a gate, the chosen option (`manager == "reject"`);
  - for a parallel step, each agent's answer by name plus `agreed`.
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
