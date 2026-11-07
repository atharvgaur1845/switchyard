# Live demo runbook: two contracts, one pool of GPU capacity

**Switchyard is a control plane for consequential company decisions: agents investigate and argue in Switch rooms, code checks every claim against the company's rules and existing commitments, named people decide on Switch cards, and the engine carries out exactly what they signed.**

This runbook is for the **live** demonstration, on Switch and Slack, with real agents and two real people. The offline run (`npm run demo:offline`, the Hugging Face Space, the recorded video) uses canned agent replies and scripted clicks. It is a different thing and must always be introduced as "offline: the same engine, scripted". Never cut the two together without saying which is which.

What is real and what is a sandbox, said on screen from the first frame:

> Switch, Slack, the agents and the two people are real. The company (Acme), its policy, its capacity, its commitments and the customers (Tailspin Analytics, Fourth Coffee) are sandbox data. Email goes to Mailpit, a local mail catcher. The bank is a local sandbox.

## 1. The scenario, with exact numbers

All figures come from `templates/contract-decision.template.yaml` and `src/demo.ts`.

| | |
|---|---|
| Capacity (`capacity` document) | 1,000 GPU-hours a month, 8 engineers, reported today |
| Already promised (`commitments`) | C-101: 600 GPU-hours to Northwind Paper until 2027-03-31 (decided by @cto). C-102: 3 engineers to Contoso until 2026-12-15 (@coo). C-103: 3 engineers to the platform migration until 2027-01-31 (@cto) |
| Company rules (`policy`) | max discount 15% (@cfo), min year-1 margin 30% (@cfo), max uptime promised 99.9% (@cto), new fixed costs this quarter 0 (board). Cost rates: 900 INR a GPU-hour, 250,000 INR an engineer-month |
| Proposal 1, `contract-proposal` | Tailspin Analytics: 12,000,000 INR a year, 25% discount, 99.99% uptime, live in 6 weeks from 9 Nov 2026, 500 GPU-hours a month, 3 engineers |
| Proposal 2, `rival-proposal` | Fourth Coffee: the same terms at 9,000,000 INR a year |
| What code finds on proposal 1 | Breaks 4 rules (discount, year-1 margin 28.5%, uptime, new fixed costs) and runs into C-101, C-102 and C-103. Only 400 GPU-hours are free in its window |
| Capacity loss, `capacity-drop` | GPU-hours 1,000 → 700 (`capacity-restore` puts it back) |

The counteroffer is written by the live finance-desk agent, so its exact terms vary from run to run. Code checks it the same way, and the card only offers it if it passes. In the offline run it is 10%, 99.9%, 400 GPU-hours from 2026-12-16.

**Whether proposal 2 is refused depends on the live counteroffers.** Proposal 2's hold is refused only if the two counteroffers together need more than the 400 free GPU-hours, or more than the free engineers. If the finance desk proposes smaller tiers that both fit, both are held, and that is correct behaviour, not a failure. Look at what the thread says was held for Tailspin before you send proposal 2, and narrate what actually happens.

## 2. People and roles

Two **different** real people, each with their own Slack user, both in `#finance`. One Slack identity for both roles defeats the demo: the four-eyes rule would refuse the second click, as it should.

| Role | Switchyard handle | Who | Clicks |
|---|---|---|---|
| CFO | `@cfo` | person B | "counter" on Tailspin's card, "counter" on Fourth Coffee's card, and tries "approve" on the co-sign card (refused) |
| CTO | `@cto` | person A, a different person | "approve" on the co-sign card |

In `switchyard.yaml`, under `people:`, map each role to that person's Switch username:

```yaml
people:
  "@cfo": "@<person B's Switch username>"
  "@cto": "@<person A's Switch username>"
```

**Blocker as of this writing:** the local `switchyard.yaml` has no `@cto` line. Without it nobody can answer the co-sign card, and the decision stops there.

## 3. Preflight

Run these in order. Nothing here prints a secret.

1. **Node 24.** `node --version` must say v24 or later. If your shell has an older one: `export PATH=$HOME/.local/node/node-v24.14.0-linux-x64/bin:$PATH`. Then `npm ci` once.
2. **`.env` has every variable `.env.example` lists**, without printing them:

   ```bash
   for v in $(grep -o '^[A-Z_]*' .env.example); do grep -q "^$v=." .env && echo "ok  $v" || echo "MISSING $v"; done
   ```

   The live decision needs `INVOICE_HOOK_SECRET` (it signs the proposal webhook) and the Switch agent credentials.
