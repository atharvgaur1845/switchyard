# Demo script (about 3 min 50 s)

**Opening line:** "Nothing leaves the company unless a named person approved that exact action on a Switch card. And Switchyard remembers what people decided, so a request that looks fine alone can still be caught."

Screen: Slack (`#finance`) on the left, the dashboard (`localhost:4100`) on the right. Keep Mailpit (`localhost:8025`) and the sandbox bank (`localhost:4300`) in tabs, and a terminal for the `demo send` commands.

Disclose on screen from the first frame:

> Slack, Switch, the agents (Claude Haiku and Gemini) and the emails are real. The bank and the suppliers are a local sandbox. The insider's edit is made by a script, through Switch's document API.

## Before recording

1. Switch Console's local server is running with Slack connected, and `#finance` was created with `setup-local invoice-check --bridge <slack bridge id>`.
2. **People.** Map the roles in `switchyard.yaml`. One Slack user can hold every role for scenes 1 to 4. The four-eyes approval needs a second user; without one it runs offline (scene 5).
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

   After a reset, `#finance` gets one message per document listing the rows Switchyard attested.
5. Warm up the agents: send one input and check that both checkers answer. Gemini's free tier can return 429. If it does, the case still works; it just shows "split".
6. Agent replies take 10–20 s. Cut the waits in the edit but keep the timestamps visible. Never call a cut "live".

---

## 0:00 – The problem (20 s)

> "A supplier's mailbox gets taken over. The email comes from their real domain and passes every check. How would anyone know? Because an hour earlier, someone tried the same account from a look-alike domain, and a person blocked it."

## 0:20 – The real domain asks for a new account (40 s)

```bash
npm run switchyard demo send bank-change-mailbox
```

- **Slack, case thread:** the agent reads the email. Code checks the sender's domain (fabrikam.test, on file), the IBAN and that it really changes: all pass.
- **The callback card** goes to the AP clerk: "call Fabrikam Print on +49 30 5550 1003 … it must be DE88500700100175526303". **Leave it open.**

> "Alone, this request is fine. A person would make the call."

## 1:00 – A look-alike asks for the same account (50 s)

```bash
npm run switchyard demo send bank-change
```

- **Slack:** "✗ the request came from fabrikarn.test, 2 characters away from fabrikam.test on file: a look-alike domain". The agent lists the red flags. Click **block** on the card.
- **Slack, right after the click:**
  - In the first case's thread: "A person just blocked a request naming this case's account (…: none → blocked). Checking again; the open card no longer counts."
  - In the room: "Linked cases: case … and case … share the account DE885007…".
  - A new card for the controller: "hold Fabrikam Print's bank-detail change? DE88…6303 was requested for Fabrikam Print from fabrikarn.test, and @… blocked that request". Click **hold**.
- **Try the old callback card:** click **confirmed**. Nothing happens; it no longer counts.
- **Dashboard:** the case's "Linked across cases, by code" panel, with a link to the blocked case.

> "One decision in one case changed what is allowed in another, before anyone picked up the phone."

## 1:50 – The invoice that prints that account (35 s)

```bash
npm run switchyard demo send fabrikam-invoice
```

- **Slack card:** "pay Fabrikam Print invoice FP-0912 for 3150?". Two checks are ✗: the invoice asks for DE88…6303 but DE29…3746 is on file, and that account is the one a person blocked. Its account is the one **on file**. Click **pay**.
- **Dashboard, receipt:** "The invoice asked for DE88…" next to "Paid to, as the bank holds it: DE29…", and three equal hashes: approved, sent, read back.

## 2:25 – The insider (35 s)

```bash
npm run switchyard demo send insider-edit
npm run switchyard demo send northwind-invoice
```

Say: "Switch has no per-document permissions, so anyone with write access can edit the vendor master. This script does that, through Switch's own API."

- **Slack card:** "hold Northwind Paper invoice NW-118: their row in the vendor master was edited in the room, outside any case, so nothing is paid on it". There is no pay button. **Bank tab:** nothing paid.

Afterwards: `npm run switchyard demo send insider-restore`.

## 3:00 – Offline montage (30 s, labelled "offline: the same engine with scripted clicks")

```bash
npm run demo:offline -- --serve
npm run lab
```

- **Four eyes:** the clerk who made the callback tries to approve and is refused. (Live instead if you have a second Slack user: `demo send bank-change-real`.)
- **An approval on old facts:** `localhost:4101`, case FP-0912: "would not act on reserve po: vendor-master changed … after the checks read it".
- **The lab table:** when the callback is skipped or fooled, the two compromised-mailbox scenarios pay the attacker 3,150 EUR each with links off, and nothing with links on. Say what it is: nine scenarios we wrote, run with links off and on, counted from the bank's ledger. Point at the cost rows too: the factoring account's extra card and the held genuine change.

## 3:30 – Close (20 s)

> "The vendor master and the purchase orders are Switch room documents. The decisions are Switch cards, with a name on each answer, and the investigation happens in the room. Switchyard keeps the room honest across cases: an approval on old facts, a row edited behind its back, the same order billed twice, or an account a person already blocked never pays without a person deciding again."

---

## Recorded evidence (before this version)

- **`1c5cc185`:** the look-alike bank-change email, live on Slack. Claude listed seven red flags, code found the look-alike domain, and the block card went to Slack.
- **`60c4c081`:** the Fabrikam invoice printing another account, live. Gemini failed with a provider error and Claude called it a mismatch, so the case shows "split". Code caught the account, and the card paid the account on file.
- **`94221172`:** an earlier invoice where the Claude checker hit the account's real usage limit mid-run. The case still reached a person with the evidence it had.

`demo reset` moves this log aside; the old file stays in `data/`.
