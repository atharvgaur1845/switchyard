# Demo script (about 3 min 40 s)

**Opening line:** "Nothing leaves the company unless a named person approved that exact action on a Switch card."

Screen: Slack (`#finance`) on the left, the dashboard (`localhost:4100`) on the right. Keep Mailpit (`localhost:8025`) and the sandbox bank (`localhost:4300`) in tabs. A terminal is needed for the last scene.

Disclose on screen from the first frame:

> Slack, Switch, the agents (Claude Haiku and Gemini) and the emails are real. The bank and the suppliers are a local sandbox. One person plays every role.

## Before recording

1. Switch Console's local server is running with Slack connected, and `#finance` was created with `setup-local invoice-check --bridge <slack bridge id>`.
2. Start the services:

   ```bash
   docker compose up -d
   npm run bank
   npm run switchyard up
   ```

   `up` prints "Created room documents in Switch: #finance/vendor-master" the first time.
3. Warm up the agents: send one input and check that both checkers answer. Gemini's free tier can return 429. If it does, the case still works; it just shows "split".
4. Agent replies take 10–20 s. Cut the waits in the edit but keep the timestamps visible. Never call a cut "live".

---

## 0:00 – The problem (20 s)

> "A supplier emails: 'we changed banks, pay us here today.' Pay it, and the money is gone. Switchyard is a back office that runs in your Switch rooms, built so that email cannot move money."

Show: the dashboard's Flows tab, then the `bank-change` and `invoice-check` diagrams.

## 0:20 – The attack, live in Slack (60 s)

```bash
npm run switchyard demo send bank-change
```

- **Mailpit:** the email from `accounts@fabrikarn.test`, with "phones are down, reply by email only".
- **Slack, case thread in `#finance`:**
  - The Claude agent extracts the request and lists the red flags itself. On the recorded run it found seven, including the phone trick and a PO the email names that does not exist.
  - Then the code check:
    > ✗ the request came from fabrikarn.test, 2 characters away from fabrikam.test on file: a look-alike domain
- **The card:** "block this bank-detail change request?" It shows the exact warning email, which goes to `accounts@fabrikam.test` (the contact *on file*, not the sender), and its hash. Click **block**.
- **Mailpit:** the warning arrives at the real supplier's address.

> "The model read the email. Code decided the facts. A person decided what to do, on a card."

## 1:20 – The invoice that prints another account (40 s)

```bash
npm run switchyard demo send fabrikam-invoice
```

- **Dashboard:** the case opens with two checkers on two vendors, Claude and Gemini. Point at:
  - the purchase-order check passing;
  - the vendor check failing: "the invoice asks for payment to DE88…6303, but DE29…3746 is on file";
  - the two document chips with their version hashes.
- **Slack card:** "pay Fabrikam Print invoice FP-0912?" Its account is the one **on file**, and it names the vendor-master version it was checked against. Leave it open.

## 2:00 – Four eyes, live (30 s)

```bash
npm run switchyard demo send bank-change-real
```

- From `fabrikam.test` this time, so the code check passes.
- The callback card says: "call Fabrikam on +49 30 5550 1003 (the number on file, not one from the email) and confirm the account ends in 2871". Click **confirmed**.
- On the next card, "change Fabrikam's bank account to DE63…?", click **approve** yourself.
- Switchyard refuses:
  > @f20241501 answered "callback", so a different person must decide "approve".

> "One person can hold both roles, and still can't do both halves of a bank change."

## 2:30 – An approval on old facts never pays (50 s, terminal: `npm run demo:offline`, scenes 3 and 4)

Say on screen: "The second approver, offline: the same engine with scripted clicks."

1. The controller approves the change. The vendor master now holds the new account.
2. The controller clicks **pay** on the invoice card that was opened *before* the change. Switchyard answers:
   > Not sending "schedule_payment": a document the checks read changed after they ran (vendor-master <old> → <new>). Checking again on the new version; any approval given on the old one no longer counts.
3. The checks run again, and a new card shows the new account. **pay** sends the payment to the sandbox bank. The receipt prints:
   > approved <h> · sent <h> · read back from the bank <h> = all three match

   The hashes differ from day to day, because the new vendor-master row carries the date.

Then the bank tab at `localhost:4300`: one payment, with its idempotency key.

## 3:20 – Close (20 s)

Show the dashboard's Raw log tab (`seq`, export) and then the README's Switch table.

> "The vendor master and the POs are Switch room documents. The decisions are Switch cards, with a name on each answer. The agents meet in a Switch room on two vendors. Take Switch away and there is nothing to check against, and nobody to hold to four eyes."

---

## Recorded evidence

- **`1c5cc185`:** the look-alike bank-change email, live on Slack. Claude extracted it and listed seven red flags; code found the look-alike domain; the block card went to Slack.
- **`60c4c081`:** the Fabrikam invoice printing another account, live. Gemini failed with a provider error and Claude called it a mismatch, so the case shows "split". Code caught the account, and the card pays the account on file.
- **`94221172`:** an earlier invoice where the Claude checker hit the account's real usage limit mid-run. The case still reached a person with the evidence it had.

The other flows (expense, quote, weekly report, front desk, onboarding) were run live earlier, on Slack and on Mattermost. Their case ids are in the dashboard.