3. **Docker and Mailpit:** `docker compose up -d`, then `http://localhost:8025` shows the Mailpit inbox.
4. **Switch.** Switch Console's local server is running with Slack connected, and `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:37017/health` prints `200`. If Mattermost inside the stack reports unhealthy (`docker inspect --format '{{.State.Health.Status}}' switchdash-local-mattermost-mattermost-1`), restart the local server from Switch Console.
5. **`#finance`** exists, both people and both agents are in it, and each person can see the other's card answers.
6. **Roles:** `@cfo` and `@cto` map to two different people (section 2).
7. **Two live agents on two vendors.** `@checker` (Claude) and `@checker-backup` (Gemini) under `cli_agents` in `switchyard.yaml`. Warm them up: each must answer one request before the recording. Gemini's free tier can return 429; see fallbacks.
8. **Clean state, then services, in this order:**
   1. Stop `up` if it is running (Ctrl-C in its terminal).
   2. Stop the sandbox bank if it is running (Ctrl-C in its terminal).
   3. **Reset, only with the operator's consent.** `npm run switchyard demo reset` refuses to run while `up` is running. It *moves aside* (never deletes) `data/switchyard.db` and `data/sandbox-bank.json`, renaming them with a timestamp. It also rewrites `#finance`'s `vendor-master`, `purchase-orders`, `commitments`, `capacity` and `policy` documents in Switch back to the template, with capacity reported as of today.
   4. `npm run bank`. The sandbox bank, on port 4300.
   5. `npm run switchyard up`. The console is on port 4100. On first start it posts "Attested … rows" messages to `#finance`; the policy line must list **min year-1 margin**.
9. **Console:** `http://localhost:4100` opens on Command. There is no "Offline demo" label in the top bar. If you see one, you are looking at the offline run on 4101.

## 4. Screen layout

Slack `#finance` on the left half, the Switchyard console (`localhost:4100`) on the right half. A terminal for the `demo send` commands, out of frame or small. Mailpit in a browser tab.

## 5. The sequence

Each step lists the command or click, who does it, what to say, and what should appear. Live agent replies take 10–60 s per step; do not fill the wait with invented activity. Say what the system is waiting for.

### Step 1: the proposal arrives

```bash
npm run switchyard demo send contract-proposal
```

**Say:** "Sales sends in a proposal through a signed webhook. Tailspin Analytics wants twelve million rupees a year, at twenty-five percent off, four-nines uptime, live in six weeks."

**Expect:** the terminal prints `Tailspin Analytics's contract proposal: 202 {"case":"…"}`. If it prints `200 … "duplicate":true`, this exact proposal was already sent since the last reset: webhooks are de-duplicated by body, so it returns the existing case. Reset before a fresh take. In `#finance`, "Case … opened by webhook: Company decision on a contract", with a thread.

### Step 2: four views, then code

No action. About 1–2 minutes while both agents answer twice.

**Say:** "Four views go to work: a finance desk, an engineering desk, operations and a red team, on two agents from two vendors. Every objection has to quote the proposal. Then code checks it. Not the agents: code, against the room's own documents."

**Expect in the thread:** four answers, each with a position and objections. Then "✗ Checked by code (commitments): … C-101 holds 600 for Northwind Paper … (decided by @cto)", "✗ Checked by code (constitution): …" listing the broken rules, two lines checking the counteroffer, and "Checked by code (dissent): …".

**Console:** Decisions → Tailspin Analytics. The proposal and the counteroffer side by side, the four views, and the dissent ledger with each quote marked in the proposal text.

### Step 3: the CFO chooses (person B)

**Click:** person B clicks **counter** on the card "@cfo counter Tailspin Analytics's proposal? …".

**Say:** "The CFO is never offered a yes on a proposal that breaks the rules. The card offers only what passes: the counteroffer, or decline. Choosing it holds the capacity the counteroffer needs, in one database transaction."

**Expect:** the thread says "Held for this decision until it is carried out or ends: … gpu-hours until …, … engineers until …". A co-sign card for @cto appears. The console's Decision Room shows a "Holding …" banner.

### Step 4: the competing proposal

```bash
npm run switchyard demo send rival-proposal
```

Wait for its four views and checks (1–2 minutes), then **person B clicks counter** on Fourth Coffee's card.

**Say, if it is refused:** "Fourth Coffee asked for the same terms at the same time. On its own, its counteroffer fits. But Tailspin's decision already holds that capacity. The hold is refused, the checks run again with Tailspin's hold counted, and the card now offers only what is still true."

**Expect, if refused:** "Not holding it: this decision needs …, and … are left: case … (Tailspin Analytics) holds …". The checks run again, and a new card offers **decline / hold**. In the console, Fourth Coffee's label reads "Needs a person · capacity held by another decision", and its Decision Room shows the red "Capacity held by another decision" banner, linked to Tailspin's case.

**If both fit** (section 1), say so: "These two counteroffers fit together, so both are held. Here is the total held, still under capacity." Show the Commitments timeline.

