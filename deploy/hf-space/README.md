---
title: Switchyard
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
short_description: Company decisions and payments, carried out only with proof
---

# Switchyard: offline demo

A control plane for consequential company decisions and the actions that carry them out, run by agents and people in [Switch](https://github.com/sandbox-quantum/switch) rooms. Source: [github.com/atharvgaur1845/switchyard](https://github.com/atharvgaur1845/switchyard).

**This Space is the offline run** (`npm run demo:offline`): the real engine, flows, checks, hashes and proofs, with three stand-ins.

- Agents answer from fixtures, not a model.
- The approval cards were clicked by a script.
- The bank, the suppliers, the customer and the company's commitments, capacity and policy are sandbox data.

The live system runs in Switch rooms on Slack, with Claude and Gemini agents and two people deciding. That is in the demo video, not here.

The console is read-only: nothing here opens a case. You can:

- **Decisions:** Tailspin's contract proposal, its two alternatives as code checked them, four agent views and the dissent ledger.
- **Commitments:** every promise the company made, and the capacity a decision reserved and then lost.
- **Proofs:** each case's signed proof, checked by the verifier. Try the edited copies; they fail.
- **Attack lab:** run the 20 held-out scenarios yourself, under two configurations side by side.
- **Walk through a decision or a payment**, stage by stage, from its recorded events.
- **About:** how everything works, with diagrams.

The run starts fresh each time the Space starts. Proofs here are signed with a key made at that start, so they verify against this Space's key only.
