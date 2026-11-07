# Demo script (about 5 min; trim to taste)

**Opening line:** "Agents shouldn't run a company. They should investigate, argue and plan inside a system that knows what the company has already promised, and lets named people decide. Switchyard is that system: the control plane for consequential decisions and the actions that carry them out. Payments were its first application; company decisions are the second."

Screen: Slack (`#finance`) on the left, the console (`localhost:4100`) on the right, open on **Command**. Keep Mailpit (`localhost:8025`) and the sandbox bank (`localhost:4300`) in tabs, and a terminal for the `demo send` commands.

Disclose on screen from the first frame:

> Slack, Switch, the agents (Claude Haiku and Gemini) and the emails are real, and so are the two people. The bank, its answers about who holds an account, the suppliers, the customer and the company's commitments, capacity and policy are sandbox data.

## Before recording

1. Switch Console's local server is running with Slack connected, and `#finance` was created with `setup-local invoice-check --bridge <slack bridge id>`. Re-running `setup-local` updates the two agents' descriptions to their new jobs; it is optional, since each step's request carries the job.
2. **Two people, two Slack users, both in `#finance`.** In `switchyard.yaml` under `people:`:
   - `@ap-clerk` and `@cto`: person A (makes the callbacks, co-signs decisions);
   - `@controller` and `@cfo`: person B (chooses on decisions, blocks, holds, approves, pays).

   The handles are their Switch usernames. Check that each sees the other's answers on the cards.
3. **A clean slate.** With Switchyard stopped, run:

   ```bash
   npm run switchyard demo reset
   ```

   It moves the event log and the bank ledger aside and puts the room's documents (`vendor-master`, `purchase-orders`, `commitments`, `capacity`, `policy`) back to the template.
4. Start the services:

   ```bash
   docker compose up -d
   npm run bank
   npm run switchyard up
   ```

   The first `up` on this version creates the `commitments`, `capacity` and `policy` documents in `#finance`. After a reset, `#finance` gets one message per document listing the rows Switchyard attested. `npm run bank` now answers who holds each account from `fixtures/payees.yaml`; restart it so it picks that up.
5. Warm up the agents: send one input and check that both answer. The decision asks each agent twice (four jobs), so expect about a minute before the CFO's card. Gemini's free tier can return 429. If it does, the case still works: the invoice goes to a person with "the investigator could not answer".
6. Agent replies take 10–20 s. Cut the waits in the edit but keep the timestamps visible. Never call a cut "live".

---

## 0:00 – The thesis (15 s)

On the console's **Command** view: the chain, nine links, each counted from the log. Say the opening line.

## 0:15 – A contract proposal (60 s)

```bash
npm run switchyard demo send contract-proposal
```

- **Slack, case thread:** four jobs on two agents (finance desk, engineering desk, operations desk, red team), each with a position and objections that quote the proposal.
- **Code, in the thread:** "✗ commitments: needs 500 GPU-hours a month … 400 of 1,000 are free: C-101 holds 600 for Northwind Paper until 2027-03-31 (decided by @cto) …" and "✗ constitution: max discount 15% (set by @cfo): 25% … min year-1 margin 30%: 28.5% (code, first contract year: …) … new fixed costs this quarter 0 INR (set by board): 1,080,000 a year, to buy the GPU-hours that are already promised to others". Then the counteroffer, both ✓.
- **The card for B (CFO):** "counter Tailspin Analytics's proposal? … breaks 4 company rules … promises already made stand in its way (C-101, C-102, C-103). The counteroffer passes both. 8 objections stay open; choosing counter makes you answerable for them." There is no accept button.

> "A normal assistant would say yes to twelve million. Code knows that yesterday's promises to Northwind and Contoso are using the capacity, and that the board said no new fixed costs this quarter."

**Console → Decisions:** the two alternatives side by side, the four views, and the dissent ledger with each quote marked in the proposal.

## 1:15 – Two people decide (30 s)

- **B** clicks **counter**. B tries to co-sign too: refused, four eyes.
- **A (CTO)** clicks **approve** on the co-sign card. Switchyard writes three rows into `commitments` in the room and emails the counteroffer (Mailpit).
- **Console → Commitments:** the new D-… rows, "created" by this decision, and the GPU bar filling.

> "The decision is now a promise the next decision will see."

## 1:45 – Assumption Watch (30 s)

```bash
npm run switchyard demo send capacity-drop
```

Operations reports GPU capacity down to 700. Within one tick (15 s by default):
- **Slack, the decision's thread:** "✗ Assumption broken: the capacity the counteroffer reserved is still there. Checked again by code: … 100 of 700 are free … case … decides again on the facts as they are now."
- A new case asks the four views again; the finance desk now offers a smaller tier, and code passes it. A new card waits for B.
- **Console → Commitments:** the GPU bar is red, 1,000 held of 700. **Decisions:** the first decision "At risk · decided again", its Assumption Watch entry, and the link to the new case.

> "It doesn't just make a recommendation. It keeps the company's decisions true over time."

Afterwards: `demo send capacity-restore`.

## 2:15 – Payments: the real domain asks for a new account (25 s)

```bash
npm run switchyard demo send bank-change-mailbox
```

- **Slack, case thread:** the agent reads the email. Code checks the domain (fabrikam.test, on file), the IBAN, and that the account is written in the email: all pass. The card also says "sender not authenticated": there is no mail gateway here, and Switchyard says so rather than assume.
- **The callback card goes to person A:** "call Fabrikam Print on +49 30 5550 1003 … it must be DE88500700100175526303 (the bank holds DE88…6303 under a similar but different name: Fabrikam Print Services s.r.o., not Fabrikam Print)". **A leaves it open.**

