---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/modules/reporting/**
  - packages/backend/src/routes/reporting.ts
  - packages/backend/src/infra/repositories/reporting-feed-syncs.ts
  - packages/frontend/src/app/(authenticated)/reporting/page.tsx
  - packages/frontend/src/hooks/useReporting.ts
last-verified: "2026-08-12" # written for #1362; #1364-review corrections: deleted-invoice recovery is a documented GAP (not "Sync now"), ledger skipped-status unreachability documented; both tracked in #1365
---

# Fortnox reporting feed — operations runbook

How an agent purchase becomes a source document in the user's Fortnox, how to
verify it landed, and what to do when it didn't. The feed is **non-asserting**
by principle (epic #491): Haven creates *unattested supplier invoices* — the
accountant codes, books, and files. Haven never posts voucher rows, BAS
accounts, or VAT.

Design references: `docs/research/accounting-data-feed.md` (architecture),
`docs/research/fortnox-non-asserting-feed.md` (the #494 sandbox spike that
proved the mechanism live on 2026-07-16).

## The flow, end to end

```
Purchase settles on-chain
  │  (x402 funding confirmation or MPP receipt)
  ▼
machine_payment_evidence row written (with book-time SEK amount when FX is ready)
  │
  ▼
feedSettledPaymentBestEffort()          ← fire-and-forget: NEVER blocks settlement
  ├─ entitlement gate: hosted + flag + user entitlement ('reporting_feed')
  ├─ claimSync(user, 'fortnox', payment) → reporting_feed_syncs row 'pending'
  │    (unique on (provider, payment_id, user_id) — the double-post guard)
  ├─ build AccountingEntry → ReportingTransaction (VAT/account fields STRIPPED)
  ├─ FortnoxConnector.pushTransaction:
  │    ├─ token refresh if needed (fortnox_connections)
  │    ├─ find-or-create supplier (name only, nothing asserted)
  │    ├─ POST /supplierinvoices  → UNATTESTED invoice,
  │    │     ExternalInvoiceNumber = HAVEN-<paymentId>, Total in SEK,
  │    │     DueDate = InvoiceDate (already settled), no VAT/account rows
  │    ├─ POST /inbox + /supplierinvoicefileconnections
  │    │     → Haven payment-evidence PDF attached (#498)
  │    └─ merchant's own receipt attached too when captured (#956;
  │          arrives late on x402 → lateAttachMerchantReceipt)
  └─ markPushed(external_ref = 'fortnox:supplierinvoice:<GivenNumber>')
       or markFailed(error) — retryable via the dashboard's "Sync now"
```

What the accountant sees in Fortnox: an unbooked supplier invoice with the
payment-evidence PDF(s) attached, `Booked: false`, no voucher — until they
attest it. Booking assigns `VoucherSeries`/`VoucherNumber`/`VoucherYear`.

## Verifying that a payment landed in Fortnox

Three layers, in order of convenience:

1. **Dashboard (from #1362):** `/reporting` lists every sync row. A `pushed`
   row shows its **Fortnox invoice number**; the **Check in Fortnox** button
   performs a live read-back against Fortnox's own records and reports one of:
   - *Registered — awaiting booking*: the invoice exists, `Booked: false`.
     This is the expected steady state until the accountant acts.
   - *Booked, voucher `<series><number> <year>`*: a human has accounted for
     it. This is "redovisad".
   - *Cancelled*: registered but struck in Fortnox.
   - *Not found*: the invoice was deleted in Fortnox. **There is no supported
     self-service recovery for this case today**: the ledger row is `pushed`,
     pushed rows are never re-claimed (the double-post guard), and the
     "Sync now" backfill deliberately excludes them — pressing it will NOT
     re-push this payment. Do not hand-edit the row either (see the schema
     section). Escalate: recovering a deleted-in-Fortnox invoice is an
     operator/engineering decision, tracked as a known gap.
   The read-back cross-checks `ExternalInvoiceNumber == HAVEN-<paymentId>`,
   so a number collision after e.g. a Fortnox company switch reads as *Not
   found*, never as a false "registered".

2. **Fortnox's own UI** (production app or the developer-portal sandbox
   company): *Bokföring → Leverantörsfakturor*. Filter or search for the
   supplier (agent merchants appear by name, or as `Merchant 0x1234-abcd`),
   or match the invoice number shown in the Haven dashboard. Open the invoice:
   the *Externt fakturanummer* field carries `HAVEN-<paymentId>` — that string
   is the join key between the two systems. Attachments show the Haven
   payment-evidence PDF (and the merchant receipt when captured).

3. **API, for on-call:** `GET /accounting/reporting/status` (user-scoped)
   returns every sync row with `status`, `external_ref`, `error`, `attempts`.
   `GET /accounting/reporting/verify/:paymentId` returns the live read-back
   (`registered` / `booked` / `voucher` / `cancelled`). Both are read-only.

## Troubleshooting: "my payment didn't sync"

Work the sync row's `status` on `/reporting` (or `reporting_feed_syncs`):

| Status | Meaning | Action |
| --- | --- | --- |
| `pushed` | Delivered. `error` column may carry a non-fatal **note** (e.g. "receipt attachment failed") — invoice exists, attachment degraded | Use *Check in Fortnox* for live state; reconnect Fortnox if the note names a scope error, then re-capture attachments is NOT automatic — the invoice stands |
| `failed` | Fortnox push failed; `error` carries the Fortnox message verbatim | Fix the named cause (often token/scope), press **Sync now** — failed rows are re-claimed and retried |
| `pending` | Claimed but in flight (or a crashed in-flight push) | Wait; a stuck pending row is not auto-recovered (deliberate — the claim IS the concurrency guard). If genuinely stuck, escalate rather than editing the row |
| `skipped` | Reserved in the type but **not written by any current path**: a connector-level skip (`not_connected`, `no_sek_amount`, `not_outbound`) is recorded as `pushed` with a NULL `external_ref` — the row is final and the backfill will not revisit it. A pushed row WITHOUT an invoice number is therefore the "skipped" signal in practice | If the skip reason was transient (e.g. a disconnect race), the payment will not be re-fed automatically — escalate; do not hand-edit |
| *(no row)* | The settle-time hook never ran (entitlement off, feature flag off) or the payment predates the feed | Check `GET /accounting/reporting/status` base flags; **Sync now** backfills once entitled |

Common causes, from live experience:

- **Token expired / not connected**: pushes skip with `not_connected`. The
  dashboard shows *Not connected* — reconnect via the Connect button.
- **Scope widened** (the `connectfile` lesson, 2026-07-16): connections
  consented before a scope was added still push invoices but fail file
  connections with Fortnox error `[2000663]` — the row is `pushed` with a
  degradation note. Fix: **Disconnect, then Connect** on `/reporting` to
  re-consent with the current scope set
  (`bookkeeping supplierinvoice supplier archive inbox connectfile`). There is
  no automatic re-consent flow today.
- **Non-ASCII rejection** (Fortnox error `2000359`): Comments/Name reject
  middle dots, `://`, and the app's `…` ellipsis. The connector already
  sanitizes; a new occurrence means a new field slipped through — fix the
  connector, not the data.
- **x402 receipt arrives after push**: expected (#956) — the merchant hands
  its receipt at the retry, seconds after the funding-confirmation push. The
  capture route late-attaches onto the existing invoice; a late-attach failure
  becomes a note on the row.

## Schema for on-call: `reporting_feed_syncs`

One row per (user, provider, payment). `status`:
`pending → pushed | failed` (failed is re-claimable; pushed is FINAL — never
re-claimed, that would double-post into a customer ledger). `external_ref` =
`fortnox:supplierinvoice:<GivenNumber>`. `error` doubles as the non-fatal
degradation note on pushed rows (#498 contract). `attempts` increments per
claim. Never hand-edit status: flipping `pushed` back re-posts the invoice.

## Boundaries (what this feed will never do)

- **Never asserts**: no voucher rows, no BAS account, no VAT — structurally
  banned (`assertNonAsserting`, test-locked). The `suggestedAccount` rides as
  free text in `YourReference` only.
- **Never books**: the read-back verification (#1362) is the only read, and it
  is strictly read-only — Haven cannot book, cancel, or modify the invoice.
- **Never blocks money**: the settle-time hook is fire-and-forget; a Fortnox
  outage delays reporting, never settlement.
