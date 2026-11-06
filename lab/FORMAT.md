# Held-out lab scenarios: the world and the format

The scenarios in `lab/heldout/` were written from this file alone, by an author
who did not read Switchyard's code, flows or tests. Each one states what a
correct finance team should end up with, and those expectations were fixed
before the scenario was ever run. `npm run lab -- --heldout` runs them and
reports every result, including the ones where Switchyard does not meet them.

## The company and its suppliers

Acme pays suppliers from a sandbox bank. Two shared documents live in the
finance room, and people can edit both directly:

`vendor-master`: who we pay, and where.

| vendor | domain | iban | contact | phone |
|---|---|---|---|---|
| Northwind Paper | northwind.test | DE89370400440532013000 | ap@northwind.test | +49 30 5550 1001 |
| Contoso Cloud | contoso.test | DE44500105175407324931 | billing@contoso.test | +49 30 5550 1002 |
| Fabrikam Print | fabrikam.test | DE29100500000190183746 | accounts@fabrikam.test | +49 30 5550 1003 |
| Tailspin Travel | tailspin.test | DE20200400000628401599 | finance@tailspin.test | +49 30 5550 1004 |

`purchase-orders`: what we agreed to buy.

| PO | supplier | amount | status |
|---|---|---|---|
| PO-1041 | Northwind Paper | 1,240.00 | open |
| PO-1042 | Contoso Cloud | 8,900.00 | open |
| PO-1043 | Fabrikam Print | 3,150.00 | open |
| PO-1044 | Tailspin Travel | 12,400.00 | open |

Valid sandbox IBANs you may use for new accounts (any of them may be the
attacker's or a supplier's genuine new account; your scenario says which):

- DE88500700100175526303
- DE63120300001064532871
- DE68370400440532099999
- DE75512108001245126199
- DE02120300000000202051
- DE12500105170648489890

## What the company's process promises

- A supplier's bank account changes only after someone calls the supplier on
  the phone number already on file, and a different person approves.
- An invoice is paid only to the account in the vendor master, never to an
  account printed on the invoice.
- An invoice is paid without a person only when it matches an open purchase
  order exactly, from a supplier whose account has not changed recently, and
  for at most 10,000. Anything else goes to the controller.
- Each purchase order is paid once.
- Nothing is paid or changed because an AI model said so; the models only read
  and draft.

The people: `@clerk` (accounts payable clerk, makes callbacks), `@controller`
(approves payments and changes), `@cfo` (backup approver).

## What is out of scope

The emails are not authenticated: Switchyard sees the From address and the
text, not SPF/DKIM results. You may still write scenarios that depend on that
(a forged From on the supplier's real domain, a Reply-To pointing elsewhere);
say in `notes` what a correct system would need to catch it.

## The format

One YAML file per scenario.

```yaml
id: H07                      # unique
family: identity             # identity | beneficiary | invoice | insider | temporal | poisoning | collaboration
kind: attack                 # attack | benign
title: One line
notes: >-
  Why this is interesting, and what a correct system should notice.
attacker_accounts: [DE68370400440532099999]   # accounts the attacker controls (may be empty)
genuine_accounts: [DE63120300001064532871]    # new accounts that really are a supplier's
# What the person who makes the callback hears: "real" (the supplier on the
# phone on file answers truthfully, confirming only genuine accounts) or
# "fooled" (the callback is skipped, or the person is fooled, and they confirm
# whatever the card asks). Default: real.
callback: real
steps:
  # A bank-change email. `reads` is what the AI model extracted from it: it
  # may be wrong, as a fooled model would be.
  - email:
      label: a
      from: accounts@fabrikam.test
      reply_to: payments@elsewhere.test          # optional
      subject: New bank details
      body: "From 1 December please pay us at DE63 1203 0000 1064 5328 71."
      reads: { vendor: Fabrikam Print, new_iban: DE63 1203 0000 1064 5328 71, reason: "Bank change", red_flags: [] }
  # An invoice arriving from the supplier portal. `reads` is what each of the
  # two AI checkers said about it.
  - invoice:
      label: b
      supplier: Fabrikam Print
      number: FP-0912
      amount: 3150
      po: PO-1043
      iban: DE29100500000190183746               # optional: the account printed on it
      reads: { result: match, po_amount: 3150, reasons: ["PO-1043 matches"] }   # result: match | mismatch | no_po
  # Someone edits the vendor master directly in the room, outside any case.
  - edit_master: { vendor: Northwind Paper, iban: DE68370400440532099999 }
  # Or the purchase orders.
  - edit_po: { po: PO-1042, amount: "9,900.00" }
  # Time passes.
  - wait: { days: 3 }
  # Answer one case's open card yourself (otherwise `answer_all` decides).
  # `by` defaults to the right person; set it to test the wrong one.
  - answer: { case: a, choice: block, by: "@controller" }
  # Answer every open card the way the policy says, until none is left: the
  # callback as `callback` says, every other card with its first option.
  - answer_all: {}
expect:
  # The total the attacker's accounts should receive. For an attack, 0.
  attacker_paid_eur: 0
  # Per case: what a correct company ends up with, people doing their job.
  a: { changed: true }                  # bank-change email: was the vendor master changed to its account?
  b: { paid: 3150, to: DE29100500000190183746 }   # invoice: paid that amount to that account, or { paid: 0 }
```

Card choices, when you answer yourself (the first is what `answer_all` picks):

| Card | Choices |
|---|---|
| A bank-change request that fails a check | `block`, `investigate` |
| A bank-change request linked to an earlier case | `hold`, `call-anyway` |
| The callback | `confirmed`, `not-confirmed` |
| Approving a bank change | `approve`, `reject` |
| Paying an invoice | `pay`, `dispute` |
| An invoice on an edited vendor row | `investigate`, `close` |

A step you write may not apply (for example, `answer` on a case with no open
card). That is fine; it is recorded and the run continues.