> "Alone, this request almost passes. The bank says the account is held under a name close to Fabrikam's, not Fabrikam's. That is worth a call, but a busy clerk could still be talked into it."

## 2:40 – A look-alike asks for the same account (40 s)

```bash
npm run switchyard demo send bank-change
```

- **Slack:** "✗ the request came from fabrikarn.test, 2 characters away from fabrikam.test on file: a look-alike domain". **Person B clicks block.**
- **Right after the click:**
  - In the first case's thread: "A person just blocked a request naming this case's account (…: none → blocked). Checking again; the open card no longer counts."
  - In the room: "Linked cases: case … and case … share the account DE885007…".
  - A new card for B: "hold Fabrikam Print's bank-detail change? … @B blocked that request".
- **A and B talk in the thread**, briefly and in their own words: A says the supplier's number on file is the one to call; B says the account was just blocked from a look-alike, so nobody calls yet. **B clicks hold.**
- **A clicks confirmed on the old callback card.** Nothing happens: it no longer counts.

> "One person's decision in one case changed what another person is allowed to do in another, before anyone picked up the phone."

## 3:20 – The invoice that prints that account (30 s)

```bash
npm run switchyard demo send fabrikam-invoice
```

- **Slack thread:** two agents on two vendors, two jobs. The reader quotes the invoice's supplier, number and amount. The investigator flags "Please note our new bank details", with that quote. Code: "✗ the investigator found: …", and confirms the quote is in the invoice.
- **Card for B:** "pay Fabrikam Print invoice FP-0912 for 3150?". Code also says the invoice asks for DE88…6303, but DE29…3746 is on file, and that account is the one a person blocked. **B clicks pay.**
- **Dashboard, receipt:** "The invoice asked for DE88…" next to "Paid to, as the bank holds it: DE29…", and three equal hashes: approved, sent, read back.

> "The models read and flag. They quote the invoice, and code checks the quotes. The money goes where the vendor master says."

## 3:50 – Investigations (20 s)

**Console → Investigations.**
- The group: "DE88…6303: blocked by a person, named again in 2 other cases".
- **Click the account DE88…6303**: the inspector lists every fact about it. The red line "blocked by @B" names the case, the sender (fabrikarn.test), who decided and when, and the status "suspected, not confirmed fraud". The amber line is the bank: "similar name", held by Fabrikam Print Services s.r.o., marked unverified.
- Impact: 3,150 invoiced, 3,150 paid to the account on file, one approval that stopped counting, and what was held.

> "Every line here is a fact someone can check, from the event log. Nothing is scored."

## Optional – Four eyes on a bank change (30 s)

```bash
npm run switchyard demo send bank-change-real
```

- **A** calls (the card says the number on file) and clicks **confirmed**.
- **A** tries to approve the change too: "@A answered "callback", so a different person must decide "approve"". The card re-opens.
- **B** clicks **approve**. Switchyard writes the new account into `vendor-master` in the room; the thread shows the row.

## 4:10 – Attack lab, labelled "offline: the same engine with scripted clicks" (15 s)

**Console → Attack lab → Run all 20.** A is links off, B links on; each run takes a fraction of a second.

- **The held-out set:** 20 scenarios from a separate author who never saw the code. The first run found two real bugs, both now fixed. Say the honest part, which the bars show: on those 20, people doing their job stop every attack with or without links, and links on cost one false positive (click **H05**, the factoring company). Set B's callbacks to "every one fooled" and run again to show what gets through when people are fooled. What links add is the compromised mailbox after a refusal, the story just shown.

## 4:25 – The proofs (20 s)

**Console → Proofs**, the decision: its dissent ledger, both people, the commitments it wrote and the assumption that broke, signed; every check holds. Then the paid invoice: every check holds, from the signature to each quote's place in the invoice text, and the payment rule evaluated again on the log with the values it read. Click **Check a copy with the amount changed**: three checks fail.

To show it with no console at all, **Download proof**, then:

```bash
npm run switchyard verify-proof ~/Downloads/<case>.proof.json -- --fingerprint <printed by up or proof>
```

## 4:45 – Close (10 s)

> "The company's promises, its rules and its vendor master are Switch room documents. Every decision is a Switch card with a name on it, made by two people in the room. Agents argue; code checks; people decide; and every action leaves with a proof anyone can check."

---

## Also live, if time allows

- **The walkthrough.** Command → **Walk through a decision** (or a payment), then **Play**: the paid invoice's ten stages from its recorded events, ending with the proof built and checked on the spot.

- **The insider.** `demo send insider-edit`, then `demo send northwind-invoice`: "hold Northwind Paper invoice NW-118: their row in the vendor master was edited in the room, outside any case". There is no pay button. Afterwards: `demo send insider-restore`.
- **The same PO again.** `demo send fabrikam-invoice-2`: "hold Fabrikam Print invoice FP-0913: PO-1043 is already invoiced FP-0912 …, and each PO is paid once". There is no pay button.

## Recorded evidence (before this version)

- **`1c5cc185`:** the look-alike bank-change email, live on Slack. Claude listed seven red flags, code found the look-alike domain, and the block card went to Slack.
- **`60c4c081`:** the Fabrikam invoice printing another account, live, when both agents still did the same job. Gemini failed with a provider error and Claude called it a mismatch ("split"). Code caught the account, and the card paid the account on file.
- **`94221172`:** an earlier invoice where the Claude checker hit the account's real usage limit mid-run. The case still reached a person with the evidence it had.

`demo reset` moves this log aside; the old file stays in `data/`.
