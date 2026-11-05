# Demo script (about 3 min 50 s)

**Opening line:** "Nothing leaves the company unless a named person approved that exact action on a Switch card, or a rule in the flow allows it after the code checks pass, and never on a row someone edited behind the system's back."

Screen: Slack (`#finance`) on the left, the dashboard (`localhost:4100`) on the right. Keep Mailpit (`localhost:8025`) and the sandbox bank (`localhost:4300`) in tabs, and a terminal for the `demo send` commands.

Disclose on screen from the first frame:

> Slack, Switch, the agents (Claude Haiku and Gemini) and the emails are real. The bank and the suppliers are a local sandbox. The insider's edit is made by a script, through Switch's document API.

## Before recording

1. Switch Console's local server is running with Slack connected, and `#finance` was created with `setup-local invoice-check --bridge <slack bridge id>`.
2. **A second person.** Add a second Slack user to `#finance` and map the roles in `switchyard.yaml`, for example `@ap-clerk: '@you'` and `@controller: '@second'`. If there is no second user, scene 5 runs offline instead (see below).
3. **A clean slate.** With Switchyard stopped, run:

   ```bash
   npm run switchyard demo reset
   ```

   It moves the event log and the bank ledger aside and puts `vendor-master` and `purchase-orders` back to the template.
4. Start the services:

   ```bash
   docker compose up -d
   npm run bank
   npm run switchyard up
   ```

   After a reset, `up` prints "Attested every row of #finance/purchase-orders, #finance/vendor-master", and `#finance` gets one message per document listing the rows it attested.
5. Warm up the agents: send one input and check that both checkers answer. Gemini's free tier can return 429. If it does, the case still works; it just shows "split".
6. Agent replies take 10–20 s. Cut the waits in the edit but keep the timestamps visible. Never call a cut "live".

---

## 0:00 – The problem (20 s)

> "A supplier emails: 'we changed banks, pay us here today.' Pay it, and the money is gone. Or someone inside quietly edits the vendor record. Switchyard is a back office that runs in your Switch rooms, built so that neither moves money."

Show: the dashboard's Flows tab, with the `bank-change` and `invoice-check` diagrams.

## 0:20 – The attack from outside, live in Slack (50 s)

```bash
npm run switchyard demo send bank-change
```

- **Mailpit:** the email from `accounts@fabrikarn.test`, with "phones are down, reply by email only".
- **Slack, case thread:**
  - The Claude agent extracts the request and lists the red flags itself.
  - Then the code check: "the request came from fabrikarn.test, 2 characters away from fabrikam.test on file: a look-alike domain".
- **The card:** "block this bank-detail change request (…)?" It shows the warning email, which goes to `accounts@fabrikam.test` (the contact *on file*, not the sender). Click **block**.
- **Mailpit:** the warning arrives at the real supplier's address.

> "The model read the email. Code decided the facts. A person decided what to do, on a card."

## 1:10 – The invoice that prints another account (40 s)

```bash
npm run switchyard demo send fabrikam-invoice
```

- **Dashboard:** two checkers on two vendors. The PO check passes. The vendor check fails: "the invoice asks for payment to DE88…6303, but DE29…3746 is on file".
- **Slack card:** "pay Fabrikam Print invoice FP-0912 for 3150?". Its account is the one **on file**. Click **pay**.
- **Dashboard, receipt:** "The invoice asked for DE88…" next to "Paid to, as the bank holds it: DE29…", then three equal hashes: approved, sent, read back. Above it, "reserve po": PO-1043 is now marked invoiced in the room.
- **Bank tab:** the payment, to the account on file, with its idempotency key.

## 1:50 – The attack from inside (40 s): the central idea

```bash
npm run switchyard demo send insider-edit
npm run switchyard demo send northwind-invoice
```

Say: "Switch has no per-document permissions, so anyone with write access can edit the vendor master. This script does that: it swaps Northwind's account and leaves the date and the word 'callback'."

- **Dashboard or Slack:** Northwind's invoice matches its PO and both checkers agree. On the old code, the rule would have paid it with no card.
- **Slack card:** "hold Northwind Paper invoice NW-118: their row in the vendor master was edited in the room, outside any case, so nothing is paid on it". There is no pay button. Click **investigate**.
- **Bank tab:** nothing paid.

> "Switchyard remembers every row it read or wrote. A row that changed outside a case cannot move money."

Afterwards: `npm run switchyard demo send insider-restore`.

## 2:30 – The same order, billed again (20 s)

```bash
npm run switchyard demo send fabrikam-invoice-2
```

- **Slack:** "✗ Checked by code (po_lookup): PO-1043 is invoiced FP-0912 (case …)". The card goes to the controller; nothing is paid automatically.

## 2:50 – Four eyes and an approval on old facts (40 s)

**With two people, live:**

```bash
npm run switchyard demo send bank-change-real
```

- The callback card goes to the AP clerk: "call Fabrikam Print on +49 30 5550 1003 (the number on file, not one from the email) and have them read out their new account: it must be DE63120300001064532871". Click **confirmed**.
- The AP clerk tries **approve** on the next card. Switchyard refuses: "… answered "callback", so a different person must decide "approve"."
- The controller (the second person) approves. The vendor master now holds the new account.

**Without a second person:** run `npm run demo:offline -- --serve`, and say on screen "offline: the same engine with scripted clicks". Show scenes 3 and 4 in the terminal. Then show case FP-0912 on `localhost:4101`, where the timeline reads "would not act on reserve po: vendor-master changed … after the checks read it", and the new card pays the new account.

## 3:30 – Close (20 s)

Show the dashboard's KPI strip ("bank copy = approval", "stopped before money moved") and the README's attack table.

> "The vendor master and the POs are Switch room documents. The decisions are Switch cards, with a name on each answer. Switchyard keeps the room honest: an approval on old facts, a row edited behind its back, or the same order billed twice never pays."

---

## Recorded evidence (before this version)

- **`1c5cc185`:** the look-alike bank-change email, live on Slack. Claude listed seven red flags, code found the look-alike domain, and the block card went to Slack.
- **`60c4c081`:** the Fabrikam invoice printing another account, live. Gemini failed with a provider error and Claude called it a mismatch, so the case shows "split". Code caught the account, and the card paid the account on file.
- **`94221172`:** an earlier invoice where the Claude checker hit the account's real usage limit mid-run. The case still reached a person with the evidence it had.

`demo reset` moves this log aside; the old file stays in `data/`.
