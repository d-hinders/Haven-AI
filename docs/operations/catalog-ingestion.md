---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/catalog/lifecycle.ts
  - packages/backend/src/infra/repositories/catalog-submissions.ts
  - packages/backend/src/index.ts
  - packages/backend/src/db/migrations/068_catalog_lifecycle.ts
last-verified: "2026-08-24"
---

# Operations Runbook — Verified Payable Directory ingestion (#1714)

How the self-service catalogue submission pipeline behaves in production, and
what an operator does when it misbehaves. Part of epic #1717; this document
covers the lifecycle slice (#1714) — ownership verification, the verification
probe, re-verification cadence, retention, and the ops alarms.

## The pipeline in one paragraph

A merchant `POST /catalog/submit`s a payable (x402/MCP) endpoint. The request
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
| `verified_payable` | A live x402 quote was observed | probe success | re-probe fails N times → `failed`; operator → `delisted` |
| `failed` | Could not prove or maintain the claim | TTL / N failures / operator | retention purge (30d) |
| `delisted` | Operator action | operator | retention purge (30d) |

Only `submitted`, `ownership_verified` and `verified_payable` are "pending"
for the per-hostname uniqueness index: one active row per hostname at a time,
guaranteed by Postgres (migration 066). A terminal state releases the host
for a fresh submission.

## Cadences and thresholds (module constants)

All in `packages/backend/src/modules/catalog/lifecycle.ts` (and the probe's
`DEFAULT_HOST_COOLDOWN_MS` in `probe.ts`):

| Knob | Value | Effect |
|---|---|---|
| Monitor tick | 5 min (`CATALOG_INGEST_INTERVAL_MS`, index.ts) | How often the leader scans the queue |
| Probe cooldown | 15 min / host (`DEFAULT_HOST_COOLDOWN_MS`) | A merchant is never probed more than once per window |
| Re-verification cadence | 24 h (`REVERIFY_CADENCE_MS`) | `verified_payable` entries are re-probed when `last_verified_at` is older |
| Failure threshold | 3 (`FAIL_AFTER_CONSECUTIVE_FAILURES`) | Consecutive probe failures before a row degrades to `failed` |
| Ownership token TTL | 7 d (`TOKEN_TTL_MS`, ownership.ts) | A proof is only accepted inside this window; expiry fails the row |
| Retention TTL | 30 d (`RETENTION_TTL_MS`) | Terminal rows are deleted after this long |
| Stuck alarm | 48 h (`STUCK_AFTER_MS`) | A `submitted` row unmoved past this fires the stuck alarm |
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

1. **Stuck submissions**: N rows in `submitted` past 48 h. Causes to check:
   `CATALOG_OWNERSHIP_SECRET` unset, or merchants never publishing their proof
   (see below). Rows self-resolve at the 7-day token TTL (→ `failed`).
2. **Mass failure**: 20+ rows failed in one tick. Causes to check: the probe
   transport or verification DNS resolver misbehaving, or a network-wide
   outage at a cluster of merchants. The per-host cooldown and global
   concurrency cap (4 in flight) bound the blast radius either way.

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
   status endpoint returns; verification is idempotent within the 7-day TTL,
   so a corrected proof is picked up by the next tick without resubmitting.
3. If the merchant's host resolves into a private/metadata range, the SSRF
   guard refuses the proof fetch (`unreachable`) — that is the designed
   behaviour; a public IP/pinned DNS is required.

### A listed entry stops verifying (`verified_payable` → `failed`)

Normal: the merchant endpoint changed or went down; the row degrades after 3
consecutive daily failures and is purged 30 days later. The merchant can
resubmit. No action required unless the mass-failure alarm fires (above).

### Turning the pipeline off for an incident

There is no kill switch; the nearest levers are: set the monitor interval in
deployment config (deploy with a high `CATALOG_INGEST_INTERVAL_MS`), or scale
the single leader/run `SELECT pg_advisory_unlock` is NOT a lever (the lock is
session-scoped). For a genuine emergency, stop the backend and gate
`POST /catalog/submit` via WAF until the incident is understood.

## Data notes

- Rows are pointer-shaped: URL + normalized hostname + verification state +
  pointer metadata (name/description/entrypoint). No 402 bodies, no probe
  history, no prices.
- `submitter_ip` is stored as anti-abuse metadata on the row (the one
  personal-data point, previously named in the SI1 CASP shard) and is purged
  with the row at retention — no separate retention for it.
- Delisting is `status = 'delisted'` (operator). It revokes the proof by
  making the ownership transition unreachable, and the row purges after 30d.
