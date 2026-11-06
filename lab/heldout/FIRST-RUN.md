# First run of the held-out scenarios

The scenarios and their expectations were committed in `73c9dca`, before
they were run. This is the first run, on the engine as it was at that commit,
copied as printed. Policy: every card answered with its first option, the
callback as each scenario says (`real` or `fooled`).

| | Scenario | Links off | Links on | What did not match |
|---|---|---|---|---|
| H05 | Two vendors assign receivables to one factoring account (benign) | pass | **fail** | links on: the second change is held, so it is not made, and the invoice is paid to the old account |
| H07 | A paid Northwind invoice resubmitted under a new number (attack) | **fail** | **fail** | the resubmission was paid 1,240 (to the account on file) |
| H08 | Tailspin's PO split into two invoices under the limit (attack) | **fail** | **fail** | the second half was paid 6,200 (to the account on file) |
| H14 | Fabrikam really changes banks a week after a look-alike tried (benign) | **fail** | **fail** | the genuine change was lost |

The other 16 scenarios met every expectation with links off and on.

- Links off: 17/20 met every expectation (attacks 12/14, benign 5/6). 0 EUR went to attacker accounts. 51 cards were shown, 21 of them on benign scenarios.
- Links on: 16/20 met every expectation (attacks 12/14, benign 4/6). 0 EUR went to attacker accounts. 50 cards were shown, 20 of them on benign scenarios.

## What it found, and what changed

- **H07, H08.** Each PO is paid once, but a second invoice on an already
  invoiced PO went to the ordinary pay card, where `pay` is the first option.
  The money went to the supplier's own account, not an attacker's, but it was
  paid twice. Now such an invoice is held with no pay button.
- **H14.** The scenario answered `call-anyway` on a card whose options were
  `confirmed` and `not-confirmed`. The engine took any answer that was not an
  approval as a decline, so the genuine change was dropped. Switch's cards
  offer only their own options, so this needs a forged answer. Now an answer
  that is not one of the card's options is ignored.
- **H05.** Not changed: links on hold a change to an account that is on file
  for another vendor, until the controller chooses "call anyway". This is the
  cost of the links, and it stays.

After these changes, links off meets 20/20 and links on 19/20. Those numbers
are no longer held out: the engine was changed after seeing the failures.

## Later

With every callback fooled, the first run's scenarios paid 26,930 EUR to
attacker accounts, with links off and on alike: these are single-case
attacks, and a callback is what stops them. Two of them (H02, H18) set a
Reply-To on another domain. Since a Reply-To that does not match the sender
counts as a failed check, the fooled-callback total is 16,790 EUR, again the
same with links off and on.
