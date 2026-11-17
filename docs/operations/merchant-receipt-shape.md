---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/accounting/receipt-statement.ts
  - packages/backend/src/modules/accounting/receipt-underlag.ts
  - packages/backend/src/modules/accounting/product-sources.ts
  - packages/backend/src/modules/accounting/entry.ts
  - packages/backend/src/modules/accounting/transaction-kind.ts
  - packages/backend/src/infra/repositories/machine-payments.ts
  - packages/demo-merchant-mcp/src/invoice.ts
  - packages/merchant-payments/src/receipt.ts
  - packages/sdk/src/merchant-completion.ts
last-verified: "2026-11-17"
---

# The merchant receipt shape Haven reads

A merchant can return its own receipt with a paid response, as base64-encoded
JSON in the `x-receipt-json` header. The agent's SDK relays it to Haven
(`POST /machine-payments/:id/merchant-receipt`), and Haven stores it in
`merchant_receipts`, first write wins. This page lists the fields Haven reads
from that receipt, and what it does with each.

The shape is the demo merchant's (`InvoiceJson`, built by `buildReceipt` in
the shared core `packages/merchant-payments/src/receipt.ts`, which the demo
merchant calls from `packages/demo-merchant-mcp/src/invoice.ts`): a Swedish bookkeeping document
with Swedish keys. A merchant that wants its lines and VAT on its customers'
accounting entries sends the same keys.

## Seller block

Read by `sellerFromMerchantReceipt` (`receipt-underlag.ts`, #3918). Each value
is optional; a missing, blank or non-string value is treated as absent.

| Key | Meaning |
|---|---|
| `saljare.name` | The seller's legal name |
| `saljare.org_nr` | The seller's organisation number |
| `saljare.moms_nr` | The seller's VAT registration number |

`saljare.name` also names the payee on the dashboard (#4881, the receipt
step of the recipient-naming order): the activity feed, analytics, the
top-merchant and first-payment cards, and transaction search. There it is
cleaned (control, invisible and bidirectional characters stripped,
whitespace collapsed, trimmed) and dropped when it is empty or longer than
120 characters; a flat top-level `merchant_name` is the fallback. A `saljare`
block nested under another key is not read, here or by the accounting side.

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
| `valuta` | code, e.g. `USDC` | The currency every amount is in |
| `momsbehandling` | code, optional | The merchant's own VAT treatment, e.g. `SE_25`, `REVERSE_CHARGE` |

**Each line in `rader`**

| Key | Type | Meaning |
|---|---|---|
| `beskrivning` | string, 1–300 characters after trimming | What was sold |
| `antal` | number, greater than 0 and at most 1,000,000 | Quantity |
| `apris_exkl_moms` | decimal string | Unit price excluding VAT |
| `moms_procent` | number, 0–100 | VAT rate on the line |
| `moms_belopp` | decimal string | VAT amount on the line |
| `totalt_inkl_moms` | decimal string | Line total including VAT |

A decimal string is 1–30 digits, optionally followed by a point and 1–30 more
digits, such as `"0.0005"` or `"0"`. Amounts given as numbers, negative
amounts, exponents, `"1."` and `".5"` are not accepted.

A code is read case-insensitively: it is upper-cased, then must be ASCII
letters, digits and `_`, starting with a letter, at most 32 characters. It is
stored upper-case, so `usdc` reads as `USDC`.

After trimming, a description may not contain control characters, line or paragraph
separators, bidirectional marks, overrides or isolates, a zero-width space,
word joiner or invisible operator, or a byte-order mark.
The zero-width joiner and non-joiner are allowed, because Persian and Indic
text and emoji sequences need them.

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
  and the entry's `totalCheck` says `matches` or `differs`. The comparison
  uses the settled atomic amount at the token's full precision. In any other
  currency, or when Haven has no settled amount or does not know the token's
  decimals, it says `not_comparable`. The amount booked is always the amount
  Haven settled.
- **Totals and lines are not checked against each other.** Nothing confirms
  that the lines add up to the totals, or that the amount excluding VAT plus
  the VAT equals the total. The statement reports the receipt as written.

## What the statement is not

The receipt is relayed by the agent and is not signed by the merchant. The
statement reports what the receipt says; nothing in Haven treats the lines or
VAT figures as verified. Wherever they are shown (#4876) they are labelled "On
the merchant's receipt, as reported by the agent", never "stated by the
merchant" (owner decision 3 of 2026-11-17 on #4874). Where they are printed,
and what a document says when a receipt states none, is in
[`accounting-feed.md`](accounting-feed.md).

When a receipt states no lines, the document falls back to the other sources
Haven stores — the Haven catalog name, the quote description and the agent's
delivery reference (#4877) — each under a label naming who supplied it, never
the receipt's label. The ladder is in
[`accounting-feed.md`](accounting-feed.md).

The statement also does not decide the transaction kind. A receipt with no
`rader` can still be classed as a purchase by `merchantDocumentShape`
(`transaction-kind.ts`).