### Step 5: four eyes (person B, then person A)

**Click:** person B clicks **approve** on the co-sign card.

**Expect:** "@cfo answered "decide", so a different person must decide "cosign"." The card reopens.

**Click:** person A clicks **approve**.

**Say:** "The CFO can't co-sign their own choice. The CTO, a different person, co-signs, and the decision is carried out exactly as signed."

**Expect:** four "Done:" lines: three commitment rows written into the `commitments` document (D-…-gpu, D-…-eng, D-…-sla), and the counteroffer email, which appears in Mailpit. "Case … is done." The console's Commitments view shows the new rows, and the timeline shows the hold, the answers and the writes in order.

### Step 6: Assumption Watch

```bash
npm run switchyard demo send capacity-drop
```

**Say:** "Facts change after decisions are made. Operations reports GPU capacity down from a thousand to seven hundred. On its next tick, Switchyard checks the decision again."

**Expect, within one tick (15 s by default):** "✗ Assumption broken: the capacity the counteroffer reserved is still there. …" in Tailspin's thread, and a new case "… decided again" with its own agents and cards. Tailspin's label: "At risk · decided again". Nothing already done is reversed: the original decision and its commitments stay as they were, and the new case decides on today's facts.

### Step 7: the proof

```bash
npm run switchyard proof <Tailspin case id>
npm run switchyard verify-proof data/proofs/<Tailspin case id>.proof.json
```

The case id is in the thread ("Case … opened") and in the console. `proof` prints the key fingerprint. Pass `--fingerprint <hex>` to `verify-proof`, or set `proof.fingerprint` in `switchyard.yaml`, so the signer is pinned.

**Say:** "Every decision leaves a signed proof. It is checked with no model, no Switch and no bank. The verifier runs the commitments, policy and dissent checks again on the documents they read, and an edited record fails."

**Expect:** a list of ✓ lines ending with every check holding. In the console, Proofs → the case shows the same.

## 6. Timing

| Step | Realistic time |
|---|---|
| 1–2 Proposal, four views, code checks | 1–3 min (agents answer twice each) |
| 3 CFO | 10 s |
| 4 Rival proposal, checks, CFO | 1–3 min |
| 5 Four eyes, execution | 20–40 s |
| 6 Assumption Watch | 15–30 s, then the new case's agents take 1–3 min (no need to wait for it) |
| 7 Proof | 30 s |
| **Total** | **5–11 min live**. For a 3–4 minute video, cut the agent waits and keep the Slack timestamps visible |

## 7. Fallbacks

- **An agent's provider fails or rate-limits (Gemini 429).** That view is recorded as "could not answer", the dissent ledger keeps it open, and the decision still goes to a person. Say so. Do not substitute canned replies and still call it live. Wait a minute and resend for a clean take, or use the offline run and introduce it as offline.
- **The finance desk proposes no counteroffer that passes.** The CFO gets the **decline / hold** card instead. That is correct behaviour; narrate it.
- **A person is slow to click.** Cards have a one-day deadline; nothing times out during a demo. The hold lasts two days, and a late co-sign takes it again, or is voided if another decision took the capacity (Chaos Lab C9).
- **Stale state from an earlier run** (old cases, capacity at 700). `npm run switchyard demo send capacity-restore` resets only the capacity. For a full clean slate, stop `up` and the bank, then reset (section 3, with consent).
- **Switch is down** (the room stream returns 500, or the health check isn't 200). Restart the local server from Switch Console. Until it is back, nothing live can run. Show the offline run on 4101 or the Hugging Face Space, introduced as offline.
- **`200 … "duplicate":true` from a `demo send`.** The same proposal was already received in this database. Use the existing case, or reset for a fresh take.
- **Webhook rejected (401).** `INVOICE_HOOK_SECRET` in `.env` differs from what `up` loaded; restart `up` after fixing `.env`.

## 8. Cleanup

1. Ctrl-C `up` and the bank.
2. `npm run switchyard demo send capacity-restore` if you dropped capacity and want to run again without a reset (needs `up` running).
3. `demo reset` (with consent) moves the run's database and bank ledger aside with a timestamp. The old ones stay in `data/` until you delete them yourself.

## 9. What not to claim

- The live demo did not use the offline run's canned replies, and the offline run is not live. Keep them apart.
- Switchyard does not undo actions already carried out. Assumption Watch decides again; it does not reverse the email or the rows.
- Capacity safety holds for engines sharing one SQLite database. The Switch integration runs one engine process, and Switch's document API has no version precondition. There is no distributed transaction across separate engines.
- The bank, the payee registry, the company and its customers are sandboxes. A signed proof shows the record is consistent and unaltered since signing, not that the record is true.
- Do not claim a live two-person run happened until two different people have actually completed it through Switch.
