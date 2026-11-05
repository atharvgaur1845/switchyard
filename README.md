# Switchyard

**The operations layer for [Switch](https://github.com/sandbox-quantum/switch).** Work arrives from outside chat: an email, a web form, a schedule, a webhook, a visitor on your website. Switchyard turns each item into a case in a Switch room and walks it through your agents and your people, step by step. When the case reaches an action that leaves the company, such as sending an email, paying a supplier or replying to a customer, Switchyard carries out **exactly what a person approved, and nothing else**.

> Agents draft. People decide. Switchyard executes, and records every step in the room.

Switch puts agents in your team chat. Switchyard is what lets a team run a *process* there. Without it, a process is people @mentioning agents and hoping someone follows up.

## What it looks like

A flow is a short YAML file. Here is the expense flow, in full:

```yaml
flow: expense
room: ops-requests
inlet:
  form: { fields: [name, email:email, amount:number, category, reason:long] }
steps:
  - id: check                       # an agent does the work...
    agent: "@policy"
    ask: Check this expense against the expense policy document attached to this room.
    expect: { verdict: [ok, needs_review, reject], reasons: list }
    sla: 10m
    bench: "@policy-backup"         # ...and a backup on another vendor takes over if it stalls

  - id: manager                     # a person decides, on a card in Slack
    when: case.amount > 500 or check.verdict == "needs_review"
    gate:
      approver: "@manager"
      backup: "@finance-lead"
      title: "approve {case.name}'s expense?"
      options: [approve, reject]
      deadline: 4h
      approves: [record]

  - id: record                      # Switchyard acts, only on what was approved
    when: manager != "reject" and check.verdict != "reject"
    auto_approve: case.amount <= 500 and check.verdict == "ok"
    outlet:
      csv: { file: ledger.csv, row: ["{case.name}", "{case.amount}", "{case.category}"] }
```

What happens when someone submits the form:

1. **@yard opens a case thread** in `#ops-requests`. Everything about the case happens in that thread.
2. **It asks @policy** for the `check` step. The form data is wrapped as quoted *untrusted data*. The agent must end its reply with a JSON block that matches `expect`. If the block is malformed, the agent gets one corrected retry; after that, the case goes to a person.
3. **If the expense is over 500**, an approval card appears for the manager. It shows the exact ledger row that will be written, together with its hash.
4. **Deadlines are enforced.** At half the deadline the manager gets a reminder. At the deadline, `@finance-lead` gets a card of their own.
5. **The row is written only if** the hash of the row about to be written equals the hash that was approved. A receipt naming who approved it, and which hash, is posted to the thread.

## Six starter flows

| Flow | Comes in by | People decide | Switchyard does |
|---|---|---|---|
| `expense` | web form | manager, escalating to finance | ledger row |
| `client-quote` | email to `quotes@` | owner approves the price | emails the client the approved quote |
| `weekly-report` | every Monday 09:00 | manager publishes | posts to `#leadership` and emails it |
| `front-desk` | chat widget on your site | support reviews anything flagged | replies to the visitor |
| `onboarding` | web form | manager signs off | welcome email and access-request rows |
| `invoice-check` | signed webhook from accounting | controller, escalating to the CFO | payables row (auto when it matches the PO and is under 10k) |

Each flow comes with a **Switch template** in `templates/`. A template creates the room, the agents and the room documents (policy, rate sheet, FAQ, purchase orders), in one step from Switch Console. Every agent has a **backup agent on a different vendor**, so if Claude hits a usage limit, Codex picks up the step.

## How Switchyard uses Switch

Switchyard is a Switch agent. It is registered with the agent protocol, and everything it does goes through Switch:

| Switchyard needs | Switch provides |
|---|---|
| a place for each case | a room per flow, and a **thread** per case (`post_message` with `thread_id`) |
| work done by agents | managed agents from any vendor in that room, asked with `send_targeted_message` |
| agent replies | the room's event stream (`GET /agents/{id}/events`, SSE, resumable) |
| a human decision | **approval cards** on Slack, Teams, Discord and Mattermost (`/agent-sessions/{id}/approvals`) |
| who decided | the card's `answered_by`, matched against `list_participants` |
| the material agents work from | **room documents**, created by the templates |
| one-step setup | **Switch templates** (`version: 1`), with provider fallback lists |

Without Switch there is nowhere for the agents and people to meet, nobody to ask, and no card to approve.

## Run it with no accounts at all (local Mattermost)

The Switch repository's dev stack includes Mattermost. Switchyard can set everything up against it, and run the agents itself through a coding-agent CLI (`claude -p`, `pi -p`, `codex exec`), so you don't need Switch Console.

```bash
# in a Switch checkout: Postgres + Mattermost, then switch-core
just up && just run
# in this repo
npm install
SWITCH_ADMIN_EMAIL=... SWITCH_ADMIN_PASSWORD=... \
  npm run switchyard setup-local expense -- --user user --agent "claude -p --model haiku"
npm run switchyard up
```

`setup-local` signs in as the local admin and mints an API key. It then registers `@yard` and the flow's agents, creates `#ops-requests` in Mattermost with you in it, and writes `switchyard.yaml`. Each agent's instructions and its room documents are taken from the same template Console would install. In `switchyard.yaml`, set a backup agent to another CLI (for example `pi -p`) so it runs on a different vendor.

Open `http://localhost:4100/f/expense`, submit an expense over 500, and answer the card in Mattermost. Click the button, or reply `A1 yes` in the thread.

## Run it with Switch Console

You need **Node 24**, **Docker**, and **Switch Console** with its local server running and one chat app connected (Slack, Discord or Mattermost).

```bash
git clone <this repo> switchyard && cd switchyard
npm install
docker compose up -d                      # Mailpit: local inbox at http://localhost:8025
cp switchyard.example.yaml switchyard.yaml
cp .env.example .env                      # put a Switch personal API key in SWITCH_REGISTRATION_TOKEN
npm run switchyard register               # registers @yard; its key is saved to .env
```

Then, for each flow you want:

1. In Switch Console, create from `templates/<flow>.template.yaml`. This makes the room, the agents and the documents.
2. Add **@yard** to that room, and put the room's id in `switchyard.yaml` under `rooms:`.
3. In `switchyard.yaml` under `people:`, map the roles the flow names (`@manager`, `@owner`, …) to real chat handles. While you're trying it out, one person can fill every role.

```bash
npm run switchyard up
```

- Forms: `http://localhost:4100/f/expense` and `http://localhost:4100/f/onboarding`
- Chat widget: `http://localhost:4100/chat` (embed it with an `<iframe>`)
- Webhooks: `POST http://localhost:4100/in/invoice-check`, signed as `X-Switchyard-Signature: sha256=<hmac>`
- Email: anything sent to `quotes@acme.test` through Mailpit's SMTP (`localhost:1025`)
- Dashboard (localhost only): `http://localhost:4100/`

In the room, `@yard help` lists the chat commands: `flows`, `cases`, `status <case>`, `start <flow> key=value`, `cancel <case>`, `reassign <case> @agent`.

## Verified live

All six flows have been run end to end on a real Switch server with Mattermost. The agents were Claude Haiku and, as backups, Gemini (through the `claude` and `pi` CLIs), and the results were real:
- a ledger row and a payables row
- the client's quote email and the onboarding email
- the access-request row
- the report posted to `#leadership`
- an injection attempt held for staff
- a provider outage handled by the backup agent

The cases and outcomes are in [docs/DEMO.md](docs/DEMO.md), which is also the demo script. To show failover without waiting for a real outage, run `SWITCHYARD_OUTAGE=policy npm run switchyard up`. The named CLI agents then fail the way a rate-limited provider does, and say that the outage is simulated.

## Safety model

- **Outside text is data, not instructions.** Emails, forms, webhooks and visitors' messages reach agents only inside `<untrusted-data>`, with their source. Instructions come only from the flow file.
- **Two independent checks at the front desk.** A deterministic screen (`src/inlets/screen.ts`) flags injection patterns before any model sees the text, and the agent reports its own suspicion. An answer goes straight to the visitor only when both checks are clean. Otherwise a person reviews it. The test `holds an injection attempt for staff even when the agent is fooled` covers the case where the model is fooled and the screen still holds the reply.
- **Agents cannot act.** Agents facing outsiders have no tools. Only Switchyard's outlets touch the outside world, and an outlet runs only after a gate approval or an `auto_approve` rule written in the flow.
- **What you approved is what is sent.** The approval binds to a hash of the rendered action. If anything changes in between, such as an agent rewriting the email body after approval, the outlet refuses to run (`refuses to act when the action changed after approval`).
- **The right person decides.** A card can be clicked by anyone in the room, but only the gate's approver counts, plus the backup once the gate has escalated. Any other answer is refused, and the card is re-opened.
- **The dashboard is read-only**, and it is served only on localhost or with `SWITCHYARD_DASHBOARD_TOKEN`.

## Reliability

- **Every change to a case is appended to an event log** (SQLite) before the next step runs. State is never stored, only rebuilt from the log. After a crash or a laptop sleep, `up` carries on where it stopped, and nothing is repeated:
  - Reminders, escalations and outlets are logged.
  - CSV rows and visitor replies carry an idempotency key.
  - Emails carry a stable Message-ID.
- **Each inlet item is opened once**, even across restarts: an email id, a schedule slot.
- **The Switch connection** beats every 2 seconds, resumes from `Last-Event-ID`, and reopens when Switch drops it.

## Write your own flow

See [FLOWS.md](FLOWS.md). It is also written so any agent can use it: ask switch-buddy, or any agent in a room, to "write a Switchyard flow for our purchase requests", then run `npm run lint` on the result.

## Tests

```bash
npm test          # 90 tests
npm run typecheck
npm run lint      # checks every flow in flows/
```

The suite includes a fake Switch server that speaks the real wire protocol: SSE frames, heartbeats, operations with a connection id, and approvals answered by polling. The expense flow runs through it end to end, from an HTTP form post to the ledger row.

## Layout

```
src/engine/    flow schema + lint, expressions, contracts, gates, runner, event store, chat commands
src/switch/    the Switch agent-protocol client (SSE, heartbeat, ops, approvals)
src/inlets/    form, webhook, email (Mailpit), schedule, front-desk screen
src/outlets/   csv, email, webhook, room post, visitor reply; payload hashing
src/web/       dashboard and chat widget
flows/         the six starter flows
templates/     a Switch template per flow
```

## License

Apache-2.0
