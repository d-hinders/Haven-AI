---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/catalog/lifecycle.ts
  - packages/backend/src/infra/repositories/catalog-submissions.ts
  - packages/backend/src/infra/repositories/merchants.ts
  - packages/backend/src/index.ts
  - packages/backend/src/db/migrations/068_catalog_lifecycle.ts
  - packages/backend/src/db/migrations/088_merchants.ts
  - packages/backend/src/db/migrations/066_catalog_submissions.ts
  - packages/backend/src/modules/catalog/probe.ts
  - packages/backend/src/modules/catalog/ownership.ts
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/modules/catalog/catalog-discovery.ts
  - packages/backend/src/routes/catalog.ts
last-verified: "2026-10-25"
---

# Operations Runbook — Verified Payable Directory ingestion (#1714)

How the self-service catalogue submission pipeline behaves in production, and
what an operator does when it misbehaves. Part of epic #1717; this document
covers the lifecycle slice (#1714) — ownership verification, the verification
probe, re-verification cadence, retention, and the ops alarms.

## The pipeline in one paragraph

A merchant `POST /catalog/submit`s a payable MCP endpoint (x402 over MCP). The request
writes ONE inert `catalog_submissions` row (`submitted`) and nothing else —
no outbound traffic on the request path (Pinned by #1711's route tests). A
leader-locked monitor (every 5 minutes, lock key `catalogIngest`) then walks
every row through: domain-ownership proof (`submitted →
ownership_verified`, #1712), then the SSRF-hardened read-only quote probe
(`ownership_verified → verified_payable`, #1713), degrading sustained
failures to `failed`, and finally purging terminal rows after a retention
period.

## Lifecycle states

| State | Meaning | Entered by | Leaves via |
|---|---|---|---|
| `submitted` | Queued claim; seller controls nothing yet | `POST /catalog/submit` | ownership proof ok → `ownership_verified`; token TTL (7d) elapsed → `failed` |
| `ownership_verified` | Seller proved control of the domain | ownership stage | probe ok → `verified_payable`; N consecutive probe failures → `failed` |
| `verified_payable` | The probe's unpaid tool call was answered with a `payment_required` block carrying `extensions.bazaar.schema` | probe success | re-probe fails N times → `failed`; operator SQL → `delisted` |
| `failed` | Could not prove or maintain the claim | TTL / N failures / operator | retention purge (30d) |
| `delisted` | Operator action (SQL; no route or code path sets it) | operator | retention purge (30d) |

Only `submitted`, `ownership_verified` and `verified_payable` are "pending"
for the per-hostname uniqueness index: one active row per hostname at a time,
guaranteed by Postgres (migration 066). A terminal state releases the host
for a fresh submission.

### What the ingestion probe checks

The probe (`modules/catalog/probe.ts`) walks `initialize`, then `tools/list`,
then an unpaid `tools/call` of the first named tool, through the SSRF guard. It
passes when that call answers with a `payment_required` block (top level,
`error.data` or `result`) that carries `extensions.bazaar.schema`. It keeps
only the schema's `name`, `description` and `entrypoint`. It reads no price
and selects no payment option. The payability verdict that #4389 gave the
catalog (below) runs on `merchant_catalog` rows only, so an ingestion row is
served with `price_atomic`, `asset`, `network` and `asset_transfer_methods`
all `null` (`serializeIngestion` in `routes/catalog.ts`).

## The merchant step (#3078)

When a submission reaches `verified_payable` the lifecycle attaches it to a
merchant (`merchants` table, migration 088) through the one writer every
catalog path shares, `findOrCreateMerchantByHost` in
`infra/repositories/merchants.ts`. The **hostname is the find key**: a
submission on a host that already has offers in the catalog — a curated
merchant's host, say `services.ampersend.ai` — or an earlier attached
submission joins that live merchant (a `coming_soon` prospect never matches), and the
submitter's `merchant_name` / `merchant_website` are ignored (the host proves
the seller; `verified_payable` proves the offer). On a host nobody owns, a
merchant is founded from `merchant_name` (else the probe's own name for the
endpoint) and `merchant_website`, with a slug from the name and a numeric
suffix if that slug is taken by a different merchant. The attachment happens
once (`merchant_id IS NULL` guard): a re-verification never re-homes an offer.

A verified submission therefore renders on its merchant's page with the
Verified badge and `source: 'ingestion'` — an operator did not curate it, and
the page does not pretend otherwise. The Bazaar discovery cron
(`catalog-discovery.ts`) goes through the same writer before its insert, so
`merchant_catalog.merchant_id NOT NULL` holds by construction. Its rows carry
`merchant_catalog.source = 'bazaar'` (migration 117, #4245) and are served as
`source: 'bazaar'`: a third party's own name and description, which no
operator reviewed and which have no ownership proof. `GET /catalog` sorts them
after operator and ingestion rows. Every other writer gets the column's `'operator'` default.

Since #4389, the hourly refresh and discovery judge a `merchant_catalog`
row's 402 the way the pay path does (`selectCatalogPaymentOption` in
`modules/catalog/merchant-catalog.ts`). The verdict keeps the `accepts[]`
options that the SDK's `normalizePaymentRequired` keeps, then runs the SDK's
`selectX402SettlementScheme` over all of them with `delegationRail: true`, so
a payable erc7710 option is preferred over the EIP-3009 bridge. The asset's
symbol and decimals come from the `@haven_ai/core` chain registry, on the
selected option's own chain only; an asset the registry does not know there
is not payable. The row's `network` is that option's network as CAIP-2
(`base-sepolia` is stored as `eip155:84532`), and `pay_to` and
`asset_transfer_methods` are scoped to it. No payable option is a miss on
refresh. Discovery applies the same verdict to the index entry's `accepts[]`
before it spends a probe, and counts an entry with none as
`skippedUnsupported`.

Since #4281, those URLs are probed under the same SSRF guard as a
submission (`infra/http/ssrf-guard.ts`). That holds for discovery's probe of
a candidate and for the hourly refresh of every listed row, whatever its
`source`. The guard requires https on the default port and refuses IP literals
and locally-bound names. It resolves the host and refuses any address outside
public unicast. It pins the socket to an address it checked. If that address
cannot complete a TLS handshake, it tries the next checked address (#4300);
it never tries one the policy refused, and never retries once the request
may have reached a server. It caps the response at 256 KiB. The total
deadline, name resolution included, is 15 s for a refresh probe, enough for
a sleeping merchant's cold start, and 5 s for a discovery candidate, the
ingestion probe's budget. It follows at most 3 redirects on a GET or HEAD, and
refuses any redirect on a method that carries a body. A refusal counts as a
failed probe: discovery skips the candidate, and the refresh adds one to the
row's failure streak.

Each run also has a wall-clock budget (#4300). Without one, a run's length
grew with the number of rows, while it held the leader lock, which has no
TTL.
- **Refresh:** 10 min (`CATALOG_REFRESH_RUN_BUDGET_MS`). It takes rows least
  recently updated first and starts a probe only while that probe's whole
  15 s budget still fits. A row it does not reach is left untouched. That
  means no miss and no step toward `degraded`. The row comes first next run,
  and the run logs how many rows it deferred.
- **Discovery:** 2 min for candidate probes (`DISCOVERY_RUN_BUDGET_MS`). A
  candidate it does not reach is not inserted, so the next run considers it
  again.
- **Bazaar index read:** keeps the caller's `fetch` (its URL is the
  operator's `CATALOG_DISCOVERY_URL`). It reads at most 5 pages a run, each
  within 15 s and 2 MiB.

## Cadences and thresholds (module constants)

All in `packages/backend/src/modules/catalog/lifecycle.ts` (and the probe's
`DEFAULT_HOST_COOLDOWN_MS` in `probe.ts`):

| Knob | Value | Effect |
|---|---|---|
| Monitor tick | 5 min (`CATALOG_INGEST_INTERVAL_MS`, index.ts) | How often the leader scans the queue |
| Probe cooldown | 15 min / host (`DEFAULT_HOST_COOLDOWN_MS`) | One host is probed at most once per window within a batch. `index.ts` passes no shared `HostCooldown`, so each tick starts a fresh one and the window does not span ticks |
| Re-verification cadence | 24 h (`REVERIFY_CADENCE_MS`) | `verified_payable` entries are re-probed when `last_verified_at` is older. A failed re-probe does not move `last_verified_at`, so the row is probed again on every tick until it passes or degrades |
| Failure threshold | 3 (`FAIL_AFTER_CONSECUTIVE_FAILURES`) | Consecutive probe failures before a row degrades to `failed` |
| Ownership token TTL | 7 d (`TOKEN_TTL_MS`, ownership.ts) | A proof is only accepted inside this window; expiry fails the row |
| Retention TTL | 30 d (`RETENTION_TTL_MS`) | Terminal rows are deleted after this long |
| Stuck alarm | 48 h (`STUCK_AFTER_MS`) | A row still `submitted` more than this long after `created_at` fires the stuck alarm |
| Mass-failure alarm | 20 failures/tick (`MASS_FAILURE_THRESHOLD`) | Fires when a single tick fails that many rows |

## Required configuration

- `CATALOG_OWNERSHIP_SECRET` — HMAC key for the domain-ownership proof.
  **Fail-closed:** if unset, the ownership stage does not run, rows accumulate
  in `submitted`, and the stuck alarm fires after 48 h. That is the designed
  signal for a misconfiguration — do not silence it by lowering the threshold.
  Rotate it only with a plan for live claims (proofs embed an HMAC of the
  claim; rotating invalidates in-flight proofs but verification retries until
  TTL).
- `DELEGATE_ALERT_WEBHOOK_URL` — optional; where alerts POST (Slack-shaped
  `{ text }`). No webhook configured = alerts still log as `warn`.

## Alarms

Edge-triggered per process — an ongoing condition fires once, not every tick.
Delivery-gated since #3345: when a webhook POST fails (4xx/5xx or network
error, logged with the status — never the URL), both alarms re-arm and fire
again on the next tick while their condition persists. With no webhook configured the
backend log warning is the whole alert, as before.

1. **Stuck submissions**: N rows in `submitted` past 48 h. Causes to check:
   `CATALOG_OWNERSHIP_SECRET` unset, or merchants never publishing their proof
   (see below). Rows self-resolve at the 7-day token TTL (→ `failed`).
2. **Mass failure**: 20+ rows failed in one tick, counting rows that reached
   the failure threshold and `submitted` rows whose token expired. Causes to
   check: the probe transport or verification DNS resolver misbehaving, or a
   network-wide outage at a cluster of merchants. The global concurrency cap
   (4 in flight) and the per-host cooldown within a tick bound the blast
   radius either way.

Both appear in the backend log as `Catalog ingestion alert` (warn) and, when
`DELEGATE_ALERT_WEBHOOK_URL` is set, as a webhook message.

## Bounded table size (the invariant)

The table cannot grow without bound under sustained abuse or failure:

- The pending set is capped (queue cap + per-hostname unique index, #1711).
- Every non-terminal row eventually becomes terminal: `submitted` rows hit
  the 7-day token TTL, ownership/probe candidates hit the failure threshold.
- Terminal rows are purged after 30 days.

A repeated-failures loop therefore keeps exactly one row per host until its
terminal state, then at most one replacement cycle until the TTL. This is
characterization-tested against real Postgres in
`packages/backend/src/infra/repositories/__tests__/catalog-lifecycle.test.ts`
("repeated failed probes do not grow the table").

## Operator playbook

### A merchant's submission never leaves `submitted`

1. Check `CATALOG_OWNERSHIP_SECRET` is set on the deployment the leader runs.
2. Ask the merchant to serve the exact well-known line or DNS TXT payload the
   status endpoint (`GET /catalog/submit/:id`) returns; verification is idempotent within the 7-day TTL,
   so a corrected proof is picked up by the next tick without resubmitting.
3. If the merchant's host resolves into a private/metadata range, the SSRF
   guard refuses the proof fetch (`unreachable`) — that is the designed
   behaviour; a public IP/pinned DNS is required.

### A listed entry stops verifying (`verified_payable` → `failed`)

Normal: the merchant endpoint changed or went down. The first failure comes on
the first tick after the 24 h cadence; the row is then probed on every tick, so
it degrades after 3 consecutive failures, about 10 minutes later, and is
purged 30 days after that. The merchant can
resubmit. No action required unless the mass-failure alarm fires (above).

### Turning the pipeline off for an incident

There is no kill switch and no runtime knob. `CATALOG_INGEST_INTERVAL_MS` is a
constant in `index.ts`, not an environment variable, so a different cadence is
a code change and a deploy. `SELECT pg_advisory_unlock` from another session is
not a lever either: the lock is session-scoped and held by the leader's own
connection. Unsetting `CATALOG_OWNERSHIP_SECRET` stops rows leaving
`submitted` (fail-closed, above), but the probe stage still runs for
`ownership_verified` and due `verified_payable` rows. For a genuine emergency,
stop the backend and gate `POST /catalog/submit` via WAF until the incident is
understood.

## Data notes

- Rows are pointer-shaped: URL + normalized hostname + verification state +
  pointer metadata (name/description/entrypoint) + the submitter's
  `merchant_name` / `merchant_website` and the attached `merchant_id` (#3078).
  No 402 bodies, no probe history, no prices.
- `submitter_ip` is stored as anti-abuse metadata on the row (the one
  personal-data point, previously named in the SI1 CASP shard) and is purged
  with the row at retention — no separate retention for it.
- Delisting is `status = 'delisted'`, set by operator SQL. It revokes the proof by
  making the ownership transition unreachable, and the row purges after 30d.
