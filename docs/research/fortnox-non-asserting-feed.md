---
owner: "@d-hinders"
status: research
covers: []  # narrative — no direct code mirror
last-verified: "2026-07-16"
---

# Spike — Fortnox non-asserting feed mechanism (#494)

> Status: **VALIDATED LIVE 2026-07-16** against a Fortnox test environment
> (developer app "Haven", sandbox company "Haven") via
> `npm run pilot:fortnox` — the pilot runs the PRODUCTION connector code
> (#496, `lib/reporting/fortnox-connector.ts`). Verdicts on every open
> question are recorded at the bottom. The supplier-invoice recommendation
> HELD.

## The question

#491 re-aims the bookkeeping data at a **feed**: push each settled payment into
the customer's Fortnox as a *draft / source document* — receipt attached,
**no asserted VAT, no chosen accounts** — so the accountant codes and confirms.
Fortnox offers several inbound mechanisms; which one fits "non-asserting"?

## Constraints the mechanism must meet

1. **Non-asserting** — must NOT post a finished voucher or pick VAT/BAS accounts.
2. **Structured where possible** — carry amount, currency, date, supplier, so the
   accountant isn't retyping from a PDF.
3. **Receipt attachable** — the underlag (our verifiable receipt / evidence) must
   ride along.
4. **Idempotent** — re-running a sync must not duplicate (we key on
   `(provider, payment_id)`; the mechanism needs a stable external ref or a way
   to detect dupes).
5. **Reversible / low-liability** — the accountant can discard/edit before it
   touches the ledger; Haven never finalises.
6. **Reuses what we have** — book-time SEK + counterparty + amount from the
   canonical `AccountingEntry` (#467); receipt from #486; OAuth from #469.

## Candidate mechanisms

| Mechanism | Non-asserting? | Structured? | Receipt? | Verdict |
|---|---|---|---|---|
| **Supplier invoice (unattested)** | ✅ no voucher until the accountant attests/books | ✅ supplier, amount, currency, date | ✅ file connection | **Primary candidate** |
| **File inbox / archive** (`Inbox_v`, multipart upload → `Id`) | ✅ pure source document | ❌ just a file; no amount metadata | ✅ that's its whole job | **Fallback / complement** |
| **Draft voucher** | ❌ a voucher *is* debit/credit lines → asserts accounts/VAT | ✅ | ✅ | **Rejected** (contradicts the epic) |
| **Manual/"other" account transaction import** | ~ depends on workflow | ✅ | partial | **Investigate in sandbox** |

### Why supplier invoice is the lead
A Fortnox **supplier invoice** models "a purchase from a supplier" — semantically
exactly an agent payment to a merchant. Created via the API it sits **unattested
/ unbooked** until a human attests and bookkeeps it, so Haven asserts nothing: we
supply supplier + amount + currency + date + the receipt, and the accountant
picks the account/VAT and books. It also has a first-class **file connection** so
the verifiable receipt attaches as the underlag.

### Why the file inbox is the complement, not the primary
The inbox (upload a file, get an `Id`, connect it to a record) is the *most*
non-asserting option — it's a pure source document — but it carries **no
structured amount/supplier**, so the accountant retypes everything. Best used to
**attach the receipt** to whatever structured record we create, not as the record
itself.

### The wrinkle to resolve in the sandbox
Our payment is **already settled on-chain** — it's not an open payable. A supplier
invoice implies an AP obligation + a later payment in Fortnox. So the open
question is whether to (a) create the supplier invoice and mark it externally
paid, (b) accept the small semantic mismatch (accountant reconciles the payment
leg), or (c) use a different "already-paid expense" path Fortnox may expose. This
is the one thing a doc can't settle — it needs a sandbox round-trip.

## Recommendation

1. **Primary: supplier invoice (unattested) + attached receipt.** Structured,
   non-asserting, receipt rides along, accountant codes it.
2. **Fallback: file-inbox source document** if the supplier-invoice "already
   paid" semantics prove awkward in the sandbox — ship the receipt as underlag
   with a structured description and let the accountant create the entry.
3. **Never** the draft voucher (asserts) — that's the #462 path #492 just darked.

Confidence: **high on the ranking**, **medium on supplier-invoice-as-final** until
the already-paid semantics are confirmed live.

## Shape this implies (for #495)

A non-asserting `ReportingTransaction` the connector maps per provider — **no VAT,
no account**:

```
ReportingTransaction {
  paymentId            // idempotency key with provider
  date                 // settledAt
  supplier             // merchant name / address
  amount, currency     // book-time SEK + original token amount
  description          // resource/tool, agent name
  receiptRef           // verifiable receipt / evidence
  suggestedAccount?    // optional hint only, never asserted
}
```

`AccountingConnector.feed(tx)` → returns a provider ref for the dedup ledger
(`reporting_feed_syncs`, #497). Fortnox is the first adapter (#496).

## Open questions for the sandbox round-trip (the live step)

1. Does an API-created **supplier invoice** stay unattested/unbooked until a human
   acts? (Must confirm it asserts nothing.)
2. Best path for an **already-paid** purchase — mark the supplier invoice paid, or
   a different expense path?
3. Stable external ref on the invoice/inbox item for **idempotency**?
4. **Scopes** required (supplier invoice + file connection) on top of the existing
   Bookkeeping scope.
5. Receipt **file-connection** flow end-to-end (`Inbox_v` upload → connect Id).

## Sandbox verdicts (2026-07-16 — closes the open questions)

1. **Unattested: CONFIRMED.** The API-created supplier invoice lands with
   `Booked: false`, `VoucherNumber: null` — nothing is asserted until a human
   attests and bookkeeps. The non-asserting invariant holds live.
2. **Already-paid semantics: option (b), accepted.** The invoice carries an
   open AP `Balance` (10.42 in the probe); the accountant reconciles the
   payment leg when coding. `DueDate = InvoiceDate` and the comment says
   "already settled on-chain". No dedicated "externally paid" creation path
   surfaced; revisit only if accountants report friction.
3. **Idempotency ref: CONFIRMED.** `ExternalInvoiceNumber = HAVEN-<paymentId>`
   round-trips exactly on read-back. (The dedup ledger #497 remains the
   idempotency guarantee; this is the belt to its braces.)
4. **Scopes: CONFIRMED.** `bookkeeping supplierinvoice supplier archive` all
   granted through consent (archive is pre-staged for #498 receipts).
5. **Live gotcha (found by the probe, fixed in the adapter):** Fortnox rejects
   several non-alphanumeric characters in `Comments` — middle dots and `://`
   both trip error 2000359 ("Värdet innehåller ej tillåtna tecken"). The
   adapter's `feedDescription` emits plain ASCII sentences and the resource
   HOST rather than the full URL. The same restriction applies to the supplier
   `Name` field (found on the first real feed — the app's canonical `…`
   ellipsis in the address fallback tripped it; ASCII hyphen now).

## Receipt attachment — the underlag (#498, built 2026-07-16)

The mechanism chosen: render the **verifiable payment receipt** (#486) as a
small dependency-free PDF (`lib/reporting/receipt-underlag.ts` — payment,
book-time SEK + FX provenance, merchant, on-chain tx hash, authorization
signature, and a pointer to independent verification via
`verifyPaymentReceipt` in `@haven_ai/sdk`), then in the connector after the
invoice is created:

1. `POST /3/inbox` (multipart) — upload the PDF to the Fortnox Inbox.
2. `POST /3/supplierinvoicefileconnections` — connect the returned `File.Id`
   to the invoice's `GivenNumber`.

Semantics locked by tests:

- **Strictly best-effort.** The invoice is the delivered value; a missing
  receipt or failed upload/connection NEVER fails the push. The degradation is
  returned as `PushResult.note` and recorded by the orchestrator on the
  (pushed) sync row's `error` column — observable in the Reporting UI, but not
  retryable (a retry would double-post the invoice).
- **Scope:** requires `inbox` (portal permission "Inkorg") — `FORTNOX_SCOPE`
  widened; connections consented before the widening degrade to note-only
  attachment until the user reconnects.
- **ASCII discipline** (gotcha 5) extends to the PDF text and filename.

Live validation: `npm run pilot:fortnox` now proves Q5 (attach + read-back of
the file connection) alongside Q1–Q4. Status: **pending its live sandbox run**
(needs "Inkorg" ticked on the integration + re-consent).

## References

- Fortnox vouchers + file inbox (`Inbox_v`, multipart upload): https://www.fortnox.se/developer/guides-and-good-to-know/best-practices/vouchers
- Fortnox invoice file connections: https://developer.fortnox.se/documentation/resources/invoice-file-connections/
- Fortnox API (v3) reference: https://api.fortnox.se/apidocs
- Reuses: `AccountingEntry`/book-time FX (#467), verifiable receipts (#486), Fortnox OAuth/token lifecycle (#469). Legacy asserting paths darked in #492.
