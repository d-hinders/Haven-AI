---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/modules/accounting/**
  - packages/backend/src/routes/accounting-feed.ts
  - packages/backend/src/routes/accounting-connections.ts
  - packages/backend/src/routes/health.ts
  - packages/backend/src/middleware/accountingFeed.ts
  - packages/backend/src/infra/secrets.ts
  - packages/backend/src/infra/repositories/accounting-feed-syncs.ts
  - packages/backend/src/infra/repositories/accounting-connections.ts
  - packages/backend/src/db/migrations/080_accounting_connections.ts
  - packages/backend/src/db/migrations/081_drop_fortnox_connections_retired.ts
  - packages/backend/src/db/migrations/082_evidence_ledger_fx_rates.ts
  - packages/backend/src/domain/ledger-currency.ts
  - packages/backend/src/infra/prices.ts
  - packages/backend/src/infra/fiat-values.ts
  - packages/backend/src/infra/repositories/machine-payments.ts
  - packages/backend/src/config.ts
  - packages/backend/src/index.ts
  - packages/backend/src/modules/agents/entitlements.ts
  - packages/backend/src/modules/transactions/accounting.ts
  - packages/backend/src/modules/x402/settlement-sweeper.ts
  - packages/frontend/src/app/(authenticated)/accounting/page.tsx
  - packages/frontend/src/app/(authenticated)/settings/SettingsClient.tsx
  - packages/frontend/src/hooks/useAccountingFeed.ts
  - packages/frontend/src/hooks/useAccounting.ts
  - packages/frontend/src/components/accounting/ConnectionsCard.tsx
  - packages/frontend/src/components/accounting/ConnectionRow.tsx
  - packages/frontend/src/components/accounting/ConnectionSettings.tsx
  - packages/frontend/src/components/accounting/BackfillDialog.tsx
last-verified: "2026-09-12"
---

# Accounting feed — operations runbook

How a settled agent payment becomes an unbooked source document in the user's
accounting platform, how to tell that it did, and what to do when it did not.
The feed is **provider-generic** (epic #2858): the connection model, routes,
retry sweep, secrets and states below hold for every provider; Fortnox is the
one live connector today and has its own section at the end. The feed is
**non-asserting** by principle (#491): Haven delivers the payment and its
evidence as an unbooked object, and the accountant codes, books and files.
Haven never posts voucher rows, accounts or VAT, never blocks a settlement, and
never moves money through it.

The product description — what a user sees and does — is
[`docs/product/accounting-connections.md`](../product/accounting-connections.md).
Adding a provider is
[`packages/backend/src/modules/accounting/README.md`](../../packages/backend/src/modules/accounting/README.md).
Design history: `docs/research/accounting-data-feed.md` and
`docs/research/fortnox-non-asserting-feed.md` (the #494 spike that proved the
mechanism live on 2026-07-16). The owner decisions of 2026-09-11 are in the
[decision log](../archive/decision-log.md).

## Configuration

| Variable | Meaning | dev | prod |
|---|---|---|---|
| `HAVEN_HOSTED` | The feed is a hosted add-on; nothing below matters on a self-host | `true` | `true` |
| `HAVEN_ACCOUNTING_ENABLED` | Kill-switch. Off: `GET /accounting/feed/status` answers `available: false`, Sync now / verify / reopen 404, the settlement hook returns before any query, the retry sweep registers no interval (the connection routes stay reachable behind the session — a connection can be made, nothing is fed). The pre-#2859 name `HAVEN_REPORTING_FEED_ENABLED` is still honoured with one boot warning; the new name wins whenever it is *set*, including `false` — so prod is off only while BOTH are unset, or the alias is `false` (the prod variable list still carried `HAVEN_REPORTING_FEED_ENABLED` at the 2026-09-04 owner-reported reading in `package-dev-channel.md`; a stale `=true` there turns the feed ON) | `true` | unset — AND `HAVEN_REPORTING_FEED_ENABLED` unset or `false` (Coming soon) |
| `HAVEN_ACCOUNTING_ENTITLEMENT_MODE` | Who passes the entitlement gate once the feed is on (#2861): `granted` (default, also when unset) — accounts holding an `account_entitlements` row for `accounting_feed`; `all` — every account, no row read or written. **Any other value refuses the boot** naming both modes | `all` | unset |
| `HAVEN_SECRETS_KEY` | 32 bytes, base64 (`openssl rand -base64 32`). Encrypts provider secrets at rest (#2860). Without it a NEW connection and a token refresh are refused before the provider is called; rows are never written in plaintext. See *Secrets at rest* | set | unset until #2876 (zero rows) |
| `HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS` | Retry-sweep cadence (#2866). Default 300 000 (5 min); floor 10 000; unset, empty, 0 or NaN take the default | default | default |
| `HAVEN_OPS_TOKEN` | Gates `GET /health/ops`, where the two accounting counters live (#2872). Unset → the route is 404 | set | set |
| `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET`, `FORTNOX_REDIRECT_URI` | The Fortnox app registration. All three, or Fortnox is `configured: false` in `GET /accounting/providers` and cannot be connected. The redirect URI is `<backend>/accounting/connections/fortnox/callback` — here AND in the Fortnox developer portal (a consent returning to the pre-#2862 `/accounting/fortnox/callback` 404s and the user sees no connection) | set | unset |

Availability for one account is `hosted && enabled && entitled`;
`GET /accounting/feed/status` reports `hosted`, `flagEnabled`, `entitled`,
`entitlementMode`, `liveSyncReady` (a live connector is registered) and
`available`, so on-call reads from one response why an account has no feed.
The pre-#2861 recipe of granting entitlement by hand is retired; the table
stays for paid tiers later.

## The flow, end to end

```
Purchase settles on-chain (x402 funding confirmation, erc7710 settlement, MPP receipt)
  │
  ▼
machine_payment_evidence row written (the book-time capture when FX is ready:
  │  the SEK amount AND a rate per supported ledger currency, frozen together — #2877)
  │
  ▼
feedSettledPaymentBestEffort()          ← fire-and-forget: NEVER blocks settlement
  ├─ availability: hosted + flag + entitlement (mode `all` or a row)
  ├─ active destination: the accounting_connections row flagged
  │    is_active_destination, in status `connected`, names the provider
  │    (a dead-grant row — needs_reauthorisation — is still THE destination:
  │    each payment is recorded `skipped` naming the state; a scope_missing
  │    or disconnected row is no destination: nothing is recorded)
  ├─ auto_feed = false on that row → stop here (manual only, #2867)
  ├─ feed-from floor: nothing settled before feed_from is fed (#2862)
  ├─ FX not ready (no amount in the DESTINATION's booking currency — #2877; for
  │    a SEK ledger this is the same amount_sek check as before) → stop here,
  │    no claim; see 'Ledger currency' for when a retry can ever succeed
  ├─ claimSync(user, provider, payment) → accounting_feed_syncs row `pending`
  │    (UNIQUE (provider, payment_id, user_id) — the double-post guard)
  ├─ build the non-asserting FeedTransaction (account demoted to a hint,
  │    VAT structurally absent; the connection's suggested_account rides as
  │    the hint when no per-merchant override exists)
  ├─ <connector>.pushTransaction — Fortnox today: token refresh under the row
  │    lock if needed, find-or-create supplier by name, POST an UNATTESTED
  │    supplier invoice (ExternalInvoiceNumber = HAVEN-<paymentId>), attach
  │    the payment-evidence PDF, attach the merchant receipt when captured
  └─ markPushed(external_ref)  |  markSkipped(reason)  |  markFailed(error)
       └─ a push-time finding about the GRANT (scope) also flips the
          connection's status and emits accounting.connection.needs_attention
```

Three things feed a payment: the settlement hook above, **Sync now**
(`POST /accounting/feed/sync`, manual, bounded to 200 payments per press,
resumable through the ledger) and the background retry sweep. All three go
through the same `feedSettledPayment`, so the ledger, the floor, the FX gate
and the degraded-destination rules apply identically.

**A settled payment that never reached the feed at all** is a settlement-side
question, not an accounting one — the feed needs a `machine_payment_evidence`
row, and that row is written when an intent reaches `confirmed`. The erc7710
paths that can leave a settled payment without one, the leader-gated sweep
that completes them and its 24-hour recovery horizon are documented where
that code is:
[`04-x402-payment-sequence.md`](../architecture/04-x402-payment-sequence.md)
§ *Completing an erc7710 settlement* and § *Completing a settlement nobody
reported*. If `/accounting` has **no row** for a payment the user can see on
Transactions, start there; if it has a row, stay here.

**Settlement-side reasons and fixes** (`settlement-sweeper.ts`, verified at
this head). Three `warn` lines can name such a payment; only the first carries
a `remedy` field, the other two carry a `reason`:

| line | `reason` | what it means | fix |
|---|---|---|---|
| `Settled erc7710 payment is past its settlement window and the sweep cannot attribute it` (`paymentId`, `agentId`, `chainId`, `delegationHash`, `reason`, `remedy`) | `no_manager_log` | the route that settled it emitted no decodable DelegationManager log, so the sweep will not attribute by shape | the `remedy` says it: have the agent re-report the merchant's settlement transaction hash to `POST /machine-payments/evidence` with its own credential — that path runs the same verifier without `requireDelegationBound` and is not horizon-bound |
| same line | `ambiguous_redemption` | two different transactions redeemed the same settlement child (look-alike payments authorized before #2094) — a fact Haven will not resolve by choosing | a human decides which payment the settlement belongs to first; then the same re-report |
| `Settlement sweep confirmed an erc7710 payment but no evidence row landed` (`paymentId`, `agentId`, `txHash`, `chainId`, `outcome`, `reason`) | `missing_resource_url`, `intent_not_found`, `write_threw` | the intent flipped `submitted → confirmed` but the `machine_payment_evidence` write failed; the tick counts it as `evidenceFailed`, not `evidencePushed` | nothing, at first: the recovery pass re-derives the hole from state (confirmed erc7710 intent, no evidence row) and retries it every tick — `evidenceRecovered` counts the ones that close |
| `Settled erc7710 payment is confirmed with no evidence row and the row could not be written` (same fields, from the recovery pass, every attempt it cannot satisfy) | `missing_resource_url` | the one non-transient cause: `machine_payment_evidence.resource_url` is NOT NULL and the intent's `payment_resource_url` and `x402_resource_url` are both null, so the row can never be written | set the intent's resource URL to the merchant resource the payment paid for. The recovery pass backs a repeatedly failing payment off exponentially from the 2-minute tick to a ceiling of **1 h** (`SCAN_BACKOFF_MAX_MS`), so a long-stuck payment may wait up to an hour after the fix; the backoff is in-memory, so **restarting the leader clears it**. After **24 h** (`SWEEP_RECOVERY_HORIZON_SECONDS`) the payment leaves the recovery horizon and needs a manual evidence write — the same `POST /machine-payments/evidence` re-report |
| same line | `intent_not_found`, `write_threw` | transient (a database blip, a lost connection) | the next tick closes it; if it repeats, read `err` on the neighbouring `Settlement sweep evidence recovery failed` line |

## Where it shows

- **Settings → Accounting** (#2868, PR #2903): one row per provider from
  `GET /accounting/providers`, the connection's state as a chip, and the ONE
  action that resolves it — *Connect* (no row / `disconnected`), *Settings* +
  *Disconnect* (`connected`), *Reconnect* + *Disconnect* (the three
  needs-attention states). The inline settings form is `PATCH …/settings`;
  the backfill dialog on the OAuth return is `POST …/backfill`; Disconnect
  confirms first. The `/accounting` page no longer carries connect
  controls; it points at Settings.
- **`/accounting`** — every sync row, **Sync now**, **Check in Fortnox** and
  the re-open action; the callback redirect lands here
  (`?provider=<id>&connect=connected|denied|error[&reason=unsupported_currency]`).
  #2869 reworks the page, adds the sidebar badge for a connection needing
  attention and the prod *Coming soon* state — not merged; not described here.
- **Where the user manages it (#2868, PR #2903)** — the *Accounting*
  card on `/settings` (`SettingsClient.tsx` →
  `components/accounting/ConnectionsCard.tsx`, with `ConnectionRow`,
  `ConnectionSettings` and `BackfillDialog`): one row per provider with
  Connect / Reconnect / Disconnect, the per-connection settings and the
  backfill choice on connect. The product doc describes the states as the
  user sees them; those four component files are covered here once #2903
  merges (they do not exist on this branch, so they are not in `covers:` yet).
- **`/transactions`** (#2870) — a badge per fed row: *In Fortnox* (`pushed`),
  *Feeding…* (`pending`), *Not fed* (`failed` / `skipped`, the `error` on
  hover), linking to `/accounting`. Emitted only when the account is
  entitled, has an ACTIVE destination in `connected` (`hasActiveConnection`
  — a destination in `needs_reauthorisation` / `scope_missing` hides every
  badge on the page, including *In Fortnox* on rows already delivered) AND a
  sync row exists — no badge means "not entitled / not connected / connection
  degraded / before `feed_from`", never "failed".

## Routes

Session-authenticated unless noted. `sync`, `verify` and `reopen` 404 when
the feed is unavailable for the caller (`middleware/accountingFeed.ts` — 404,
not 403, so an unentitled account learns nothing); `status` answers
`available: false` instead; the connection routes are session-only and do not
consult the flag.

| route | what it does |
|---|---|
| `GET /accounting/providers` | the registry: Fortnox `live`; Accounted, Light, Igdrasil `coming_soon`; `configured` per deployment |
| `GET /accounting/connections` | the caller's connections — metadata only, never secrets: `status`, `statusReason`, `missingScopes`, `externalCompanyId` / `externalCompanyName`, `baseCurrency`, `feedFrom`, `isActiveDestination`, `settings: { suggestedAccount, autoFeed }`, `lastPushAt` |
| `POST /accounting/connections/:provider/connect-url` | consent URL for a live OAuth2 provider: signed, purpose-scoped, provider-bound, single-use `state` (10 min). Also the **re-consent** path — issued for an existing row whatever its status |
| `GET /accounting/connections/:provider/callback` | public, authenticated by the `state` (its `jti` is consumed before the code exchange). Reads the company (`getCompanyInfo`), refuses a ledger outside the supported currencies before storing anything (#2877), UPSERTs the row: on an existing row it replaces secrets, `granted_scope`, `status → connected`, and keeps `settings`, `feed_from`, the active flag and the sync history. A grant narrower than `requiredScopes` is stored as `scope_missing`. Redirects to `/accounting?provider=…&connect=…` |
| `POST /accounting/connections/:provider/api-key` | validate a key at the provider, store encrypted (no live `api_key` provider today → 409); a ledger outside the supported currencies → 409 `UNSUPPORTED_BASE_CURRENCY` (#2877) |
| `DELETE /accounting/connections/:provider` | disconnect: revoke at the provider first when the descriptor declares `revoke` (Fortnox does), then secrets cleared, row kept as `disconnected`, active flag dropped; a failed revoke still disconnects locally (one `warn` line, error NAME only: `accounting provider revoke failed on disconnect`) |
| `POST /accounting/connections/:provider/activate` | make it the destination; stamps **`feed_from = now`** in the same transaction |
| `POST /accounting/connections/:provider/backfill` | `{ since }`: moves `feed_from` **earlier only** (400 `SINCE_INVALID` / `SINCE_NOT_EARLIER`, 409 `NOT_ACTIVE`), records `settings.backfill`, runs one bounded sync; answers `{ feedFrom, fed }` |
| `PATCH /accounting/connections/:provider/settings` | exactly `suggested_account` and `auto_feed`; anything else 400 `INVALID_SETTING` naming `key`; a SQL-side JSONB merge |
| `GET /accounting/feed/status` | availability flags, `connected` (= an active `connected` destination exists), `companyName`, `missingScopes` (of the destination row whatever its status), `counts { pending, failed, exhausted }` over ALL the user's rows, `syncs` (recent rows) |
| `POST /accounting/feed/sync` | Sync now: backfill + retry for the active destination, honouring `feed_from`; manual, so it pushes for an `auto_feed = false` connection too |
| `GET /accounting/feed/verify/:paymentId` | live read-back through the active connection's connector: `registered` / `booked` (+ voucher) / `cancelled` / `missing` |
| `POST /accounting/feed/reopen/:paymentId` | verification-gated reopen: flips `pushed → failed` ONLY when the provider confirms the record is gone; 409 otherwise, 409 `previous_company` for a row pushed under a previous company |
| `POST /accounting/fortnox/push` | LEGACY asserting voucher push (`accounting/legacy/`); 410 unless `HAVEN_LEGACY_BOOKKEEPING_ENABLED` |

## Connection states

`accounting_connections.status`, one row per (user, provider), at most one row
per user flagged `is_active_destination` (a partial unique index, not a
convention). `status_reason` says why, bounded to 1000 chars; for
`scope_missing` it has the parseable shape `missing scopes: <a>, <b> — <detail>`,
which is what `missingScopes` on the API reads.

| status | how a row gets here | what the feed does meanwhile | the way out |
|---|---|---|---|
| `connected` | connect / reconnect callback; a validated API key | feeds | — |
| `needs_reauthorisation` | the token endpoint refused the refresh with a verdict on the GRANT: `invalid_grant`; a 400/403 with no readable code; or a 400/403 carrying any code that is NOT one of the client-side ones (`isGrantRefusal`, `oauth-flow.ts`). NOT on 401 / `invalid_client` and the other client-side codes — those are Haven's credentials — and not on 429 / 408 / 5xx / network, which leave the row untouched with the refresh token unconsumed | still the destination; every payment is recorded `skipped` with `connection needs_reauthorisation: <reason>`; nothing is refreshed, nothing pushed; the sweep leaves its rows alone | the user's **Reconnect** (the same connect-url + callback on the same row); then the skipped rows are re-claimed by the sweep or Sync now |
| `scope_missing` | (1) at the callback, the echoed scope string is short of `requiredScopes`; (2) at connect, the company read was refused for scope; (3) PRE-push, the create call itself was refused for scope — the sync row is `skipped` (`scope refused before the invoice was created: …`), nothing exists at the provider; (4) POST-push, the attachment step was refused — the sync row stays **`pushed`** with the note, never re-pushed | no destination: no new rows, `syncUser` feeds nothing, the sweep's `c.status = 'connected'` leaves its rows alone | **Reconnect**; the callback UPDATEs the row and keeps settings, floor, flag and history. If it comes straight back `scope_missing`: the provider app registration lacks that scope (Fortnox: the developer-portal permissions must include every entry of `FORTNOX_SCOPE`) |
| `revoked_at_provider` | reserved for a provider that reports a revocation to Haven (Fortnox has a consent-revoked webhook; Haven does not receive it). **No code path sets it today**; a revocation inside Fortnox surfaces as `needs_reauthorisation` at the next refresh | as `needs_reauthorisation` | Reconnect |
| `disconnected` | the user's Disconnect; secrets NULL, `secrets_key_version = 0`, flag dropped, `status_reason = user disconnected [(grant revoked at provider)]` | nothing; history kept | **Connect** (the same row is reused; settings survive) |

A `connected` row with a non-empty `missingScopes` is a grant that predates a
scope widening and has not been asked for the new scope yet — it degrades at
the first call that needs it. The three middle states emit
`accounting.connection.needs_attention` when entered (below).

**On-call read, per user:**

```sql
SELECT provider, status, status_reason, is_active_destination, feed_from,
       granted_scope, external_company_id, external_company_name,
       secrets_key_version, token_expires_at, settings
  FROM accounting_connections WHERE user_id = '<uuid>';
```

Do not hand-edit `status`: a dead grant is dead at the provider whatever the
row says, and a scope the grant lacks is added only by a new consent. The only
operator-side causes of a state are a wrong app registration and rotated
client credentials (Fortnox section).

## Ledger currency (#2877)

**Which currencies feed.** `SEK`, `EUR`, `USD`, `DKK`, `NOK` and `GBP` —
`SUPPORTED_LEDGER_CURRENCIES` in `packages/backend/src/domain/ledger-currency.ts`.
It lives there because `infra/prices.ts` quotes exactly those currencies against
the token: one list is what keeps "accepted at connect" and "a rate the feed can
use" the same set. A company booking outside it is refused **at connect**, before
any secret is stored — 409 `UNSUPPORTED_BASE_CURRENCY`, or the OAuth callback's
`reason=unsupported_currency`. A provider that cannot say (`base_currency` null)
passes and books in SEK, the default.

> **No production connection is non-SEK today.** Fortnox is the only `live`
> provider and its `getCompanyInfo` reports `SEK` by construction. The machinery
> below ships ahead of its first user — the `coming_soon` providers.

**What is pushed, and when the rate was taken.** The record carries the amount in
the connection's `base_currency`, converted with the rate captured **at
settlement** and frozen there — never a rate looked up when the push happens.
`getBookTimeCapture` (`infra/fiat-values.ts`) takes ONE price read and produces
both the SEK value and a rate per supported currency, written to
`machine_payment_evidence.fx_rates` (JSONB, migration 082) beside the SEK
columns. `fx_source` and `fx_at` keep their meaning for every currency in the map.

**The capture freezes as one record.** `amount_sek`, `fx_rate_sek`, `fx_source`,
`fx_rates` and `fx_at` are written only by the write that finds the row holding
**no capture at all**. That is stricter than the per-column `COALESCE` these
columns used before, and deliberately: `recordMachinePaymentEvidenceBase` also
runs from the proof-attach path weeks after settlement and re-reads prices, and a
per-column fill would have put that day's rate beside an `fx_at` still saying
settlement — a feed-time rate wearing a book-time label.

**Three shapes on-call will see, and only one of them recovers:**

| shape | fed? | recovers? |
|---|---|---|
| Whole capture failed (`fx_at` NULL — a pricing outage at settlement) | no | **yes** — the next write captures everything at once |
| Captured, but not the destination's currency | no, for that ledger | **never** — the missing rate is not knowable after the fact |
| Captured, but not SEK | yes, to a ledger whose currency IS in the map | SEK never recovers; the other currencies are unaffected |

The second and third are permanent by design: no claim row, no sync status, no
operator action, nothing to wait for. Feeding a SEK figure into a non-SEK ledger
would be a wrong number wearing the right label, so it is not done.

**"FX-ready" means a capture in either form** — `amount_sek` *or* a rate map —
in `LIST_UNPUSHED_PAYMENT_IDS_SQL`, which is the only path by which a
never-fed payment reaches a connector. A zero amount is fed (the SEK path
pushes a zero); negative or unparseable stays not-ready.

**Figures are fixed-scale**: four decimals, `amount_sek`'s own scale since
migration 026, so a computed amount has the same shape as a stored one and no
float tail or exponent notation reaches a supplier invoice.

**A USD ledger records the quoted rate, not an assumed 1:1.** A USDC payment into
a USD-booking company carries the rate the source actually quoted, with its
provenance. Haven asserts no parity between a stablecoin and the currency it is
named after; the rate is factual provenance on an unattested document.

## Sync statuses

`accounting_feed_syncs`, one row per (user, provider, payment):
`pending → pushed | failed | skipped`. `failed` and `skipped` are re-claimable
(#1365); `pushed` is FINAL with one sanctioned exception, the verification-gated
reopen. `error` carries the failure, the skip reason, the non-fatal note on a
pushed row (#498), or the `exhausted:` prefix once the sweep has given up.
`attempts` increments per claim.

| status | meaning | action |
|---|---|---|
| `pushed` | delivered; `external_ref` names the record (`fortnox:supplierinvoice:<GivenNumber>`). `error` may carry a **note** (e.g. `receipt attachment failed: …`) — the record exists, the attachment degraded | *Check in Fortnox* for live state. A scope note means the connection is `scope_missing` — the user reconnects; the record is NEVER re-pushed and the attachment is not re-captured automatically |
| `failed` | the push failed; `error` is the provider message verbatim | nothing at first — the sweep retries with backoff (1 min doubling to 1 h, 8 attempts). Persisting: fix the named cause; **Sync now** retries immediately |
| `failed`, `error` starts `exhausted:` | the sweep gave up at attempt 8; the last reason follows the prefix; `accounting.sync.exhausted` was logged | fix the cause, then **Sync now** — the cap bounds the sweep, not the human; a manual sync re-claims the row |
| `pending` | claimed and in flight, or a crashed in-flight push | wait; the sweep releases a `pending` older than 15 min to `failed` (attempts untouched) and re-feeds it. Do not edit the row |
| `skipped` | a connector skip with the reason preserved (`not_connected`, `no_ledger_amount` — `no_sek_amount` on rows recorded before #2877, `not_outbound`), `connection needs_reauthorisation: …`, or `scope refused before the invoice was created: …` | fix the named cause (usually: the user reconnects); the sweep retries skipped rows like failed ones — but NOT while the connection is not `connected`. Sync now also re-claims them |
| *(no row)* | the hook never ran (feed off, not entitled, no destination, `auto_feed = false`), the payment predates `feed_from`, FX was not ready, or the payment never produced an evidence row (settlement-side, above) | read `GET /accounting/feed/status`; **Sync now** or the backfill feeds it once the cause is gone |

**On-call read, per user:**

```sql
SELECT payment_id, status, attempts, external_ref, error, updated_at
  FROM accounting_feed_syncs WHERE user_id = '<uuid>' ORDER BY updated_at DESC;
```

Never hand-edit `status`: flipping `pushed` back re-posts the record.

## Feed-from, backfill and settings

**The rule (binds every connector).** `feed_from = now` when a row is
connected and takes the active flag, when it is activated, and at a company
switch. The backfill is the ONE path that moves it earlier; nothing moves it
later except those three. A reconnect keeps the floor it had; a pre-#2862 row
migrated with no floor keeps its NULL (it fed everything). The selection
(`LIST_UNPUSHED_PAYMENT_IDS_SQL`) and the hook both skip anything settled
before the floor, so a switch never re-feeds history into a new ledger.

**Backfill.** `since` is a strict ISO date (`YYYY-MM-DD`, or a date-time with
a timezone), in the past, not before 2020-01-01, and earlier than the current
floor; the "earlier only" check is the UPDATE's own WHERE clause
(`RECORD_BACKFILL_SQL`), so two concurrent backfills cannot leap-frog. Only the
active `connected` destination can be backfilled. One `syncUser` runs, bounded
to 200 payments; more history takes further Sync now presses.

**Settings.** `suggested_account` (Fortnox: `^[1-8]\d{3}$`; other providers
1–32 chars; `null` clears) rides the feed transaction's `suggestedAccount` and
the Fortnox connector surfaces it ONLY as `YourReference: "suggested account
6540"`; `assertNonAsserting()` still bans `Account` on the payload.
`auto_feed = false` closes the two automatic paths (the hook returns before
the entry is built; the sweep's JOIN excludes the connection) and leaves the
two manual ones (Sync now, backfill). A "nothing syncs" report where
`settings ->> 'auto_feed' = 'false'` is the answer, not a fault. Supplier
strategy is fixed at one supplier per merchant (owner decision).

## Background retry sweep

`startRetrySweep` (`modules/accounting/retry-sweep.ts`, registered in
`src/index.ts`, `unref()`ed, leader-locked on
`LEADER_LOCK_KEYS.accountingRetrySweep`). Cadence
`HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS`; the first tick runs at boot; a
tick still running when the next fires is skipped in-process. **Inert** when
the feed is off.

Each tick selects, in ONE query (`LIST_DUE_RETRY_SYNCS_SQL`, batch 200), the
`failed` / `skipped` / stale-`pending` rows whose connection is `connected`,
the active destination and not `auto_feed = false`, and whose backoff has
elapsed — derived from `attempts` and `updated_at`, no schema change:

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

`backoff(n) = min(1 min · 2^(n−1), 1 h)`; due when
`updated_at + backoff(attempts) <= now`. A `pending` row is due once older
than 15 min (`STALE_PENDING_CLAIM_MS`) — safe only because a live push cannot
be that old: every Fortnox call has an abort timeout (15 s per JSON request,
60 s for the inbox upload) and a push is at most a handful of sequential
requests. The attempt that reaches 8 leaves the row `failed` with
`error = exhausted: <last reason>` — a guarded write that never touches a row
a manual Sync now re-claimed or pushed in the meantime.

**Rate limits.** One connection at a time; within a connection a fixed floor
of 25 requests / 5 s (Fortnox's documented limit, budgeted at 8 requests per
push → three pushes per window). A provider 429 (`ProviderError.status`) defers
the REST of that connection to the next tick — the row that hit it is a real
failure, the others get no claim and no `attempts + 1`. A `Retry-After` is
honoured as a courtesy when a provider sends one (Fortnox sends none), clamped
to the 1 h cap.

## Ops signals: log events, counters, alert thresholds

Four structured events (#2872), every line carrying `event`, so one grep —
`"event":"accounting.` — finds all of them. All of them reach the app logger:
the sweep writes through the logger it is given at boot; the connection event
goes through `setOpsEventSink`, which `index.ts` points at the same logger
(default `console`, for a flow run without the app).

| event | level | when | fields |
|---|---|---|---|
| `accounting.sweep.run` | `info` when `considered > 0`, else `debug` | once per sweep tick | `considered`, `pushed`, `failed`, `deferred`, `exhausted`, `skipped`, `connections`, `rateLimited` |
| `accounting.sync.exhausted` | `warn` | the sweep wrote a row's terminal reason (only when the guarded write took) | `userId`, `provider`, `paymentId`, `attempts` (8), `reason` (the last provider message) |
| `accounting.connection.needs_attention` | `warn` | a connection was written `needs_reauthorisation`, `scope_missing` or `revoked_at_provider` — every write site goes through `flagConnectionStatus` (`ops-signals.ts`) | `userId`, `provider`, `status`, `reasonPrefix` (the head of the row's `status_reason` before its ` — ` separator — `missing scopes: a, b`, or `refresh refused: <OAuth error code>` — capped at 120 characters), `missingScopes` (the parsed list; empty unless the prefix names scopes). The line never carries the connector's free-text detail: on the `scope_missing` paths the row's full `status_reason` embeds the provider's message and the refused request path (a supplier-lookup refusal includes the recipient's name), so read that from the row, not the log. Never token material |
| `accounting.sweep.failed` | `warn`, always logged | the sweep's tick threw outside a run — leader election or the query layer, not a push (`Accounting retry sweep failed`) | `err` |

`accounting_company_switch` (`info`, JSON on `console`) is the #2864
company-switch line.

**Counters** on `GET /health/ops` (`X-Haven-Ops-Token`; 404 when
`HAVEN_OPS_TOKEN` is unset, 401 on a wrong token — the accounting queries run
only after the token passes), under `accounting`:

| field | query | meaning |
|---|---|---|
| `exhaustedSyncs` | `COUNT(*) FROM accounting_feed_syncs WHERE status = 'failed' AND attempts >= 8` (`COUNT_EXHAUSTED_SYNCS_SQL`) | rows the sweep has given up on, deployment-wide — the same predicate as the per-user `counts.exhausted`, never the reason prefix |
| `connectionsNeedingAttention` | `COUNT(*) FROM accounting_connections WHERE status IN ('needs_reauthorisation', 'scope_missing', 'revoked_at_provider')` (`COUNT_CONNECTIONS_NEEDING_ATTENTION_SQL`) | connections only a re-consent resolves; `disconnected` is the user's choice and is not counted |

Both are read live, one aggregate each, no per-user data on the wire. When
the queries throw, both fields are `null` and `unavailable: true` is added —
the route answers 200 with the in-memory fields intact rather than 500ing
the whole payload (review on #2905).

**Alert thresholds** (dev today; the numbers are the first honest ones, not
tuned ones — a handful of connections exist):

| signal | threshold | meaning / first action |
|---|---|---|
| `accounting.sync.exhausted` | any occurrence | a payment nobody will re-feed without a human. Read the `reason`: a token/scope reason means the connection has since flipped (check the row); a Fortnox validation code (e.g. `2000359`) means a payload field slipped past the sanitiser — fix the connector, not the data; then the user presses Sync now |
| `exhaustedSyncs` | `> 0` for more than one sweep interval after the cause is fixed | the fix did not take, or nobody pressed Sync now |
| `accounting.connection.needs_attention` | one occurrence is expected product behaviour (the user reconnects); alert when **the same user flips again within 10 minutes of a reconnect** | the re-consent cannot grant what the app registration does not declare, or the client credentials are wrong — an operator problem |
| `connectionsNeedingAttention` | `>= 3` at once, or `>= 50 %` of `SELECT count(*) FROM accounting_connections WHERE status <> 'disconnected'` | several grants died together: a rotated `FORTNOX_CLIENT_SECRET` shows as 401s in the log and flips nobody, so this shape points at a scope change in the app registration or a provider-side revocation |
| `accounting.sweep.run` with `rateLimited > 0` | three consecutive ticks | another integration is spending the tenant's Fortnox budget — the sweep's own pacing cannot cause a 429 |
| `accounting.sweep.run` absent | > 2 × the interval on the leader — **only meaningful with the logger at `debug`**, since an idle tick logs at that level; at `info` the line appears only when a row was due | the sweep is not running: the flag is off, or the leader lock is held elsewhere; `accounting.sweep.failed` (`warn`, always logged) says which |
| `accounting.sweep.failed` | two consecutive ticks | the tick cannot even start: the leader lock's advisory query fails, or `listDueRetrySyncs` throws — a database problem on the leader, not a provider one; read `err` |
| `accounting.unavailable: true` on `/health/ops` | any | the two aggregate counters threw (the route logs `health/ops accounting counters unavailable` at `warn` with the error's class); the relayer and passport fields still answer, so the database, not the process, is the first thing to check |
| `[accounting] could not re-encrypt secrets for connection=` at boot | any | a version-0 row the boot job could not encrypt; see *Secrets at rest* |

## Secrets at rest, and the key

Provider credentials — the Fortnox OAuth token pair today — live in
`accounting_connections.secrets_ciphertext` as an AES-256-GCM blob
(`iv || tag || ciphertext`), keyed by `HAVEN_SECRETS_KEY`, never in the
database (`infra/secrets.ts` is the only file that reads the variable).
`secrets_key_version` says how a row is stored: `0` plaintext JSON (a row
migration 080 copied as-is, or a disconnected row), `1` encrypted under the
current key.

- **Rows are encrypted at boot, not by a migration.** On the first boot that
  has the key, `reencryptPlaintextSecretsAtBoot` rewrites every version-0 row
  — idempotent, per-row on a bad blob, and a compare-and-swap on the version
  so it never overwrites a token a serving replica rotated meanwhile. Without
  the key it logs one line and touches nothing. A refresh also re-encrypts a
  version-0 row as a side effect.
- **Without the key** a new connection is refused (`SecretsKeyMissingError`)
  and a refresh is refused *before* the provider is called, so the single-use
  refresh token is never consumed. Fortnox access tokens live one hour, so a
  dev backend without the key starts refusing refreshes within an hour of the
  first settlement after deploy.
- **On-call check:** `SELECT provider, status, secrets_key_version FROM
  accounting_connections WHERE user_id = '<uuid>'`. A `0` on a `connected`
  row after the key has been set for more than one boot means the boot job
  logged `could not re-encrypt secrets for connection=<id>` for it.

**Key rotation — what exists and what does not.** There is **no rotation
path** today: `CURRENT_KEY_VERSION` is `1`, the reader knows exactly one
version, and there is no second key slot to read old rows with while writing
new ones — the "re-encrypt job that reads with the old version and writes
with the new" that `infra/secrets.ts` describes is a design note, not code.
Consequently:

- **Do not change `HAVEN_SECRETS_KEY` on a deployment with version-1 rows.**
  Every one of them becomes unreadable: a refresh fails on the auth tag
  (`failed` rows whose reason is Node's `Unsupported state or unable to
  authenticate data`, the connection stays `connected`), and the user's own
  **Disconnect** fails too, because the revoke step decrypts first. Nothing
  flips a state, so the counters above stay quiet — the `failed` rows and the
  sweep's `failed` counter are the only signal.
- **If the key was lost or must be replaced anyway** (compromise): set the new
  key, then reset every version-1 row by hand so users can reconnect — the
  same shape `DISCONNECT_ACCOUNTING_CONNECTION_SQL` writes, with a reason
  that says why:

  ```sql
  UPDATE accounting_connections
     SET secrets_ciphertext = NULL, secrets_key_version = 0, status = 'disconnected',
         status_reason = 'secrets key replaced by operator — reconnect', is_active_destination = false,
         updated_at = NOW()
   WHERE secrets_key_version = 1;
  ```

  Every affected user then sees *Not connected* and connects again; the grants
  at Fortnox are NOT revoked by this (Haven no longer holds the tokens to
  revoke with), so the user should also remove the old integration inside
  Fortnox, or let it expire after 45 idle days. History and settings survive
  (the row is kept). A real rotation path — a key-version table with a read
  fallback — is the follow-on to file when prod gets its key (#2876).

## Schema for on-call

Two tables; the SQL constants live in `infra/repositories/` and are
registered in the schema smoke (`npm run db:schema-smoke -w packages/backend`).

- **`accounting_connections`** (migration 080): `user_id`, `provider`,
  `auth_kind` (`oauth2` | `api_key`), `secrets_ciphertext`,
  `secrets_key_version`, `external_company_id`, `external_company_name`,
  `base_currency`, `status` (CHECKed to the five states),
  `status_reason`, `granted_scope`, `token_expires_at`,
  `is_active_destination` (partial unique per user), `feed_from`, `settings`
  JSONB (`suggested_account`, `auto_feed`, `backfill { since, requestedAt }`,
  `companySwitches[]` — append-only, oldest first), `last_push_at`,
  `last_error`. UNIQUE (`user_id`, `provider`).
- **`accounting_feed_syncs`**: `user_id`, `provider`, `payment_id`,
  `status`, `attempts`, `external_ref`, `error`, `created_at`, `updated_at`.
  UNIQUE (`provider`, `payment_id`, `user_id`). No company column: a pushed
  row is attributed to a company by TIME against `settings.companySwitches`
  (`companyIdAt`), which is what makes the reopen refuse `previous_company`.

**Migration history.** The Fortnox-only connection table from 027 was copied
into `accounting_connections` by 080 (#2860) and renamed, not dropped, to
`fortnox_connections_retired` so a rolling deploy with overlap could not lose
a committed write; 081 (#2872) drops the retired table after the epic's
product verification — schema-only, no row read, `down()` recreates it empty
in 027's shape because 080's own `down()` renames it back. The
`reporting_feed_syncs` → `accounting_feed_syncs` rename and the
`reporting_feed` → `accounting_feed` entitlement rewrite also rode 080.

## Boundaries (what this feed will never do)

- **Never asserts**: no voucher rows, no account, no VAT — structurally
  banned (`assertNonAsserting`, test-locked); the suggested account rides as
  free text in a hint field only.
- **Never books**: the read-back is the only read, strictly read-only.
- **Never blocks money**: the hook is fire-and-forget; a provider outage delays
  the feed, never settlement.
- **Never holds keys or moves funds**: the connection is the provider's own
  grant, encrypted, revocable from either side.

## Provider notes: Fortnox

**App registration.** Scopes (`FORTNOX_SCOPE`):
`bookkeeping supplierinvoice supplier archive inbox connectfile companyinformation`.
The developer-portal permissions must include every one — including
*Företagsinformation* — or every consent comes back `scope_missing`. The
connecting Fortnox user must be a system administrator with an integration
licence (epic: unverified against a live customer; keep out of external copy).
Redirect URI: `<backend>/accounting/connections/fortnox/callback`.

**What connect records.** `GET /3/companyinformation` — `DatabaseNumber` is
`external_company_id`, `CompanyName` the name, currency `SEK` by construction.
A refused read (403 / `[2000663]`) stores the connection as `scope_missing`
(`company info unavailable: …`); a network error or 5xx stores nothing. A
reconnect to a different `DatabaseNumber` is a company switch: one row kept,
company fields replaced, `feed_from = now`, `status_reason` names both
companies, `settings.companySwitches` appended, one
`accounting_company_switch` log line. Pre-switch `pushed` rows stay; *Check in
Fortnox* reports them `missing` through the new company (correct), and the
reopen refuses them `previous_company`.

**Token lifecycle.** Access tokens live one hour; refresh tokens are
single-use and rotate on every refresh (45-day life). The refresh runs under a
`SELECT … FOR UPDATE` on the row, inside a transaction spanning the provider
call, so two concurrent callers make one provider call and the rotated pair is
committed before either sees the new access token. A refused refresh is a
`needs_reauthorisation` flip (states above), and a burst of **401
`invalid_client`** in the log is Haven's `FORTNOX_CLIENT_ID` /
`FORTNOX_CLIENT_SECRET` no longer matching the app — fix the variables; no
user is flipped, no one reconnects.

**Disconnect revokes.** `POST /oauth-v1/revoke` (`token_type_hint=refresh_token`,
Basic client auth) before the secrets are cleared; a failed revoke still
clears locally. The user can always also remove the integration inside Fortnox.

**Error codes seen live.** `[2000663]` scope — mapped to the scope the endpoint
needed (`fortnoxScopeForPath`, five entries: `/supplierinvoicefileconnections`
→ `connectfile`, `/supplierinvoices` → `supplierinvoice`, `/suppliers` →
`supplier`, `/inbox` → `inbox`, `/companyinformation` →
`companyinformation`; any other path → no scope named) because
Fortnox does not say which; a bare 403 counts as scope, a 403 with another code
(a licence error such as `[2003295]`) is a plain `failed`. `[2000359]`
non-ASCII in Comments/Name (middle dots, `://`, `…`) — the connector sanitises;
a new occurrence is a new field that slipped through. Rate limit: 25 requests /
5 s per client-id + tenant, HTTP 429 with no `Retry-After`.

**What the accountant sees.** *Meny → Leverantörsfakturor*: an unbooked
supplier invoice per payment, `ExternalInvoiceNumber = HAVEN-<paymentId>`
(the join key), `DueDate = InvoiceDate`, Total and Currency in the connection's
booking currency — SEK for every Fortnox company (#2877) — `Booked: false`, no
voucher until attested; the Haven payment-evidence PDF and, when captured, the
merchant's receipt as attachments. **First-visit gotcha (2026-08-13):** a
company that has never opened the module in the UI gets Fortnox's one-time
onboarding wizard instead of the list — every step is skippable; the invoices
are there and the API is unaffected. An x402 merchant receipt that arrives
after the push is late-attached onto the existing invoice; a late-attach
failure becomes a note on the row.

**Verifying delivery.** (1) `/accounting` → **Check in Fortnox**: *Registered —
awaiting booking* (the steady state until the accountant acts), *Booked,
voucher `<series><number> <year>`*, *Cancelled*, or *Not found* — then
**Re-open for sync** re-runs the read-back server-side and flips the row only
when Fortnox confirms the invoice is gone, and **Sync now** pushes again. The
read-back cross-checks `ExternalInvoiceNumber`, so a number collision after a
company switch reads as *Not found*, never as a false "registered".
(2) Fortnox's own UI, above. (3) `GET /accounting/feed/status` and
`GET /accounting/feed/verify/:paymentId` for on-call.

**Product verification on dev** (the epic's checklist, run by the owner): a
fresh dev user connects Fortnox from Settings, chooses a backfill option, an
agent purchase settles and appears in the Fortnox sandbox as an unattested
supplier invoice with both attachments, *Check in Fortnox* reports registered,
Disconnect revokes.
