# Switchyard

**Supplier payments a fraudster cannot redirect, run by agents and people in [Switch](https://github.com/sandbox-quantum/switch) rooms.**

> Nothing leaves the company unless a named person approved that exact action on a Switch card, or a rule written in the flow file allows it once the code checks pass. Nothing is paid on facts that changed after the checks ran.

The one rule in the payment flow pays automatically only when all of these hold:
- the two checkers agree;
- code finds the PO matches to the cent;
- the account on file was verified by a callback and has not changed in 30 days;
- the amount is at most 10,000.

Anything else goes to the controller's card.

A supplier emails: *"We changed banks. Please pay all open invoices to our new account today."* If accounts payable updates the record and pays, the money is usually gone for good. Switchyard is the back office that sits between that email and the payment:

- **Agents read the mess.** An agent pulls the supplier, the new account and the pressure tactics out of the email.
- **Code decides the facts.** It checks whether the sender's domain is the supplier's own, or one a couple of characters away. It also checks the IBAN check digits, and whether the purchase order exists and matches to the cent.
- **People decide, in Switch.** A named person calls the number on file. A *different* person approves the change. A controller approves any payment the rules can't release.
- **Switchyard acts only on what was approved.** It writes the vendor's row in a Switch room document and pays through a bank that takes each payment once. It then reads the payment back and shows that the bank holds exactly the approved instruction.

## See it in one minute, with no accounts

```bash
git clone https://github.com/atharvgaur1845/switchyard && cd switchyard
npm install          # Node 24 (see .nvmrc)
npm run demo:offline
```

This is the real engine, with three stand-ins: canned agent replies, approval cards clicked by the script, and a sandbox bank started in the same process. You will see:

1. **A "we changed banks" email from `fabrikarn.test`.** Code finds it is 2 characters away from `fabrikam.test` on file, the controller blocks it, and the real supplier is warned *at the address on file*.
2. **A Fabrikam invoice that prints a different account.** The two checkers agree it matches PO-1043, but code finds the account differs from the vendor master. The card shows the payment going to the account *on file*, and it waits for the controller.
3. **Meanwhile, a genuine change from Fabrikam's own domain.** A callback card goes to the AP clerk, who confirms. The clerk then tries to approve the change too and is refused (four eyes). The controller approves, and Switchyard writes the new account into the vendor master.
4. **The controller now clicks "pay" on the old invoice card.** Switchyard refuses to pay, because the vendor master changed after the checks read it. It re-runs the checks on the new version and opens a new card. The old card, and any escalation or re-opened copy of it, no longer counts. Once approved, it pays the new account through the bank and reads the payment back, and all three hashes match: the approved one, the one sent and the bank's copy.

The same run also shows an expense refused when the wrong person clicks, and a prompt-injection attempt at a website chat held for a person.

## What it looked like live, on Slack

The dashboard draws each case from its event log. This is case `60c4c081`: an invoice that printed the fraudster's account. Gemini's checker failed and Claude called it a mismatch ("split"). Code caught the account, the controller approved on the Slack card, and the payment went to the account *on file*. The bank's copy hashes to the approved action.

![The invoice case: two checkers, code checks with the document versions they read, the approval arc and the three-hash receipt](docs/img/invoice-paid.png)

And case `1c5cc185`, the look-alike bank-change email. The block card was answered in Slack, and the warning went to the supplier's address on file:

![The blocked bank-change case](docs/img/bank-change-blocked.png)

## How Switch is used, and what breaks without it

| Switchyard needs | Switch provides | Without Switch |
|---|---|---|
| **A system of record that agents, code and people all read** | **Room documents** (`vendor-master`, `purchase-orders`). Checks read them, every agent request is grounded in them, and bank-change cases write them. | No shared, versioned rules. The checks would read a file nobody in the room can see. |
| **A decision with a name on it** | **Approval cards** in Slack (`/agent-sessions/{id}/approvals`), with **participant identity** on each answer (`answered_by`, matched to `list_participants`) | Nobody to hold to four eyes, and no record of who decided. |
| **A place for each case** | A **room** per team (`#finance`) and a **thread** per case | Cases scattered across inboxes. |
| **Work done by agents** | Agents in the room, asked with **targeted messages** and answering on the room's **event stream** (SSE, heartbeat, resumable) | No agents to ask. |
| **One-step setup** | **Templates** (`templates/*.template.yaml`) that create the room, its agents and its documents | Manual setup, room by room. |

Switchyard itself is a Switch agent (`@yard`) on the agent protocol. Remove Switch and you lose more than notifications. You lose the shared documents the checks run on, the identity that four eyes rests on, and the cards the decisions are made on.

## What makes it hard to fool

Each claim is a test in `test/` (named in quotes), or a case recorded live (see [docs/DEMO.md](docs/DEMO.md)).

- **Money goes only to the account on file.** The `pay` outlet's account comes from the `vendor_bank` check on the vendor master, never from the invoice. Tests: "pays the account on file even when the invoice prints another one, after a person decides".
- **Look-alike domains are caught by code**, using edit distance against the domain on file. The warning goes to the contact on file, never to the sender. Tests: "refuses a change from a look-alike domain and says why", "from a look-alike domain is blocked, and the real supplier is warned at the address on file".
- **One insider can't redirect a payment from chat.** `@yard edit` refuses documents that code checks read, so from chat the only way to change a bank account is a bank-change case. Payment and bank-change cases come in only through their own signed inlet, never from `@yard start`. Other cases started by hand need a role. An invoice is opened once per supplier and invoice number (compared like names, so `FP-0912` and `FP 0912` are one invoice), however it arrives. Tests: "cannot be edited from chat, even by someone who holds a role", "does not let anyone start a paying case from chat, even someone who holds a role", "pays one invoice once, however many times it arrives". Anyone with direct write access to the room's documents in Switch is outside this: Switch has no per-document permissions to use.
- **Four eyes.** A gate with `not_same_as: [callback]` refuses the person who made the call and re-opens the card. Test: "needs a callback and a second person, then changes exactly one row".
- **An approval on old facts never pays.** Every check records the hash of each room document it read. Before any action, Switchyard re-reads those documents. If one changed, it sends nothing, re-runs the checks from that point on the new version, and opens a new card. Tests: "does not pay on an approval given before the vendor master changed", "is not written if the vendor master changed after the checks read it".
- **What was approved is what is sent, and what the bank holds.** The card shows the rendered action and its hash. The outlet refuses if the action no longer hashes the same. The bank's copy is read back and must hash the same too. Tests: "pays the account on file by rule, and the bank's copy hashes to the approved action", "refuses to act when the flow file changed the action after approval".
- **At most once.** Each payment uses the case and step as its idempotency key. The sandbox bank returns the same payment for a retry and refuses a different body under the same key. Test: "is paid at most once per key, and refuses a different payment under the same key".
- **Further guards:**
  - a redelivered webhook opens no second case ("opens one case and says the second delivery was a duplicate");
  - the same answer arriving twice records one decision ("records one decision when the same answer arrives twice at once");
  - a send that dies midway goes to a person as *in doubt* if repeating it could do it twice (an email, a webhook): "never loses an action: every approved case ends executed or with a person";
  - actions that are safe to repeat (a keyed payment, a keyed row, setting a document row) are repeated, unless the documents they rest on changed while they were in flight, and then a person decides;
  - a card from before a re-check cannot be answered into a payment ("cannot pay: an escalation card shown before the vendor master changed is ignored").
- **Outside text is data, not instructions.** Emails, invoices and forms reach agents only inside a fence with a random tag per request. Tests: "fences outside data off from instructions", "cannot be closed from inside the data".
- **Agents cannot act.** Every agent CLI is started with its tools, MCP servers and settings switched off, and Switchyard refuses to start one it cannot lock down. Test: "refuses a CLI it cannot lock down".
- **Two vendors, so one outage doesn't stop the room.** The two invoice checkers run on different vendors (Claude and Gemini). The bank-change agent and most other agent steps have a backup agent on another vendor; the weekly report's review step has none. On case `94221172` the Claude checker hit its real usage limit mid-run, and the case still went to a person with the evidence it had.

## Run it live on Switch and Slack

You need Node 24, Docker (for Mailpit, a local mail catcher), and a Switch server with a chat app connected. We used Switch Console 0.40.1's local server with Slack.

```bash
npm install
docker compose up -d                     # Mailpit: local SMTP on :1025, inbox at http://localhost:8025
cp switchyard.example.yaml switchyard.yaml
cp .env.example .env                     # set INVOICE_HOOK_SECRET to any long random string
# Registers @yard and the agents, creates #finance (on Slack with --bridge) and writes switchyard.yaml.
# It signs in as the server's local admin, read from the environment and never printed.
# bank-change runs in the same #finance room with the same agents, so it needs no setup of its own.
SWITCH_ADMIN_EMAIL=... SWITCH_ADMIN_PASSWORD=... \
  npm run switchyard setup-local invoice-check -- --user <your chat username> --bridge <bridge id>
npm run bank                             # the sandbox bank, a separate process with its own ledger
npm run switchyard up                    # puts vendor-master and purchase-orders into the #finance room
```

In `switchyard.yaml`, map the roles to people under `people:`: `@controller`, `@ap-clerk`, `@cfo`. One person may hold several roles, but four eyes still keeps the callback and the approval apart. Then:

```bash
npm run switchyard demo send bank-change        # the look-alike email
npm run switchyard demo send bank-change-real   # the genuine change
npm run switchyard demo send fabrikam-invoice   # an invoice printing another account
```

Answer the cards in Slack: click the button, or reply `A1 block` in the case thread (Switch's own typed-answer form). The dashboard at `http://localhost:4100` (localhost only) draws each case from its event log. It shows the checkers on their two vendors, the code checks with the document versions they read, the approval arcs with their hashes, and the receipts. The sandbox bank's ledger is at `http://localhost:4300`.

In the room, `@yard help` lists the commands: `cases`, `status`, `docs`, `cancel`, `reassign`, `resume`, and `edit <document> "old" "new"`. `edit` is for people who hold a role, and the room is told the old and new versions. It is refused for any document a code check reads, such as `vendor-master` and `purchase-orders`: those decide payments by themselves, so they change only through a flow with its own checks and four eyes.

## What is real and what is simulated

- **Real:**
  - Switch (agent protocol, rooms, threads, cards, room documents) and Slack.
  - The agents: Claude Haiku and Gemini Flash Lite, through the `claude` and `pi` CLIs.
  - The emails, delivered through Mailpit.
  - The engine, its event log and its checks.
- **Simulated, and labelled so:**
  - The bank. A local sandbox, `src/sandbox/bank.ts`; no real money moves.
  - The suppliers, their `.test` domains and IBANs. They are fictitious, with valid check digits.
- **One person.** The live run had one Slack user holding every role. There, four eyes shows as the refusal. The approval by a second person is shown in `demo:offline` and in the tests.

## Known limits

- **The sender check reads the email's `From` address.** It does not verify SPF or DKIM, so a forged `From` on the right domain passes the domain check. That is why a passing change still needs a callback to the number on file and a second approver.
- **A re-check re-runs the code checks and the gates after them.** It does not re-ask agent steps that ran before the check.
- **One slow action holds the engine's queue** for up to its timeout (60 s), because calls into the engine run one at a time.

## The same engine runs other flows

Flows are YAML files (see [FLOWS.md](FLOWS.md)), checked by `npm run lint`:

| Flow | Comes in by | People decide | Switchyard does |
|---|---|---|---|
| `invoice-check` | signed webhook | the controller, escalating to the CFO | pays through the bank, read back |
| `bank-change` | email to `ap@` | AP clerk (callback), then a different approver | writes the vendor master |
| `expense` | web form | manager, escalating to finance | ledger row |
| `client-quote` | email to `quotes@` | owner approves the price | emails the quote, then a follow-up 3 days later |
| `weekly-report` | every Monday 09:00 | manager publishes | posts to `#leadership` and emails it |
| `front-desk` | chat widget on a website | support reviews anything flagged | replies to the visitor |
| `onboarding` | web form | manager signs off | welcome email and access-request rows |

## What Switch could add (found while building this)

- **Approval outcomes on the event stream.** Today they are polled, so a decision can take a poll interval to land.
- **A stable handle in `answered_by`.** Today it is a bridge-specific id that has to be matched back to a participant by username.
- **A version precondition on `update_room_document`.** Today a write replaces the content unconditionally. Switchyard re-reads and compares just before it writes, which leaves a small race window that only Switch can close.
- **Inbound webhooks and schedules for agents.** Today Switchyard provides these itself.
- **A room-document view in Console.** 0.40.1 has none, which is why rules are edited with `@yard edit`.

## Tests

```bash
npm test             # 219 tests
npm run typecheck
npm run lint         # every flow in flows/
npm run demo:offline
```

CI runs all four on pushes to main and on pull requests. The suite includes a fake Switch server that speaks the real wire protocol (SSE frames, heartbeats, operations with a connection id, approvals answered by polling), and the sandbox bank over real HTTP.

## Layout

```text
src/engine/    flow schema and lint, expressions, contracts, gates, runner, event store, code checks, chat commands
src/switch/    the Switch agent-protocol client (SSE, heartbeat, ops, approvals, room documents)
src/agents/    locked-down CLI agents, and the fixture agent for offline runs
src/inlets/    form, webhook, email (Mailpit), schedule, front-desk screen
src/outlets/   bank payment, room document, csv, email, webhook, room post, visitor reply; payload hashing
src/sandbox/   the sandbox bank
src/web/       the dashboard and the chat widget
flows/         the flows; templates/ has a Switch template for each
```

## License

Apache-2.0
