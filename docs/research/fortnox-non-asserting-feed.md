---
owner: "@d-hinders"
status: research
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Spike — Fortnox non-asserting feed mechanism (#494)

> Status: **spike / design decision.** Resolves *how* Haven feeds a settled agent
> payment into Fortnox as a non-asserting transaction (epic #491). Recommendation
> below is high-confidence on ranking, but the final pick must be validated
> against a Fortnox sandbox — that live step needs a Fortnox developer app and
> can't be done from here.

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

## References

- Fortnox vouchers + file inbox (`Inbox_v`, multipart upload): https://www.fortnox.se/developer/guides-and-good-to-know/best-practices/vouchers
- Fortnox invoice file connections: https://developer.fortnox.se/documentation/resources/invoice-file-connections/
- Fortnox API (v3) reference: https://api.fortnox.se/apidocs
- Reuses: `AccountingEntry`/book-time FX (#467), verifiable receipts (#486), Fortnox OAuth/token lifecycle (#469). Legacy asserting paths darked in #492.
