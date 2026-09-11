---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/modules/accounting/**
  - packages/backend/src/routes/accounting-feed.ts
  - packages/backend/src/infra/repositories/accounting-feed-syncs.ts
  - packages/frontend/src/app/(authenticated)/accounting/page.tsx
  - packages/frontend/src/hooks/useAccountingFeed.ts
last-verified: "2026-09-11"
---

# Accounting feed (Fortnox) — operations runbook

How an agent purchase becomes a source document in the user's Fortnox, how to
verify it landed, and what to do when it didn't. The feed is **non-asserting**
by principle (epic #491): Haven creates *unattested supplier invoices* — the
accountant codes, books, and files. Haven never posts voucher rows, BAS
accounts, or VAT.

> **Renamed by #2859 (epic #2858).** The module, routes, page and this runbook
> moved from "reporting" to **Accounting**: the feed routes are
> `/accounting/feed/*`, the page is `/accounting` (`/reporting` redirects), and
> the kill-switch is `HAVEN_ACCOUNTING_ENABLED` — the old
> `HAVEN_REPORTING_FEED_ENABLED` is still honoured with a boot warning, and the
> new name wins whenever it is set, including when set to `false`.
>
> Two names deliberately did **not** change here and still appear below: the
> `reporting_feed_syncs` table and the `reporting_feed` entitlement string.
> #2860 renames both in one migration, so this slice carried no migration at
> all. Until it lands, on-call reads the table under its old name.

## Who is entitled (#2861)

`HAVEN_ACCOUNTING_ENTITLEMENT_MODE` decides how an account passes the
entitlement gate — the hosted and `HAVEN_ACCOUNTING_ENABLED` checks still come
first and are unchanged:

| Mode | Who passes | Where |
|------|------------|-------|
| `granted` (default, also when unset) | accounts holding an `account_entitlements` row for the feed | prod — nobody is entitled until a paid tier grants rows |
| `all` | every account on the deployment; no row is read or written | dev, so the team uses the feed without hand-written SQL grants |

Any other value refuses the boot with a message naming both modes: a
misspelled `all` on dev must never silently mean `granted`. `GET
/accounting/feed/status` reports `entitlementMode` and `entitled` next to
`available`, so on-call can read from one response whether an account is
entitled by mode or by row. The pre-#2861 recipe of inserting an
`account_entitlements` row by hand on dev is retired; nothing on prod changes
because prod never sets the variable.

Design references: `docs/research/accounting-data-feed.md` (architecture),
`docs/research/fortnox-non-asserting-feed.md` (the #494 sandbox spike that
proved the mechanism live on 2026-07-16).

## The flow, end to end

```
Purchase settles on-chain
  │  (x402 funding confirmation, erc7710 settlement observed, or MPP receipt)
  ▼
machine_payment_evidence row written (with book-time SEK amount when FX is ready)
  │
  ▼
feedSettledPaymentBestEffort()          ← fire-and-forget: NEVER blocks settlement
  ├─ entitlement gate: hosted + flag + user entitlement ('reporting_feed',
  │    or every account when HAVEN_ACCOUNTING_ENTITLEMENT_MODE=all — #2861)
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
       or markSkipped(reason) / markFailed(error) — both retryable via "Sync now" (#1365)
```

**Every settlement scheme enters at the same door (#2092).** The feed has never
had a rail or scheme filter and still does not — what it needs is a `confirmed`
intent with a `tx_hash`, which is what produces the `machine_payment_evidence`
row above. On EIP-3009 Haven submits the funding transaction and learns that
hash itself; on **erc7710 direct settlement** the merchant redeems the
delegation chain and Haven submits nothing, so the intent used to sit at
`submitted` forever and those purchases reached neither Fortnox nor the
dashboard. `POST /machine-payments/evidence` now completes such an intent from
the merchant's reported settlement hash after verifying it on-chain — see
[`04-x402-payment-sequence.md` § Completing an erc7710 settlement](../architecture/04-x402-payment-sequence.md).
**A settlement nobody reported still reaches the feed (#2117).** A merchant that
returns no `PAYMENT-RESPONSE` transaction leaves Haven no hash to verify, and
such a payment used to stay `submitted` and never reach the feed at all —
neither by auto-feed nor by "Sync now", since the backfill enumerates
`machine_payment_evidence`. A leader-gated sweep now finds those settlements
on-chain and completes them through the same door, so they arrive with book-time
FX, a fee-ledger row and an auto-feed call exactly like every other rail.

**Residual gaps, and why they are left open on purpose.** The sweep attributes a
settlement only when the pinned DelegationManager's own log names that payment's
settlement child. It will not fall back to "a transfer of the right shape in the
right window", because on an accounting feed a confidently misattributed row is
worse than a missing one — the missing row surfaces at reconciliation and the
wrong one does not. So three cases still produce no feed row, all of them
fail-closed and all of them logged as warnings once the payment's settlement
window has closed:

1. a facilitator route that emits no decodable manager log;
2. two look-alike payments authorized before #2094, which share one settlement
   child and so cannot be told apart at all;
3. a settlement older than the sweep's 24-hour recovery horizon — i.e. an RPC
   outage lasting more than a day.

If a settled payment is missing from Fortnox, that warning line is where to
look; see
[`04-x402-payment-sequence.md` § Completing a settlement nobody reported](../architecture/04-x402-payment-sequence.md).

**None of the three is a dead end, and the warning now says so (#2214).** The
line reads `Settled erc7710 payment is past its settlement window and the sweep
cannot attribute it`, at `warn`, carrying `paymentId`, `agentId`, `chainId`,
`reason` (`no_manager_log` or `ambiguous_redemption`) and a **`remedy`** field.
**Operator fix:** have the agent re-report the merchant's settlement transaction
hash to `POST /machine-payments/evidence` using its own credential. That path
runs the same on-chain verifier without the sweep's `requireDelegationBound`
constraint, so it does not need the manager log the scan could not find (cause
1), and it is not bounded by the 24-hour recovery horizon (cause 3). Cause 2 is
the one where a human decision is genuinely required first — two indistinguishable
payments, and Haven will not pick. The remedy is in the log because a warning
that names no action is a warning people learn to scroll past.

**A fourth cause, and the one that used to be silent (#2213).** Completing a
payment is two writes — the intent flips `submitted → confirmed`, then the
`machine_payment_evidence` row is written — and only the first is guaranteed. A
confirm whose evidence write fails leaves a payment that is settled, has a hash,
and has no feed row: it is out of the sweep's candidate query for good, and
"Sync now" cannot see it either, because the backfill enumerates evidence rows.
Until #2213 nothing automated reached it again — and the tick logged it as a
completion, so nobody had a reason to look. (An agent re-posting the same hash to
`POST /machine-payments/evidence` would in fact still have completed it; the gap
was that nothing prompts a second report, and on the plain-HTTP flow the agent
has no hash to re-post.)

Two log lines now distinguish it, and a recovery pass retries it every tick:

- `Settlement sweep confirmed an erc7710 payment but no evidence row landed` —
  `warn`, carries `paymentId` and a `reason`. The tick's counters separate
  `confirmed` (the state transition) from `evidencePushed` (the completion) and
  `evidenceFailed`.
- `Settled erc7710 payment is confirmed with no evidence row and the row could
  not be written` — `warn`, emitted by the recovery pass on each attempt it
  cannot satisfy.

Almost every cause is transient (a database blip, a lost connection) and the
next tick closes it — `evidenceRecovered` counts those. The one that is not is
`reason: "missing_resource_url"`: `machine_payment_evidence.resource_url` is NOT
NULL, so a settled x402 intent whose `payment_resource_url` and
`x402_resource_url` are both null can never be booked. **Operator fix:** set the
intent's resource URL to the merchant resource the payment paid for; the next
recovery attempt that is not suppressed then writes the row and fires the feed.
That is within one 2-minute tick only if the row has failed once — the recovery
pass backs a repeatedly-failing payment off exponentially, to a ceiling of one
hour (`SCAN_BACKOFF_MAX_MS`), so a payment that has been stuck for a while may
wait up to an hour after the fix. Restarting the leader clears the in-memory
backoff if that wait is not acceptable. After 24 hours the payment leaves the
recovery horizon and needs a manual evidence write.

**No longer a gap (#2094):** two of a user's own look-alike erc7710 payments —
same merchant, token, amount and authorize second — used to be *individually*
unattributable, so a reported settlement was refused for BOTH and neither
reached the feed. The settlement child is now salted per intent, so each
settlement transaction carries a `RedeemedDelegation` log naming exactly one
payment, and each reaches the feed on its own evidence. The refusal is kept for
the cases where attribution genuinely remains impossible (see
[`04-x402-payment-sequence.md`](../architecture/04-x402-payment-sequence.md)
§ *Completing an erc7710 settlement*).

What the accountant sees in Fortnox: an unbooked supplier invoice with the
payment-evidence PDF(s) attached, `Booked: false`, no voucher — until they
attest it. Booking assigns `VoucherSeries`/`VoucherNumber`/`VoucherYear`.

## Where it shows

Two dashboard surfaces read the ledger, both read-only:

- **`/accounting`** — every sync row, with **Check in Fortnox** and the
  re-open action (the section below).
- **`/transactions` (from #2870)** — a compact badge on each fed row, in the
  table and in the detail drawer: *In Fortnox* (`pushed`), *Feeding…*
  (`pending`), *Not fed* (`failed` / `skipped`, the `error` on hover). It
  links to `/accounting`. The list endpoint joins `reporting_feed_syncs` by
  `payment_id` in one query per page and emits an `accounting` object only
  when the account is entitled (`accountingFeedAvailable`), has a Fortnox
  connection, AND a sync row exists — so a row with no badge means "not
  entitled / not connected / never fed" (rows before `feed_from`), never
  "failed". No *Booked* state: the ledger stores no verify result, and the
  list makes no live Fortnox call.

## Verifying that a payment landed in Fortnox

Three layers, in order of convenience:

1. **Dashboard (from #1362):** `/accounting` lists every sync row. A `pushed`
   row shows its **Fortnox invoice number**; the **Check in Fortnox** button
   performs a live read-back against Fortnox's own records and reports one of:
   - *Registered — awaiting booking*: the invoice exists, `Booked: false`.
     This is the expected steady state until the accountant acts.
   - *Booked, voucher `<series><number> <year>`*: a human has accounted for
     it. This is "redovisad".
   - *Cancelled*: registered but struck in Fortnox.
   - *Not found*: the invoice was deleted in Fortnox. Use the
     **Re-open for sync** action next to the verdict (#1365): the server
     re-runs the read-back itself and flips the row back to retryable ONLY
     when Fortnox confirms the invoice is gone — an invoice that still exists
     refuses with nothing written (mutation-tested), so the double-post guard
     holds. Then press **Sync now** to push it again. Never hand-edit the row
     (see the schema section).
   The read-back cross-checks `ExternalInvoiceNumber == HAVEN-<paymentId>`,
   so a number collision after e.g. a Fortnox company switch reads as *Not
   found*, never as a false "registered".

2. **Fortnox's own UI** (production app or the developer-portal sandbox
   company): *Meny → Leverantörsfakturor*. Filter or search for the
   supplier (agent merchants appear by name, or as `Merchant 0x1234-abcd`),
   or match the invoice number shown in the Haven dashboard. Open the invoice:
   the *Externt fakturanummer* field carries `HAVEN-<paymentId>` — that string
   is the join key between the two systems. Attachments show the Haven
   payment-evidence PDF (and the merchant receipt when captured).

   **First-visit gotcha (live-hit 2026-08-13):** a company that has never
   opened the supplier-invoice module in the UI gets Fortnox's one-time
   onboarding wizard ("Kom igång med leverantörsfakturor") instead of the
   invoice list. The invoices ARE there — API pushes and the Haven read-back
   are unaffected — but the list stays hidden until the wizard is clicked
   through. Every step is skippable (*Hoppa över*); no bank details or
   registration certificate are needed just to view invoices. Expect real
   customers to hit this on their first verification walk too.

3. **API, for on-call:** `GET /accounting/feed/status` (user-scoped)
   returns every sync row with `status`, `external_ref`, `error`, `attempts`.
   `GET /accounting/feed/verify/:paymentId` returns the live read-back
   (`registered` / `booked` / `voucher` / `cancelled`). Both are read-only.

## Troubleshooting: "my payment didn't sync"

Work the sync row's `status` on `/accounting` (or `reporting_feed_syncs`):

| Status | Meaning | Action |
| --- | --- | --- |
| `pushed` | Delivered. `error` column may carry a non-fatal **note** (e.g. "receipt attachment failed") — invoice exists, attachment degraded | Use *Check in Fortnox* for live state; reconnect Fortnox if the note names a scope error, then re-capture attachments is NOT automatic — the invoice stands |
| `failed` | Fortnox push failed; `error` carries the Fortnox message verbatim | Fix the named cause (often token/scope), press **Sync now** — failed rows are re-claimed and retried |
| `pending` | Claimed but in flight (or a crashed in-flight push) | Wait; a stuck pending row is not auto-recovered (deliberate — the claim IS the concurrency guard). If genuinely stuck, escalate rather than editing the row |
| `skipped` | A connector-level skip (`not_connected`, `no_sek_amount`, `not_outbound`) with the reason preserved in `error` (#1365 — previously mis-recorded as `pushed` with the reason dropped) | Fix the named cause (usually: connect Fortnox), then **Sync now** — skipped rows are re-claimed and retried exactly like failed ones |
| *(no row)* | The settle-time hook never ran (entitlement off, feature flag off) or the payment predates the feed | Check `GET /accounting/feed/status` base flags and `entitlementMode`/`entitled`; **Sync now** backfills once entitled |

Common causes, from live experience:

- **Token expired / not connected**: pushes skip with `not_connected`. The
  dashboard shows *Not connected* — reconnect via the Connect button.
- **Scope widened** (the `connectfile` lesson, 2026-07-16): connections
  consented before a scope was added still push invoices but fail file
  connections with Fortnox error `[2000663]` — the row is `pushed` with a
  degradation note. Fix: **Disconnect, then Connect** on `/accounting` to
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
`pending → pushed | failed | skipped` (failed AND skipped are re-claimable,
#1365; pushed is FINAL with ONE sanctioned exception — the verification-gated
reopen flips `pushed → failed` only after Fortnox itself confirms the invoice
no longer exists, so re-pushing cannot double-post). `external_ref` =
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
