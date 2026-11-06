# Switchyard

**Proof-carrying supplier payments, run by agents and people in [Switch](https://github.com/sandbox-quantum/switch) rooms.** A payment leaves only with evidence that it is the right one: agents investigate, code verifies, named people authorize, and the engine executes exactly what they approved.

> Nothing leaves the company unless a named person approved that exact action on a Switch card, or a rule written in the flow file allows it once the code checks pass. Nothing is paid on facts that changed after the checks ran, or on a vendor row someone edited in the room outside a case. Nothing is paid twice on one purchase order. And nothing goes to an account a person already refused without a person deciding again.

Each payment carries this chain, and each link is evidence someone can check on the card and in the event log:

1. **The source.** A signed webhook for invoices; for email, the sender's domain against the one on file, and the trusted mail gateway's SPF, DKIM and DMARC results when there is one.
2. **What the invoice says.** Two agents with different jobs, each quoting the invoice, and code keeping only the quotes that are really in it.
3. **The purchase order and the supplier.** Code matches the PO to the cent and the supplier's whole name, and the PO is paid once.
4. **Who holds the account.** The bank says so (Verification of Payee, in the sandbox), not the email, the callback or the vendor master.
5. **What other cases know.** An account people already refused, or one on file for another vendor, sends the case to a person.
6. **Named people.** A callback to the number on file, a different approver, and the controller for anything the rule cannot release, all on Switch cards.
7. **The exact action.** What was approved is what is sent, and what the bank holds: three equal hashes.

The one rule in the payment flow pays automatically only when all of these hold:
- both invoice agents answered, every figure the reader gave matches the invoice, every quote is in it, and the investigator found nothing;
- the bank confirms the vendor holds the account (or a factoring company the vendor is paid through, under an attested mandate);
- code finds the PO matches to the cent;
- the account on file was verified by a callback and has not changed in 30 days;
- the amount is at most 10,000.

Anything else goes to the controller's card.

A supplier emails: *"We changed banks. Please pay all open invoices to our new account today."* If accounts payable updates the record and pays, the money is usually gone for good. Switchyard is the back office that sits between that email and the payment:

- **Agents read the mess, with different jobs.** On a bank-change email, an agent pulls out the supplier, the new account and the pressure tactics. On an invoice, two agents on two vendors work at once: one reads it and quotes it, the other looks for signs of an attack and quotes those. Code keeps a quote only if it is in the invoice word for word.
- **Code decides the facts.** It checks whether the sender's domain is the supplier's own, or one a couple of characters away. It also checks the IBAN check digits, and whether the purchase order exists and matches to the cent.
- **People decide, in Switch.** A named person calls the number on file. A *different* person approves the change. A controller approves any payment the rules can't release.
- **Switchyard acts only on what was approved.** It writes the vendor's row in a Switch room document and pays through a bank that takes each payment once. It then reads the payment back and shows that the bank holds exactly the approved instruction.
- **Cases are linked through what people already decided.** When a person blocks a "we changed banks" request, or the supplier on the phone says the account is not theirs, that account is remembered. A later request for that account, even from the supplier's real domain, goes to the controller before anyone calls, and an invoice paying it goes to a person. A refusal also re-checks every open case on that account at once: a card shown before it stops counting. A single request can't show this case: a supplier's mailbox taken over after a look-alike attempt failed.
- **An Investigations view shows the whole picture.** Cases are grouped by the accounts that connect them, in a graph where every line is a recorded fact: who decided, in which case, when. It also shows what was invoiced, paid, held and still open, and which approvals stopped counting. A block is shown as a person's suspicion, never as proof, and nothing is scored.
- **The room remembers what Switchyard wrote.** Every row a code check reads is attested: Switchyard keeps the hash of the version it first saw or last wrote through a case. A purchase order is marked invoiced in the room before any money moves. So an account swapped into the vendor master by hand is never paid. A second invoice for the same order, under any number, is held with no pay button.

## See it in one minute, with no accounts

```bash
git clone https://github.com/atharvgaur1845/switchyard && cd switchyard
npm install          # Node 24 (see .nvmrc)
npm run demo:offline
```

This is the real engine, with three stand-ins: canned agent replies, approval cards clicked by the script, and a sandbox bank started in the same process. You will see:

1. **A "we changed banks" email from `fabrikarn.test`.** Code finds it is 2 characters away from `fabrikam.test` on file, the controller blocks it, and the real supplier is warned *at the address on file*.
2. **A Fabrikam invoice that prints a different account.** The investigator quotes the invoice's "Please note our new bank details", and code confirms the quote is in it. Code also finds the account differs from the vendor master. The card shows the payment going to the account *on file*, and it waits for the controller.
3. **The same account again, now from Fabrikam's real domain.** Every check on this email passes: right domain, valid IBAN, written in the email. But the account is the one the controller just blocked, so the controller decides before anyone calls, and the room is told which cases share the account.
4. **Meanwhile, a genuine change from Fabrikam's own domain.** A callback card goes to the AP clerk, who confirms. The clerk then tries to approve the change too and is refused (four eyes). The controller approves, and Switchyard writes the new account into the vendor master.
5. **The controller now clicks "pay" on the old invoice card.** Switchyard refuses to act, because the vendor master changed after the checks read it. It re-runs the checks on the new version and opens a new card. The old card, and any escalation or re-opened copy of it, no longer counts. Once approved, it marks PO-1043 as invoiced in the room, pays the new account through the bank and reads the payment back. All three hashes match: the approved one, the one sent and the bank's copy.
6. **Someone edits the vendor master in the room directly**, swapping Northwind's account and leaving the old date and the word "callback". The next Northwind invoice would have been paid by the rule. Instead it is held: the row is not the one Switchyard first saw, and no pay card is offered.
7. **A second Fabrikam invoice for the same order, under a new number.** PO-1043 now reads "invoiced FP-0912 (case …)", so the invoice is held, with no pay button.

The same run also shows an expense refused when the wrong person clicks, and a prompt-injection attempt at a website chat held for a person. Add `-- --serve` to keep a dashboard of the run's cases open at `http://localhost:4101`. Its Investigations tab shows the blocked account and the three cases it connects.

## What it looked like live, on Slack

The dashboard draws each case from its event log. These were recorded before the two invoice agents had separate jobs. This is case `60c4c081`: an invoice that printed the fraudster's account. Gemini's checker failed and Claude called it a mismatch ("split"). Code caught the account, the controller approved on the Slack card, and the payment went to the account *on file*. The bank's copy hashes to the approved action.

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
- **An edit made in the room, outside any case, moves no money.** Switch has no per-document permissions, so Switchyard keeps its own record: the full SHA-256 of every row a code check reads, as it first saw it when it started or as a case last wrote it. A check on a row that differs fails and says so. A vendor row edited by hand is never paid, even if a person clicks; a purchase order edited by hand goes to a person. Restoring the row by hand makes it pass again. Tests: "an account swapped in the room directly is never paid, and no pay card is offered", "a vendor added in the room directly is not paid", "an insider's edit while the card is open voids the approval and holds the invoice".
- **From chat, nobody can redirect a payment.** `@yard edit` refuses documents that code checks read, so the only way to change a bank account is a bank-change case. Invoices come in only through the signed webhook and bank changes only through the email inlet, never from `@yard start`. Other cases started by hand need a role. Tests: "cannot be edited from chat, even by someone who holds a role", "does not let anyone start a paying case from chat, even someone who holds a role".
- **One purchase order, one payment.** Before paying, the case marks the PO's row "invoiced <number> (case <id>)" in the room, and the PO check accepts only a status of exactly `open`. A later invoice on an invoiced PO, under any number, is held on a card with no pay button. Another case that checked the same PO sees its row change before it acts, so its approval no longer counts. An invoice is also opened once per supplier and invoice number (compared like names, so `FP-0912` and `FP 0912` are one invoice). Suppliers must match the PO's whole name. Tests: "a second invoice for an already invoiced PO, under a new number, is held with no pay button", "two cards open on one PO: once one is paid, the other's approval no longer counts", "pays one invoice once, however many times it arrives".
- **The bank says who holds the account.** Before any payment and any bank change, Switchyard asks the bank whether the vendor holds the account (Verification of Payee; the sandbox bank answers from `fixtures/payees.yaml`). On a match the rule may pay. On a close match the card shows the name the bank holds, and a person decides. When the bank cannot say, nothing is paid without a person. On no match, the invoice is held with no pay button, and the bank change fails its checks. A blocked request the bank called "no match" counts as evidence for other cases, even if it came from the vendor's own domain. A factoring company is paid only through an attested row of the `payment-mandates` room document; a row typed into the room by hand authorizes nothing. This evidence does not come from the email, the callback or the vendor master, so a fooled callback or an edited row cannot supply it. Tests: "holds the invoice, with no pay button, when the bank says someone else holds the account on file", "sends a close match to a person, with the name the bank holds", "pays a factoring company only under an attested mandate row", "fails a request from the vendor's own domain when the bank says the account is someone else's, and the block is evidence".
- **The agent's reading is checked against the email.** The new IBAN must appear in the email itself, and the callback card has the supplier read out the whole account. Agent steps ignore replies typed by people, and `@yard reassign` moves a step only to one of the flow's agents. Tests: "an account the email does not contain is not accepted from the agent", "a person typing the agent's reply in the thread is ignored".
- **The invoice agents' evidence is checked, not trusted.** The reader's supplier, number, amount, PO and account must match the invoice. An account it reads must be in the invoice, and if the invoice text names another account than its account field, a person decides. The investigator's findings count only with a quote that is in the invoice. A suspicious verdict, a made-up quote or an agent that is down sends the invoice to a person. None of this can make a payment happen: the other checks still decide. Tests: "sends a misread amount or a made-up quote to a person", "catches invoice text that asks for another account than its account field", "keeps a finding only when its quote is in the invoice".
- **The mail gateway's word, when there is one.** An email inlet can name the company's mail gateway as trusted. Then Switchyard reads that gateway's SPF, DKIM and DMARC results from the topmost `Authentication-Results` header only, and ignores a planted one below it. A DMARC failure fails a bank-change request ("the From address is forged"). Without a trusted gateway the card says "sender not authenticated", which is never treated as a pass. A `Reply-To` on another domain also fails the request. Tests: "believes only the trusted gateway's header, and only the topmost one", "a forged From on the vendor's real domain fails the bank-change check", "a Reply-To on another domain fails it; the same domain does not".
- **Only a card's own options decide.** An answer that is not one of them (a forged one, or from an older card) is ignored. Test: "an answer that is not one of the card's options decides nothing".
- **Four eyes.** A gate with `not_same_as: [callback]` refuses the person who made the call and re-opens the card. Test: "needs a callback and a second person, then changes exactly one row".
- **An approval on old facts never pays.** Every check records the hash of each room document it read. Before any action, Switchyard re-reads those documents. If one changed, it sends nothing, re-runs the checks from that point on the new version, and opens a new card. Tests: "does not pay on an approval given before the vendor master changed", "is not written if the vendor master changed after the checks read it".
- **What was approved is what is sent, and what the bank holds.** The card shows the rendered action and its hash. The outlet refuses if the action no longer hashes the same. The bank's copy is read back and must hash the same too. Tests: "pays the account on file by rule, and the bank's copy hashes to the approved action", "refuses to act when the flow file changed the action after approval".
- **At most once per key.** Each payment uses the case and step as its idempotency key. The sandbox bank returns the same payment for a retry and refuses a different body under the same key; that refusal means something is already held under the key, so the case goes to a person rather than reporting "nothing was sent". When a person answers "it went out" on a payment in doubt, Switchyard reads the payment back from the bank by its key before believing it. Tests: "is paid at most once per key, and refuses a different payment under the same key", "'it went out' is not believed when the bank holds no such payment".
- **Further guards:**
  - a redelivered webhook opens no second case ("opens one case and says the second delivery was a duplicate");
  - the same answer arriving twice records one decision ("records one decision when the same answer arrives twice at once");
  - a send that dies midway goes to a person as *in doubt* if repeating it could do it twice (an email, a webhook): "never loses an action: every approved case ends executed or with a person";
  - actions that are safe to repeat (a keyed payment, a keyed row, setting a document row) are repeated, unless the documents they rest on changed while they were in flight, and then a person decides;
  - a card from before a re-check cannot be answered into a payment ("cannot pay: an escalation card shown before the vendor master changed is ignored").
- **Outside text is data, not instructions.** Emails, invoices and forms reach agents only inside a fence with a random tag per request. Tests: "fences outside data off from instructions", "cannot be closed from inside the data".
- **Agents cannot act.** Every agent CLI is started with its tools, MCP servers and settings switched off, and Switchyard refuses to start one it cannot lock down. Test: "refuses a CLI it cannot lock down".
- **Two vendors, so one outage doesn't stop the room.** The two invoice agents run on different vendors (Claude and Gemini), and one that cannot answer sends the invoice to a person rather than stopping it. The bank-change agent and most other agent steps have a backup agent on another vendor; the weekly report's review step has none. On case `94221172` the Claude checker hit its real usage limit mid-run, and the case still went to a person with the evidence it had.

## Links between cases

A check on one request cannot see that its account is the one a person blocked an hour ago. So Switchyard derives links from its own event log, exactly, by compact IBAN:

- **Refused account.** An account named in a bank-change request that people refused, in one of two ways:
  - a person answered "block". This counts only when the sender is not the vendor's own domain, or the mail gateway called its From forged;
  - the supplier, called on the number on file, did not confirm it. This counts from any sender, and is how a compromised mailbox shows.

  Either way, the email itself must name the account, and it must be on file for no vendor. So naming a vendor's real account in a look-alike email does not get that account flagged. Links last 180 days.
- **Another vendor's account.** The account is on file for a different vendor.

A link never blocks and never changes a payment. It sends the case to a person, with the evidence on the card, and tells the room which cases share the account. What an approval rests on includes the kinds of link on its account. When a person blocks a request, every open case on that account is checked again at once, except a case waiting on whether an action went out, which is only told. Blocks from a second, different sender are stronger evidence, so they make an open approval on the account stop counting once more. Any further block, or the same sender again, only adds a note to the case's thread. So a flood of blocks re-checks a case at most twice. Changes to another vendor's row can change it again, and after three re-checks a case goes to a person. The block is recorded when it is answered. If people later see the link, choose "call anyway" and approve a change to that account, the link is cleared for later cases. Tests: "the real domain asking for an account a look-alike asked for goes to the controller before any call", "a block voids an open callback card in another case on the same account, at once", "a block from a second, different sender voids an approval given after the first, once", "a callback the supplier does not confirm is evidence, even for a request from its own domain", "blocking a look-alike that names the vendor's real account does not flag that account".

### The Investigations view

The dashboard's Investigations tab groups cases by the accounts that connect them. Only an account with a recorded fact against it joins cases: one people refused, or one on file for two vendors. An ordinary account on file never does, or every invoice from one supplier would look like one incident. For each group it shows:

- **a graph** of cases, accounts and vendors. Each line is a fact you can click: requested, printed on an invoice, paid, refused by a person, cleared, on file for;
- **the evidence** behind each line: its source, the case, who decided, when, and a status that keeps suspicion apart from fact ("blocked by a person: suspected, not confirmed fraud");
- **the impact**: what was invoiced and paid, and to which account, what is still open and waiting on whom, how many approvals stopped counting, and what was held;
- **a timeline** across the cases, in the event log's order.

![The Investigations view: one blocked account connecting three cases, with the evidence behind each line](docs/img/investigations.png)

It is read from the event log (`src/web/investigations.ts`), like everything else on the dashboard. Test: "the Investigations view groups the cases one blocked account connects, with the facts behind each line".

### The attack lab

`npm run lab` runs nine scenarios on the real engine and flows, with fixture agents and a sandbox bank: each with links between cases off, then on, under two answer policies.

- **First option.** Every card is answered with the option it proposes, as a hurried person clicking the first button would. On the cards that stop money, the safe option is listed first ("block", "hold"), so this policy measures the cards' design as much as the checks.
- **Real callback.** The same, except that the callback reaches the real supplier, who confirms only an account that is really theirs.

Euros come from the bank's ledger and cards from what was shown. The scenarios were written by the same person who wrote the checks, so this shows what each control does; it is not a detection rate.

Each cell: euros paid to the attacker's accounts · cards shown to people.

| | Scenario | First option, links off | First option, links on | Real callback, links off | Real callback, links on | Outcomes (first option, links on) |
|---|---|---|---|---|---|---|
| attack | Look-alike domain asks to change Fabrikam's account | 0 · 1 | 0 · 1 | 0 · 1 | 0 · 1 | Blocked · supplier warned |
| attack | Compromised mailbox: the real domain asks for the account a look-alike was blocked on, then an invoice | **3,150 EUR** · 4 | 0 · 2 | 0 · 2 | 0 · 2 | Paid, Held · linked to another case, Blocked · supplier warned |
| attack | Compromised mailbox first; the look-alike is blocked while its callback card is open | **3,150 EUR** · 4 | 0 · 3 | 0 · 2 | 0 · 3 | Paid, Blocked · supplier warned, Held · linked to another case |
| attack | Invoice prints the account a look-alike was blocked on | 0 · 2 | 0 · 2 | 0 · 2 | 0 · 2 | Paid, Blocked · supplier warned |
| attack | Insider swaps Northwind's account in the vendor master, then an invoice | 0 · 1 | 0 · 1 | 0 · 1 | 0 · 1 | Held · row edited in the room |
| benign | Genuine bank change from Fabrikam's own domain, then an invoice | 0 · 3 | 0 · 3 | 0 · 3 | 0 · 3 | Paid, Updated |
| benign | Two vendors paid through one factoring account | 0 · 0 | 0 · 1 | 0 · 0 | 0 · 1 | Paid |
| benign | Poisoning: a look-alike names Fabrikam's genuine new account first, then Fabrikam changes to it | 0 · 3 | 0 · 2 | 0 · 3 | 0 · 2 | Held · linked to another case, Blocked · supplier warned |
| benign | Poisoning: a look-alike names Fabrikam's real account and is blocked, then an ordinary invoice | 0 · 1 | 0 · 1 | 0 · 1 | 0 · 1 | Paid, Blocked · supplier warned |

Every card answered with its first option: 6,300 EUR paid to attacker accounts with links off, 0 EUR with links on; benign scenarios held or waiting for a person: 0 with links off, 1 with links on; cards on benign scenarios: 7 and 7.
The same, but the callback reaches the real supplier: 0 EUR paid to attacker accounts with links off, 0 EUR with links on; benign scenarios held or waiting for a person: 0 with links off, 1 with links on; cards on benign scenarios: 7 and 7.

What it shows: links matter when the callback is skipped or fooled. With a callback that reaches the real supplier, the compromised mailbox is stopped without them, and links add evidence and an earlier stop. The costs are on the benign side: a shared factoring account gets a card, and a genuine change whose account a look-alike named first is held until the controller chooses "call anyway". `test/lab.test.ts` pins these numbers.

### Held-out scenarios

The nine scenarios above were written alongside the checks. The 20 in `lab/heldout/` were written afterwards by a separate author, briefed only with [lab/FORMAT.md](lab/FORMAT.md): the company, its suppliers, the process it promises and the scenario format. The author did not read the code, flows or tests. The brief describes what a correct company must end up with, not how Switchyard checks anything. Every scenario states its expected outcome, and these were committed (`73c9dca`, with `FROZEN.sha256`) before the first run. `npm run lab -- --heldout` runs them, links off and on, with people doing their job: every card answered with its first option, and the callback as each scenario says (it reaches the real supplier, or it is fooled). It also counts what reaches the attacker when every callback is fooled.

**The first run** ([lab/heldout/FIRST-RUN.md](lab/heldout/FIRST-RUN.md)):
- With links off, 17 of 20 met every expectation. With links on, 16 did, and 0 EUR went to attacker accounts either way.
- It found two real bugs. A second invoice on an already invoiced PO could still be paid by a click (H07, H08). An answer that was not one of a card's options counted as a decline (H14). Both are fixed.
- It also showed a cost of links: a shared factoring account is held (H05).

**After those fixes the numbers below are no longer held out**, since the engine changed after the failures were seen:

Each cell: meets every expectation · euros paid to the attacker's accounts · cards shown to people.

| | Family | Kind | Scenario | Links off | Links on | Every callback fooled: EUR to attacker, off / on | What did not match (links on) |
|---|---|---|---|---|---|---|---|
| H01 | identity | attack | Look-alike domain asks to move Northwind, and the callback is fooled | pass · 0 · 2 | pass · 0 · 2 | 0 / 0 | — |
| H02 | identity | attack | Forged From on contoso.test with a Reply-To elsewhere, then a "corrected IBAN" retry | pass · 0 · 3 | pass · 0 · 3 | 0 / 0 | — |
| H03 | identity | benign | Genuine Tailspin bank change sent by treasury, not the listed contact | pass · 0 · 3 | pass · 0 · 3 | 0 / 0 | — |
| H04 | beneficiary | attack | "One-off, master data unchanged": pay this Fabrikam invoice to the printed account | pass · 0 · 2 | pass · 0 · 2 | **3,150** / **3,150** | — |
| H05 | beneficiary | benign | Northwind and Fabrikam both assign receivables to the same factoring account | pass · 0 · 6 | **fail** · 0 · 5 | 0 / 0 | b: not changed, expected changed; d: paid to DE29100500000190183746, expected DE12500105170648489890 |
| H06 | beneficiary | benign | Contoso really changes banks, but its next invoice still prints the old account | pass · 0 · 3 | pass · 0 · 3 | 0 / 0 | — |
| H07 | invoice | attack | Paid Northwind invoice resubmitted under a new number with an attacker account | pass · 0 · 2 | pass · 0 · 2 | 0 / 0 | — |
| H08 | invoice | attack | Tailspin's 12,400 PO split into two 6,200 invoices to stay under the limit | pass · 0 · 2 | pass · 0 · 2 | 0 / 0 | — |
| H09 | invoice | benign | Three clean invoices, one of them over the automatic limit | pass · 0 · 3 | pass · 0 · 3 | 0 / 0 | — |
| H10 | insider | attack | Insider edits Fabrikam's IBAN in the vendor master just before a genuine invoice | pass · 0 · 1 | pass · 0 · 1 | 0 / 0 | — |
| H11 | insider | attack | Insider raises Contoso's PO to 9,900 so an inflated invoice "matches" under the limit | pass · 0 · 1 | pass · 0 · 1 | 0 / 0 | — |
| H12 | temporal | attack | Tailspin's IBAN is edited in the master while its 12,400 invoice waits for approval | pass · 0 · 3 | pass · 0 · 3 | 0 / 0 | — |
| H13 | temporal | attack | Attacker in Northwind's mailbox sends a "correction" while a genuine change awaits its callback | pass · 0 · 4 | pass · 0 · 4 | **1,240** / **1,240** | — |
| H14 | temporal | benign | Fabrikam genuinely changes banks a week after a look-alike tried the same | pass · 0 · 4 | pass · 0 · 4 | 0 / 0 | — |
| H15 | poisoning | attack | Tailspin bank-change email tells the AI the change was already verified by phone | pass · 0 · 2 | pass · 0 · 2 | **12,400** / **12,400** | — |
| H16 | poisoning | attack | Fabrikam invoice claims a change order that "amends" PO-1043, and both checkers believe it | pass · 0 · 1 | pass · 0 · 1 | 0 / 0 | — |
| H17 | poisoning | attack | A compromised Contoso mailbox asks to change Tailspin's account, and the callback is fooled | pass · 0 · 2 | pass · 0 · 2 | 0 / 0 | — |
| H18 | collaboration | attack | Controller records the callback as confirmed and then approves the change themself | pass · 0 · 2 | pass · 0 · 2 | 0 / 0 | — |
| H19 | collaboration | attack | Clerk tries to pay a 9,950 Contoso invoice with no PO, just under the limit | pass · 0 · 2 | pass · 0 · 2 | 0 / 0 | — |
| H20 | collaboration | benign | Controller on leave, so the CFO approves a genuine Fabrikam change and pays the next invoice | pass · 0 · 5 | pass · 0 · 5 | 0 / 0 | — |

Links off: 20/20 scenarios meet every expectation (attacks 14/14, benign 6/6); 0 EUR to attacker accounts; 53 cards (24 on benign scenarios); 1 approvals stopped counting; 3 answers refused.

Links on: 19/20 scenarios meet every expectation (attacks 14/14, benign 5/6); 0 EUR to attacker accounts; 52 cards (23 on benign scenarios); 1 approvals stopped counting; 3 answers refused.

Every callback fooled: 16,790 EUR to attacker accounts with links off, 16,790 EUR with links on.

Upper bound, with a bank that knows who holds each account (built from each scenario's own description of its accounts, so not held out): 19/20 meet every expectation (not met: H05); 0 EUR to attacker accounts; with every callback fooled, 0 EUR.

What this says, plainly:
- **On these 20 scenarios, links between cases add nothing.** People doing their job stop every attack with or without them, and links cost one benign scenario (H05).
- **With every callback fooled, the same three single-case attacks pay with links off and on**: an invoice-borne "one-off" redirect, a "correction" from a compromised mailbox, and an email telling the agent it was "already verified by phone". A callback to the number on file and a second approver are what stop them. Two more of the author's attacks (H02, H18) set a `Reply-To` on another domain. They were caught only after that became a check.
- **What links add is the attacks in the nine scenarios above**: the account a person already refused, coming back through a compromised mailbox while the callback is skipped or fooled.
- **The scenarios never said who holds each account, so the bank answers "unavailable" in this run**, and no invoice is paid without a person (more cards, same outcomes). The last line is the upper bound with a bank that knows the answer, built from each scenario's own roles for its accounts. It is not a held-out result. It shows that payee verification closes what the fooled callbacks let through: 16,790 EUR becomes 0. It also shows the cost that remains: the factoring company (H05) is held, because no mandate for it is on file.

`test/lab.test.ts` pins these numbers and checks the frozen files' hashes.

## Attacks, and what stops each

The look-alike email, the clerk approving their own callback and the approval on old facts were stopped from the start. The others paid, or misled a person, on an earlier version of this code; a separate red-team review found them, and `test/adversarial.test.ts` now runs each one and checks that it is stopped.

| Attack | What stops it | Test |
|---|---|---|
| "We changed banks" from a look-alike domain | Code compares the sender's domain with the one on file | "from a look-alike domain is blocked, and the real supplier is warned at the address on file" |
| Same invoice resent, or renumbered (`FP-0913`, `FР-0912` with a Cyrillic Р) | Business-key dedupe, and the PO is marked invoiced in the room: the second is held with no pay button | "a second invoice for an already invoiced PO, under a new number, is held with no pay button" |
| One PO split into two invoices under the limit (held-out H08) | The first reserves the PO; the second is held | held-out H08 in `test/lab.test.ts` |
| Two cards for one PO approved one after the other | The second case's PO row changed: its approval is void, and it re-checks | "two cards open on one PO: once one is paid, the other's approval no longer counts" |
| A new vendor called "Fabrikam" invoicing on Fabrikam Print's PO | Whole-name match; PO status must be exactly `open` | "a supplier named only part of the name on the PO is not that supplier" |
| An insider swaps an IBAN in `vendor-master` and types "callback" | Row attestation: the row is not the one Switchyard saw or wrote | "an account swapped in the room directly is never paid, and no pay card is offered" |
| An insider adds a vendor and a PO by hand | Rows without attestation do not pass | "a vendor added in the room directly is not paid" |
| A vendor row edited while a pay card is open | Re-check before acting; the edited row is held | "an insider's edit while the card is open voids the approval and holds the invoice" |
| An email whose agent reading names a different IBAN (injection or a model's slip) | The IBAN must appear in the email | "an account the email does not contain is not accepted from the agent" |
| A person types the agent's JSON reply, or reassigns the step to themselves | Agent steps ignore people; reassign only to the flow's agents | "a person typing the agent's reply in the thread is ignored" |
| A clerk confirms the callback and approves the change | `not_same_as: [callback]` | "needs a callback and a second person, then changes exactly one row" |
| A compromised supplier mailbox asks for the account a look-alike was blocked on | Link to the blocked case: the controller decides before any call | "the real domain asking for an account a look-alike asked for goes to the controller before any call" |
| The same, with the callback card already open when the look-alike is blocked | The block re-checks the open case; its callback card stops counting | "a block voids an open callback card in another case on the same account, at once" |
| The supplier says on the phone "not our account", then the same mailbox tries again | The failed callback is evidence: the retry, and any invoice printing that account, go to the controller | "a callback the supplier does not confirm is evidence, even for a request from its own domain" |
| A forged `From` on the supplier's real domain | With a trusted mail gateway, DMARC fail fails the request; without one, the card says "not authenticated" and the callback still decides | "a forged From on the vendor's real domain fails the bank-change check" |
| A `Reply-To` pointing somewhere else (held-out H02, H18) | The request fails its checks | "a Reply-To on another domain fails it; the same domain does not" |
| An investigator "finding" or reader quote made up by a model | Kept only if the quote is in the invoice; a misreading goes to a person | "keeps a finding only when its quote is in the invoice" |
| A forged card answer that is not one of the card's options | Ignored | "an answer that is not one of the card's options decides nothing" |
| A vendor row that looks right (and was attested) but names someone else's account | The bank says no match: held, no pay button | "holds the invoice, with no pay button, when the bank says someone else holds the account on file" |
| A mule account opened under a name close to the supplier's | The bank says close match, and the card shows the name it holds; a person decides | "sends a close match to a person, with the name the bank holds" |
| A mandate row typed into the room to make a third party payable | Unattested rows authorize nothing | "pays a factoring company only under an attested mandate row" |
| An approval given before the facts changed | Document basis re-checked before any action | "does not pay on an approval given before the vendor master changed" |
| "It went out" on a payment the bank never received | Read back by key from the bank | "'it went out' is not believed when the bank holds no such payment" |

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
npm run switchyard demo send bank-change          # the look-alike email
npm run switchyard demo send bank-change-real     # the genuine change
npm run switchyard demo send bank-change-mailbox  # the real domain naming the look-alike's account
npm run switchyard demo send fabrikam-invoice     # an invoice printing another account
npm run switchyard demo send fabrikam-invoice-2   # the same PO again, under a new number
npm run switchyard demo send insider-edit         # writes vendor-master directly, outside any case
npm run switchyard demo send northwind-invoice    # would be paid by the rule; held after the edit
npm run switchyard demo send insider-restore      # puts Northwind's row back
```

`insider-edit` uses @yard's own key over a second, short-lived connection to write the document directly, the way anyone with write access to it could. That connection never polls for card answers. For a clean recording, stop Switchyard and run `npm run switchyard demo reset`. It moves the event log and the bank ledger aside (it never deletes them) and puts the two finance documents back to the template.

Answer the cards in Slack: click the button, or reply `A1 block` in the case thread (Switch's own typed-answer form). The dashboard at `http://localhost:4100` (localhost only) draws each case from its event log. Its Investigations tab groups the cases an account connects. It shows the agents on their two vendors, the code checks with the document versions they read, the approval arcs with their hashes, and the receipts. The sandbox bank's ledger is at `http://localhost:4300`.

In the room, `@yard help` lists the commands: `cases`, `status`, `docs`, `cancel`, `reassign`, `resume`, and `edit <document> "old" "new"`. `edit` is for people who hold a role, and the room is told the old and new versions. It is refused for any document a code check reads, such as `vendor-master` and `purchase-orders`: those decide payments by themselves, so they change only through a flow with its own checks and four eyes.

## What is real and what is simulated

- **Real:**
  - Switch (agent protocol, rooms, threads, cards, room documents) and Slack.
  - The agents: Claude Haiku and Gemini Flash Lite, through the `claude` and `pi` CLIs.
  - The emails, delivered through Mailpit.
  - The engine, its event log and its checks.
- **Simulated, and labelled so:**
  - The bank. A local sandbox, `src/sandbox/bank.ts`; no real money moves. Its answers about who holds an account come from a registry file, not a bank's records.
  - The suppliers, their `.test` domains and IBANs. They are fictitious, with valid check digits.
- **One person.** The live run had one Slack user holding every role. There, four eyes shows as the refusal. The approval by a second person is shown in `demo:offline` and in the tests.

## Known limits

- **Sender authentication needs a trusted mail gateway.** Switchyard does not verify SPF, DKIM or DMARC itself; it reads the results the company's own gateway wrote. The local setup has no gateway (Mailpit), so live cards say "sender not authenticated", and a forged `From` on the right domain passes the domain check there. That is why a passing change still needs a callback to the number on file and a second approver. The gateway must remove incoming `Authentication-Results` headers that carry its name, as RFC 8601 requires; otherwise a planted one could sit on top.
- **Who holds an account comes from a sandbox registry.** The check digits catch typos only; the payee check is as good as the bank's answer, and here that answer comes from `fixtures/payees.yaml`, which we wrote. A mule account opened in exactly the supplier's name would match, as it can with real Verification of Payee. A close match (like the demo attacker's "Fabrikam Print Services s.r.o.") goes to a person, and a hurried person can still pay it. That is why the links between cases and the callback stay. Real Verification of Payee covers SEPA payments in the EU; elsewhere the bank may not answer, and then nothing is paid without a person.
- **Attestation trusts the documents as they stand when Switchyard first starts.** `up` attests a document it has never seen and posts the rows it attested to the room, so anyone can check that baseline. An edit made before that first start is accepted. A check never adopts a document: one that was never attested passes nothing. Attestations persist across restarts.
- **The event log is append-only by convention, not tamper-evident.** Someone with access to the SQLite file could rewrite it, and the row attestations live in the same file. Approvals, document versions, read-backs and row attestations are all full SHA-256; cards and screens show the first 16 hex digits. Cases logged by earlier versions stored shorter hashes, and these still match the full hash they begin with.
- **One engine process.** Switch's `update_room_document` has no version precondition, so the PO reservation and the vendor-master write rely on the engine's single queue.
- **A clerk can hold a genuine change.** Answering "not-confirmed" on a callback records the account as refused, so an insider holding the clerk role can send a genuine new account to the controller until someone chooses "call anyway". It cannot move money.
- **The held-out scenarios are a regression set, not a benchmark.** Twenty scenarios from one author, run on fixture agents that read what the scenario says they read, graded against that author's expectations. Their first run is the only held-out result; later numbers came after fixes.
- **Links come from this company's own decisions only.** Switchyard has no network data on accounts across companies, as commercial vendor-verification services do. A link needs people to have refused a request first, and links expire after 180 days. Two vendors that really share an account, such as through a factoring company, get a card every time.
- **Exact names and whole POs.** "Fabrikam Print GmbH" against "Fabrikam Print" goes to a person, and so does a second, partial invoice against a PO that is already invoiced.
- **Some controls fail closed, at a cost.** Two rows with the same vendor name hold every payment to that vendor until a person removes one. A PO reserved by a case whose payment the bank then refuses stays reserved until a person reopens it.
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
- **Per-document write permissions.** Today anyone who can write to a room's documents can rewrite the vendor master, which is why Switchyard attests rows itself.
- **A version precondition on `update_room_document`.** Today a write replaces the content unconditionally. Switchyard re-reads and compares just before it writes, which leaves a small race window that only Switch can close.
- **Inbound webhooks and schedules for agents.** Today Switchyard provides these itself.
- **A room-document view in Console.** 0.40.1 has none, which is why rules are edited with `@yard edit`.

## Tests

```bash
npm test             # 279 tests
npm run lab          # the attack lab, links off and on
npm run lab -- --heldout   # the 20 held-out scenarios
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
src/web/       the dashboard (cases, investigations, flows) and the chat widget
lab/           the held-out scenarios, the brief they were written from, and their first run
flows/         the flows; templates/ has a Switch template for each
```

## License

Apache-2.0
