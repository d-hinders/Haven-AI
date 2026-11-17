---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/accounting/receipt-statement.ts
  - packages/backend/src/modules/accounting/entry.ts
  - packages/demo-merchant-mcp/src/invoice.ts
last-verified: "2026-11-17"
---

# The merchant receipt shape Haven reads

A merchant can return its own receipt with a paid response, as JSON in the
`x-receipt-json` header. The agent's SDK relays it to Haven
(`POST /machine-payments/:id/merchant-receipt`), and Haven stores it in
`merchant_receipts`, first write wins. This page lists the fields Haven reads
from that receipt, and what it does with each.

The shape is the demo merchant's (`InvoiceJson` in
`packages/demo-merchant-mcp/src/invoice.ts`): a Swedish bookkeeping document
with Swedish keys. A merchant that wants its lines and VAT on its customers'
accounting entries sends the same keys.

## Seller block

Read by `sellerFromMerchantReceipt` (`receipt-underlag.ts`, #3918). Each value
is optional; a missing or non-string value is treated as absent.

| Key | Meaning |
|---|---|
| `saljare.name` | The seller's legal name |
| `saljare.org_nr` | The seller's organisation number |
| `saljare.moms_nr` | The seller's VAT registration number |

## Lines and VAT (#4875)

Read by `receiptStatementFrom` (`receipt-statement.ts`) onto the accounting
entry's `receiptStatement`.

**Top level**

| Key | Type | Meaning |
|---|---|---|
| `rader` | array, 1–50 items | The product lines (below) |
| `belopp_exkl_moms` | decimal string | Total excluding VAT |
| `moms_procent` | number, 0–100 | VAT rate |
| `moms_belopp` | decimal string | VAT amount |
| `totalt_inkl_moms` | decimal string | Total including VAT |
| `valuta` | upper-case code, e.g. `USDC` | The currency every amount is in |
| `momsbehandling` | upper-case code, optional | The merchant's own VAT treatment, e.g. `SE_25`, `REVERSE_CHARGE` |

**Each line in `rader`**

| Key | Type | Meaning |
|---|---|---|
| `beskrivning` | string, 1–300 characters, no control characters | What was sold |
| `antal` | number, greater than 0 | Quantity |
| `apris_exkl_moms` | decimal string | Unit price excluding VAT |
| `moms_procent` | number, 0–100 | VAT rate on the line |
| `moms_belopp` | decimal string | VAT amount on the line |
| `totalt_inkl_moms` | decimal string | Line total including VAT |

A decimal string is digits with an optional decimal point, such as `"0.0005"`
or `"0"`. Amounts given as numbers, negative amounts and exponents are not
accepted.

**How the read behaves**

- **All or nothing.** If any field above is missing or malformed, the receipt
  counts as stating no lines. Haven never keeps the well-formed lines of a
  partly malformed receipt, because a partial list would look like the whole
  purchase. The reader never throws.
- **A stated zero is stated.** A reverse-charge receipt with `moms_procent: 0`
  and `moms_belopp: "0"` states a VAT of zero.
- **Other keys are ignored.** Keys not listed here, at the top level or on a
  line, do not affect the read. A merchant can add an order id, more seller
  details or a different invoice-number format.
- **Merchant-stated SEK figures are not read.** The SEK value Haven books is
  its own, frozen when the payment settled.
- **The buyer block is never read here.** `kopare`, including the buyer's VAT
  number in `kopare.deklaration.moms_nr`, stays out of the statement.
- **The total is compared, never booked.** When `valuta` is the token Haven
  settled, the stated `totalt_inkl_moms` is compared with the settled amount,
  and the entry's `totalCheck` says `matches` or `differs`. In any other
  currency it says `not_comparable`. The amount booked is always the amount
  Haven settled.

## What the statement is not

The receipt is relayed by the agent and is not signed by the merchant. The
statement reports what the receipt says; nothing in Haven treats the lines or
VAT figures as verified. How a document labels them is decided where they are
shown (#4876).

The statement also does not decide the transaction kind. A receipt with no
`rader` can still be classed as a purchase by `merchantDocumentShape`
(`transaction-kind.ts`).
