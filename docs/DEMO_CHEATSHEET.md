# Live demo cheat sheet

The full script is in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md). This is the one page to keep beside the keyboard.

**Live, not offline.** The console is on `localhost:4100` and has no "Offline demo" label. Port 4101 and the Hugging Face Space are the offline run: canned agents, scripted clicks.

## People

| Role | Handle | Person | Clicks |
|---|---|---|---|
| CFO | `@cfo` | B | counter (Tailspin), counter (Fourth Coffee), approve on co-sign (refused) |
| CTO | `@cto` | A, a different Slack user | approve on co-sign |

## Before (in order)

```bash
docker compose up -d                       # Mailpit on :8025
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:37017/health   # Switch: 200
# stop `up` and the bank (Ctrl-C), then, with consent:
npm run switchyard demo reset              # moves db + bank ledger aside, resets #finance documents
npm run bank                               # terminal 1, :4300
npm run switchyard up                      # terminal 2, :4100; check "min year-1 margin" in #finance
```

## During

| # | Command or click | Screen to show |
|---|---|---|
| 1 | `npm run switchyard demo send contract-proposal` | Slack: the case thread opens |
| 2 | wait 1–2 min | Slack: four views, ✗ code checks · Console: Decisions → Tailspin |
| 3 | **B** clicks **counter** | Slack: "Held for this decision: …" · Console: Holding banner |
| 4 | `npm run switchyard demo send rival-proposal`, wait, **B** clicks **counter** on Fourth Coffee | Slack: "Not holding it: … 0 are left" (if the counteroffers overlap) · Console: Decisions → Fourth Coffee, red banner |
| 5 | **B** clicks **approve** on co-sign → refused; **A** clicks **approve** | Slack: "a different person must decide", then four "Done:" lines · Mailpit: the counteroffer · Console: Commitments + timeline |
| 6 | `npm run switchyard demo send capacity-drop` | Slack: "Assumption broken" within about 15 s · Console: "At risk · decided again" |
| 7 | `npm run switchyard proof <case>` then `npm run switchyard verify-proof data/proofs/<case>.proof.json -- --fingerprint <hex>` | Terminal: every ✓ · Console: Proofs |

## If something goes wrong

- Agent 429 / no answer: recorded as "could not answer". Narrate it, or wait a minute and retry. Never swap in canned replies and still call it live.
- `duplicate: true`: already sent since the last reset. Use that case or reset.
- Switch 500: restart the local server in Switch Console.
- After the demo: `npm run switchyard demo send capacity-restore`.
