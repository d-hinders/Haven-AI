---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/modules/accounting/**
  - packages/backend/src/routes/accounting-feed.ts
  - packages/backend/src/routes/accounting-connections.ts
  - packages/backend/src/infra/repositories/accounting-feed-syncs.ts
  - packages/backend/src/infra/repositories/accounting-connections.ts
  - packages/frontend/src/app/(authenticated)/accounting/page.tsx
  - packages/frontend/src/hooks/useAccountingFeed.ts
  - packages/frontend/src/hooks/useAccounting.ts
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
> Two names #2859 left behind — the `reporting_feed_syncs` table and the
> `reporting_feed` entitlement string — were renamed by #2860's migration to
> `accounting_feed_syncs` and `accounting_feed`. That same migration replaced
> `fortnox_connections` with the provider-generic `accounting_connections`
> (secrets encrypted at rest; see *Secrets at rest* below) and left the old
> table as `fortnox_connections_retired` for #2872 to drop after the product
> verification.

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
  ├─ entitlement gate: hosted + flag + user entitlement ('accounting_feed',
  │    or every account when HAVEN_ACCOUNTING_ENTITLEMENT_MODE=all — #2861)
  ├─ active destination: the accounting_connections row flagged is_active_destination
  │    names the provider; nothing settled before its feed_from is fed (#2862)
  ├─ claimSync(user, <provider>, payment) → accounting_feed_syncs row 'pending'
  │    (unique on (provider, payment_id, user_id) — the double-post guard)
  ├─ build AccountingEntry → ReportingTransaction (VAT/account fields STRIPPED)
  ├─ <provider connector>.pushTransaction — Fortnox today:
  │    ├─ token refresh if needed (generic oauth-flow; accounting_connections, secrets decrypted in-process)
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
  links to `/accounting`. The list endpoint joins `accounting_feed_syncs` by
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

Work the sync row's `status` on `/accounting` (or `accounting_feed_syncs`):

| Status | Meaning | Action |
| --- | --- | --- |
| `pushed` | Delivered. `error` column may carry a non-fatal **note** (e.g. "receipt attachment failed") — invoice exists, attachment degraded | Use *Check in Fortnox* for live state; reconnect Fortnox if the note names a scope error, then re-capture attachments is NOT automatic — the invoice stands |
| `failed` | Fortnox push failed; `error` carries the Fortnox message verbatim | Nothing, at first: the [retry sweep](#background-retry-sweep-2866) re-feeds it with backoff (1 min doubling to 1 h, 8 attempts). Fix the named cause (often token/scope) if it keeps failing; **Sync now** retries immediately |
| `failed` with `error` starting `exhausted:` | The sweep gave up — 8 attempts, the last reason follows the prefix | Fix the cause, then **Sync now** — the cap bounds the sweep, not the human; a manual sync re-claims the row |
| `pending` | Claimed but in flight (or a crashed in-flight push) | Wait; the sweep releases a `pending` row older than 15 min (the claim IS the concurrency guard, so nothing shorter) and re-feeds it. Do not edit the row |
| `skipped` | A connector-level skip (`not_connected`, `no_sek_amount`, `not_outbound`) with the reason preserved in `error` (#1365 — previously mis-recorded as `pushed` with the reason dropped), or `connection needs_reauthorisation: …` (#2863) | Fix the named cause (usually: connect Fortnox); the sweep retries skipped rows like failed ones — but NOT while the connection is `needs_reauthorisation` / `scope_missing`, which hold the row until the user re-consents. **Sync now** also re-claims them |
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

## Routes (#2862)

The connection surface is provider-generic: the provider is a path
parameter, the descriptor list is `GET /accounting/providers`, and nothing is
shaped after Fortnox except the dark legacy voucher push. The feed actions
keep their feed-scoped home — they act on the ACTIVE destination, of which
there is exactly one per user.

| route | auth | what it does |
|---|---|---|
| `GET /accounting/providers` | session | the registry: Fortnox `live`; Accounted, Light, Igdrasil `coming_soon`; `configured` per deployment |
| `GET /accounting/connections` | session | the caller's connections — metadata only, never secrets |
| `POST /accounting/connections/:provider/connect-url` | session | consent URL for a live OAuth2 provider; signed, purpose-scoped, provider-bound, **single-use** `state` (10 min) |
| `GET /accounting/connections/:provider/callback` | the `state` | public OAuth callback; consumes the state's `jti` before the code exchange; always redirects to `/accounting?provider=<id>&connect=connected\|denied\|error` |
| `POST /accounting/connections/:provider/api-key` | session | validate an API key at the provider, store encrypted (no live api_key provider today → 409) |
| `DELETE /accounting/connections/:provider` | session | disconnect: secrets cleared, row kept as `disconnected`; revoke at the provider first when the descriptor declares it (Fortnox does, #2863 — `POST /oauth-v1/revoke` with the refresh token; a failed revoke still disconnects locally) |
| `POST /accounting/connections/:provider/activate` | session | make it the destination; **`feed_from = now`** — nothing settled before the switch is fed |
| `GET /accounting/feed/status` | session | availability, `connected` (= an active destination exists), recent syncs |
| `POST /accounting/feed/sync` | session + entitlement | backfill/retry for the active destination, honouring `feed_from` |
| `GET /accounting/feed/verify/:paymentId` | session + entitlement | read-back through the active connection's connector |
| `POST /accounting/feed/reopen/:paymentId` | session + entitlement | verification-gated reopen on the active connection's provider |
| `POST /accounting/fortnox/push` | session | LEGACY asserting voucher push; 410 unless `HAVEN_LEGACY_BOOKKEEPING_ENABLED` |

**Operator step when this deploys** (the callback path moved): the Fortnox
app's registered redirect URI and the backend's `FORTNOX_REDIRECT_URI` must
both point at `<backend>/accounting/connections/fortnox/callback`; a consent
that returns to the old `/accounting/fortnox/callback` 404s and the user sees
no connection. Existing connections are unaffected — the change is the
consent round-trip, not the stored grant.

**Switching destination and `feed_from`.** Activating a second provider
stamps `feed_from` in the same transaction as the active flag, and a FIRST
connect that takes the flag because nothing else held it (disconnect A, then
connect B) stamps it too — a connect that becomes the destination is an
activation. A reconnect of an existing row keeps the floor it had, and a
pre-#2862 Fortnox row migrated with no floor keeps its NULL (it fed
everything). The backfill selection and the settlement hook both skip
anything settled before the floor, so a switch never re-feeds history into
the new ledger. On-call read:
`SELECT provider, status, is_active_destination, feed_from FROM
accounting_connections WHERE user_id = '<uuid>'`. A user who wants history in
the new ledger takes the backfill (#2867), which passes an explicit earlier
date.

**`scope_missing`.** (For `needs_reauthorisation`, see *Token lifecycle*
below.) A pushed invoice whose attachment step failed with
Fortnox's scope error (`[2000663]`) leaves the sync row `pushed` with the
note and flips the CONNECTION to `scope_missing` — the feed then has no
active destination until the user reconnects (Disconnect, then Connect on
`/accounting`): a user with any `accounting_connections` row is row-backed,
and without an active `connected` row the orchestrator feeds nothing — it
never falls back to asking a connector whether it "has secrets". The invoice
stands; nothing is re-pushed.

## Token lifecycle (#2863)

Fortnox access tokens live one hour; refresh tokens are **single-use and
rotate on every refresh** (45-day life). Two things follow, both in the
generic `oauth-flow.ts` so every OAuth2 provider inherits them:

- **One refresh at a time per connection.** The refresh runs under a row
  lock (`SELECT … FOR UPDATE` on the `accounting_connections` row, inside a
  transaction that spans the provider call). A second caller — the
  settlement hook racing a "Sync now" click — waits, re-reads the row the
  first caller already rotated, and uses that token with no provider call.
  The rotated pair is committed before either caller sees the new access
  token, so a crash between "Fortnox rotated" and "we stored it" cannot leave
  a dead token in the row for a caller that already proceeded.
- **A refused refresh is not retried.** `invalid_grant` (or a 400/403 with
  no readable error code) means the grant is dead (expired after 45 idle
  days, revoked in Fortnox, or burned by a refresh Haven never got to
  store). The row flips to **`needs_reauthorisation`**
  with `status_reason = refresh refused: fortnox token request failed
  (HTTP 400): invalid_grant` (the provider's error code only — never token
  material), the connection stays the active destination, and every later
  token request is refused BEFORE any provider call. Everything else leaves
  the row `connected` with the refresh token unconsumed, and the next sync
  simply tries again: a 429 (Fortnox's rate limit: 25 calls / 5 s, no
  `Retry-After`), a 408, a 5xx, a network failure or the 15 s timeout — and
  a **401 `invalid_client`** (or `invalid_request`, `unauthorized_client`,
  `unsupported_grant_type`, `invalid_scope`), which is about HAVEN's client
  credentials, not the user's grant. **On-call read for a burst of 401s
  in the log:** `FORTNOX_CLIENT_ID`/`FORTNOX_CLIENT_SECRET` on the backend
  no longer match the Fortnox app (rotated secret, wrong environment). Fix
  the variables; nothing was flipped, so no user has to reconnect.

**On-call read for `needs_reauthorisation`.**
`SELECT provider, status, status_reason, is_active_destination,
token_expires_at FROM accounting_connections WHERE user_id = '<uuid>'` —
and `SELECT payment_id, status, error FROM accounting_feed_syncs WHERE
user_id = '<uuid>' AND status = 'skipped'`: while the grant is dead each
sync records the payment as `skipped` with
`connection needs_reauthorisation: …` (the state is the first thing in the
reason, so a grep finds it). Nothing is pushed, nothing is refreshed. The
fix is the user's: Disconnect, then Connect on `/accounting` — a re-consent
replaces the secrets, sets the row back to `connected`, and the skipped rows
are re-claimable (#1365), so the next sync — or the retry sweep's next tick
(#2866), which holds those rows back only while the connection is not
`connected` — feeds them. There is no operator
action that revives a dead grant; do not hand-edit `status` — the stored
refresh token is dead at Fortnox regardless of what the row says.

**Disconnect revokes at Fortnox.** `DELETE /accounting/connections/fortnox`
posts the refresh token to `POST /oauth-v1/revoke`
(`token_type_hint=refresh_token`, Basic client auth) BEFORE clearing the
stored secrets, so a grant Haven no longer holds is one Fortnox no longer
honours either. A failed revoke (Fortnox down, token already dead) still
clears locally — `status_reason` is `user disconnected` instead of
`user disconnected (grant revoked at provider)`, the route still answers
204, and the backend logs one warning line carrying the failure's error
NAME only (`accounting provider revoke failed on disconnect`). The user can
always also remove the integration inside Fortnox.

## Secrets at rest (#2860)

Provider credentials — today the user's Fortnox OAuth token pair — live in
`accounting_connections.secrets_ciphertext` as an AES-256-GCM blob, with the
key in `HAVEN_SECRETS_KEY` (32 bytes, base64; `openssl rand -base64 32`) and
**never** in the database. `secrets_key_version` says how a row is stored:

| version | meaning | needs the key to read? |
|---|---|---|
| `0` | plaintext JSON — a row migration 080 copied as-is | no |
| `1` | encrypted under the current key | yes |

- **Rows are encrypted at boot, not by the migration.** The migration reads no
  environment (it runs on every replica, prod included, and in CI). On the
  first boot that has the key, `reencryptPlaintextSecretsAtBoot` rewrites
  every version-0 row; it is idempotent, per-row on a bad blob, and a
  compare-and-swap on the version so it can never overwrite a token a serving
  replica rotated in the meantime. Without the key it logs one line and
  touches nothing.
- **Set the key on dev BEFORE this deploys, or right after — but before the
  next token expiry.** Without a key a NEW connection is refused, and a token
  refresh is refused *before* the provider is called, so the stored refresh
  token is never consumed. That refusal is deliberate: the alternative was
  storing a fresh OAuth grant in plaintext. Fortnox access tokens live one
  hour, so a dev backend without the key will start refusing refreshes within
  an hour of the first settlement after deploy. Prod holds zero rows and gets
  its key in #2876.
- **On-call check:** `SELECT provider, status, secrets_key_version FROM
  accounting_connections WHERE user_id = '<uuid>'`. A `0` after the key has
  been set for more than one boot means the re-encrypt job logged a failure
  for that row — search the boot log for `could not re-encrypt secrets for
  connection=`.
- A rollback of 080 (`down()`) restores `fortnox_connections_retired`, whose
  tokens are whatever they were AT migration time; every refresh since has
  rotated them. Rollback is a schema operation, not a credential restore.

## Background retry sweep (#2866)

Failed pushes are retried by three paths: the next settlement (fire-and-forget),
**Sync now**, and — since #2866 — a background sweep on the same in-process
interval pattern as the delegate monitor (`startRetrySweep` in
`modules/accounting/retry-sweep.ts`, registered in `src/index.ts`, `unref()`ed,
leader-locked on `LEADER_LOCK_KEYS.accountingRetrySweep`). **Cadence:**
`HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS`, default 5 min; the first tick runs
at boot. **Inert** when `HAVEN_ACCOUNTING_ENABLED` is off — no interval is
registered and nothing is queried.

Each tick selects, in ONE query (`LIST_DUE_RETRY_SYNCS_SQL`, batch 200), the
`failed` / `skipped` / stale-`pending` rows whose connection is `connected`
and the active destination, and whose backoff has elapsed. Backoff is derived
from the columns the ledger already has — no schema change:

| `attempts` | waits after the last touch | cumulative |
|---|---|---|
| 1 | 1 min | 1 min |
| 2 | 2 min | 3 min |
| 3 | 4 min | 7 min |
| 4 | 8 min | 15 min |
| 5 | 16 min | 31 min |
| 6 | 32 min | 63 min |
| 7 | 60 min (cap) | ~2 h |
| 8 | **exhausted** — never selected again | |

`backoff(n) = min(1 min · 2^(n−1), 1 h)`; the row is due when
`updated_at + backoff(attempts) <= now`. A `pending` row is due once it is
older than 15 min (`STALE_PENDING_CLAIM_MS`): the sweep flips it to `failed`
without touching `attempts` (`releaseStalePending`) and the normal re-claim
takes it. That release is safe only because a live push cannot be that old:
every Fortnox API call carries an abort timeout (15 s per JSON request, 60 s
for the inbox upload) and a push is at most six sequential requests. The
sweep's own terminal write (`exhausted:`) is guarded — it never touches a row
a manual "Sync now" re-claimed or pushed in the meantime. Each due row goes through the same `feedSettledPayment` the
settlement hook uses, so the dedup ledger, the feed-from floor, the FX gate
and the degraded-destination skip all apply.

**Terminal reason.** The attempt that reaches 8 leaves the row `failed` with
`error = exhausted: <last reason>` — the string the dashboard keys on.
`GET /accounting/feed/status` carries `counts: { pending, failed, exhausted }`
over ALL the user's rows (`exhausted` = `failed` at the cap, the same
predicate the sweep uses). **Sync now** still re-claims an exhausted row: the
cap bounds the sweep, not the human.

**State-skipped rows wait for the cause.** The selection joins the
connection: a row `skipped` with `connection needs_reauthorisation: …`, or
any row behind a `scope_missing` / `disconnected` connection, is not touched
until the row is `connected` again (a re-consent flips it). FX-not-ready rows
are selected normally — the orchestrator no-ops before claiming, so no
attempt is consumed while the FX is missing.

**Rate limits.** Fortnox allows 25 requests / 5 s per client-id + tenant and
answers 429 **without** `Retry-After`. The sweep processes **one connection at
a time**, and within a connection paces pushes under a fixed floor of 25 / 5 s
(`RequestPacer`, budgeting 8 requests per push — supplier lookup/create,
invoice, attachment upload + connect, merchant receipts — so three pushes per
window). On a 429 the whole connection is deferred to the next tick: the row
that hit it is recorded as failed (its attempt was real), every remaining row
of that connection is left untouched — no claim, no `attempts + 1`. A
`Retry-After` is honoured as a courtesy when a provider sends one, never
depended on, and clamped to the 1 h backoff cap so a bogus header cannot
park a connection until the next restart. `HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS`
has a 10 s floor (a negative value would otherwise spin the interval).

**On-call read.** One structured line per tick, `Accounting retry sweep`
(`info` when anything was considered, `debug` when idle):
`considered` / `pushed` / `failed` / `deferred` / `exhausted` / `skipped` /
`connections` / `rateLimited`. A tick with `rateLimited > 0` on every run
means another integration is spending the tenant's Fortnox budget — the
sweep's own pacing cannot cause a 429. `exhausted > 0` is a row to look at:
`SELECT payment_id, attempts, error FROM accounting_feed_syncs WHERE user_id =
'<uuid>' AND status = 'failed' AND attempts >= 8` — the reason after
`exhausted:` is the last Fortnox message. `Accounting retry sweep failed` is
the leader-election or query layer, not a push. A tick that is still running
when the next fires is skipped in-process (no overlap on one replica; the
leader lock covers replicas).

## Schema for on-call: `accounting_feed_syncs`

One row per (user, provider, payment). `status`:
`pending → pushed | failed | skipped` (failed AND skipped are re-claimable,
#1365; pushed is FINAL with ONE sanctioned exception — the verification-gated
reopen flips `pushed → failed` only after Fortnox itself confirms the invoice
no longer exists, so re-pushing cannot double-post). `external_ref` =
`fortnox:supplierinvoice:<GivenNumber>`. `error` doubles as the non-fatal
degradation note on pushed rows (#498 contract) and carries the `exhausted:`
prefix once the retry sweep has given up (#2866). `attempts` increments per
claim; the sweep stops at 8, backoff is derived from `attempts` and
`updated_at`. Never hand-edit status: flipping `pushed` back re-posts the
invoice.

## Boundaries (what this feed will never do)

- **Never asserts**: no voucher rows, no BAS account, no VAT — structurally
  banned (`assertNonAsserting`, test-locked). The `suggestedAccount` rides as
  free text in `YourReference` only.
- **Never books**: the read-back verification (#1362) is the only read, and it
  is strictly read-only — Haven cannot book, cancel, or modify the invoice.
- **Never blocks money**: the settle-time hook is fire-and-forget; a Fortnox
  outage delays reporting, never settlement.
