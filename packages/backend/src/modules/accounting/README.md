# Accounting module — adding a provider

The non-asserting accounting feed (epic #491) delivers each settled agent
payment to the user's accounting software as a **draft source document**:
supplier, amount, date, description, receipt attached — never a voucher row, a
BAS account or a VAT verdict. Fortnox is the first provider; the module is
provider-generic since #2862 (epic #2858), and this note is the recipe for the
next one. Operations are in
[`docs/operations/accounting-feed.md`](../../../../../docs/operations/accounting-feed.md);
the architecture is in
[`docs/research/accounting-data-feed.md`](../../../../../docs/research/accounting-data-feed.md).

## The three things a provider is

| piece | file | what it is |
|---|---|---|
| **descriptor** | `registry.ts` (`AccountingProvider` in `provider.ts`) | data: id, display name, `authKind` (`oauth2` \| `api_key`), `capabilities` (`attachments`, `verify`, `revoke`, `companyInfo`), `availability` (`live` \| `coming_soon`), `requiredScopes` |
| **connector** | `<provider>-connector.ts`, implements `AccountingConnector` (`connector.ts`) | code: `isConnected`, `pushTransaction`, `verify`, `getCompanyInfo`, `revoke` |
| **connection row** | `infra/repositories/accounting-connections.ts` | the user's grant, encrypted at rest (`infra/secrets.ts`), one row per (user, provider), exactly one active destination per user |

A provider can be **listed without code** — Accounted, Light and Igdrasil are
`coming_soon` descriptors today, and `GET /accounting/providers` shows them.
Only a `live` provider with a registered connector accepts a connect
(`assertConnectable` in `registry.ts`).

The routes (`routes/accounting-connections.ts`) and the feed (`feed-orchestrator.ts`,
`routes/accounting-feed.ts`) know no provider by name. They call
`connections.ts`, which joins the three pieces above.

## Recipe

1. **Descriptor.** Add an `AccountingProvider` constant to `registry.ts` and
   put it in `PROVIDERS`. Start it as `coming_soon` if the product wants it
   listed before it works; flip to `live` when step 5 is green.
2. **Auth flow.** Nothing to write. `oauth2`: supply an `OAuth2ProviderConfig`
   (authorize URL, token URL, client credentials from `config.ts`, scope) and
   add a case to `oauth2ConfigFor` in `connections.ts` — the generic
   `oauth-flow.ts` does the consent URL, the code exchange, the refresh, and
   the key-before-provider-call ordering that protects a single-use refresh
   token. It also compares the scope string the provider echoes with the
   descriptor's `requiredScopes` (#2865): a shortfall stores the connection
   as `scope_missing` naming the missing scopes (not a refusal), and the
   same connect-url + callback on an existing connection is the re-consent
   path — the row is updated, `settings`, `feed_from`, the active flag and
   the sync history are kept. `api_key`: nothing at all — `api-key-flow.ts`
   validates the key by calling your connector's `getCompanyInfo` and stores
   it encrypted.
3. **Connector.** Implement `AccountingConnector` against the provider's API.
   The invariants the contract carries, in the order they usually bite:
   - `pushTransaction` must send **no VAT, account or rows** — the accountant
     codes. Fortnox makes this a runtime guard (`assertNonAsserting`); do the
     same for your payload shape.
   - an attachment failure is a **note on a pushed row**, never a failed push;
     an attachment failure caused by a **missing scope** additionally sets
     `connectionStatus: 'scope_missing'` on the result — the orchestrator
     flips the connection's status so the dashboard asks for a re-consent, and
     the sync row stays `pushed` (never re-pushable).
   - **pre-push vs post-push scope refusal (#2865).** If the CREATE call
     itself (or anything before it) is refused for scope — nothing exists at
     the provider — return `status: 'skipped'` with the reason and
     `connectionStatus: 'scope_missing'`: the row is a real `skipped`, the
     connection flips, and the retry sweep re-feeds the row once the user
     re-consents. Never `throw` a scope refusal (the sweep would retry it
     eight times) and never mark a POST-push refusal `skipped` (the sweep
     would push a second record). Name the scope(s) the refused call needed
     in `missingScopes` when you can (Fortnox maps the endpoint:
     `fortnoxScopeForPath`); the orchestrator writes them into the
     connection's `status_reason` in the shape `missingScopesReason` defines,
     which is what `missingScopes` on the API reads back.
   - `verify(userId, externalRef, paymentId)` reads back the record and
     reports `registered` / `booked` / `missing: 'deleted' | 'foreign_invoice'`
     (a record at that number that is not ours).
   - `getCompanyInfo(secrets)` reports the company behind the grant —
     `externalCompanyId` (the provider's tenant id; Fortnox: `DatabaseNumber`),
     `name`, and the ledger's `baseCurrency`. The generic flows refuse a
     non-SEK ledger at connect BEFORE any secret is stored
     (`assertSupportedBaseCurrency`, owner decision 2026-09-11, enforced by
     #2864 for every provider: "Haven currently feeds SEK ledgers only"; an
     existing row is left as it was). Report `null` if the provider cannot
     say. A connector that TRIED and was refused for a missing scope reports
     `scopeMissing: true` — the flow stores the connection and marks it
     `scope_missing` so the dashboard asks for a re-consent; a network error
     or a 5xx is thrown, never reported as a missing scope (the Fortnox
     connector is the example: HTTP 403 or `[2000663]` degrade, everything
     else throws).
   - **Company switch (#2864) is the generic flow's, not yours.** A reconnect
     whose `externalCompanyId` differs from the stored one keeps the row,
     replaces the company fields, sets `feed_from = now`, writes a
     `status_reason` and appends to the row's `settings.companySwitches` log
     (`company-info.ts`, `recordCompanySwitch`). Existing `pushed` sync rows
     keep their external refs; `reopenPushedPayment` (`connections.ts`)
     refuses a `pushed` row created before the latest switch with
     `previous_company`. The attribution is by time — `accounting_feed_syncs`
     has no company column — and its limits are in the runbook.
   - `revoke(secrets)` is called on disconnect **only** when the descriptor
     declares `capabilities.revoke`; implement it as a no-op otherwise. The
     generic disconnect calls it BEFORE the secrets are cleared and clears
     them whether or not it succeeded (a failed revoke is reported by error
     name, never a reason to keep a grant stored). An OAuth2 provider with an
     RFC 7009 endpoint sets `revokeUrl` on its `OAuth2ProviderConfig` and
     calls `revokeToken` from `oauth-flow.ts` (the Fortnox connector is the
     example: `POST /oauth-v1/revoke`, `token_type_hint=refresh_token`).
   - **Token lifecycle (#2863) is the generic flow's, not yours.** An
     `oauth2` connector gets its access token through
     `getValidOAuth2AccessToken` and inherits: the refresh under a
     per-connection row lock (`withLockedConnection`, `SELECT … FOR UPDATE`
     — two concurrent callers make one provider call, the rotated refresh
     token is committed before the access token is returned); the flip to
     `needs_reauthorisation` on a token-endpoint refusal that is a verdict on
     the GRANT (`invalid_grant`, or a bare 400/403 — never `invalid_client`
     and the other client-side RFC 6749 codes, never 401/408/429/5xx, which
     leave the row untouched), after which the flow throws
     `ConnectionNeedsReauthorisationError` without calling the provider and
     the orchestrator records each sync as `skipped` with
     `connection needs_reauthorisation: <provider error>`; and the
     `secretsKeyConfigured()` check BEFORE the single-use refresh token is
     consumed. Do not add a second refresh path in the connector.
   - **The user's settings and the backfill are the generic layer's, not
     yours (#2867).** `settings.suggested_account` arrives on
     `FeedTransaction.suggestedAccount` (the per-merchant override wins when
     one exists); surface it ONLY through your non-asserting hint field
     (Fortnox: `YourReference`), never as an account key — the guard from
     the first bullet is the test. `settings.auto_feed = false` is enforced
     BEFORE your connector is called (the orchestrator's early return and
     the sweep's selection); a connector never sees the setting. The
     backfill route moves `feed_from` earlier and runs the same `syncUser`;
     nothing in a connector is backfill-aware.
   - **A degraded state is written through `flagConnectionStatus`
     (`ops-signals.ts`, #2872), never the repository's `setStatus`.** The
     generic flows and the orchestrator already do; a connector normally
     never writes a status at all (it reports `connectionStatus` on its
     result). The wrapper is what emits `accounting.connection.needs_attention`
     for `needs_reauthorisation` / `scope_missing` / `revoked_at_provider`,
     and the `/health/ops` counter counts the same three states — a write
     that bypasses it is a state on-call cannot see.
   - **Retries are the sweep's, not yours (#2866).** A thrown error or a
     `failed` result lands in the ledger and `retry-sweep.ts` re-feeds the
     row with backoff (1 min doubling to 1 h, 8 attempts, then
     `exhausted:`), one connection at a time under a 25 requests / 5 s floor.
     Throw a `ProviderError` with `status: 429` on the provider's rate limit
     — that is what defers the rest of the connection to the next tick —
     and set `retryAfterMs` on it if the provider sends `Retry-After`
     (honoured as a courtesy). Do not retry inside `pushTransaction`.
4. **Register the instance** at boot in `src/index.ts`, gated on the
   provider's credentials being configured (the Fortnox pattern), so a
   deployment without them lists the provider as `configured: false`.
5. **Conformance.** Add `__tests__/<provider>-connector.conformance.test.ts`:
   a `ConformanceHarness` for your connector, then
   `runConnectorConformance(name, harness)`. The suite
   (`__tests__/connector-conformance.ts`) is the contract's executable form —
   idempotent re-push, the non-asserting guard, attachment degradation, verify
   verdicts, revoke-on-disconnect, post-push scope loss (row stays pushed),
   pre-push scope refusal (row skipped, delivered once after reconnect —
   your harness supplies the `refuseInvoiceForScope` knob), non-SEK refusal
   (before any secret is stored, on connect and on reconnect), company switch
   on reconnect — and runs the real orchestrator and flows; your harness supplies HTTP fixtures
   under `__tests__/fixtures/<provider>/` (see the Fortnox runner — its
   fixtures are hand-authored in the shapes the #494 spike recorded, not raw
   captures). An `api_key` connector's `getCompanyInfo` must throw a
   `ProviderError` with status 401/403 for a rejected key — that is what the
   flow maps to `InvalidApiKeyError`; anything else surfaces as a 500. It must
   pass before the descriptor goes `live`.
6. **Docs.** The route table in `docs/operations/accounting-feed.md` does not
   change (the routes are generic); add the provider's own section to that
   runbook (credentials, redirect URI, error codes, what the accountant
   sees — the Fortnox section is the shape), the user-facing states to
   `docs/product/accounting-connections.md`, and a CASP shard if the change
   touches a covered path (`docs/regulatory/casp-changelog/README.md`).

## OAuth `state`, and why the callback consumes it

`POST /accounting/connections/:provider/connect-url` signs a JWT: `sub`,
`purpose: accounting_oauth` (rejected by `authMiddleware`, so a session token
and an OAuth state can never stand in for each other — #1640), `provider`
(bound to the URL it was issued for), `jti`, 10-minute expiry. The callback
verifies all of that and then **consumes the `jti`** before exchanging the
code (`oauth-state.ts`), so a replayed state is refused without a second
provider call.

The consumption store is `rate_limit_counters` (#1680): an atomic keyed
upsert with an expiry, durable across replicas, already swept — exactly the
"seen this key in the last N minutes" shape, with no new table. Two honest
caveats, both accepted: the table is UNLOGGED (a crash truncates it, so a
state issued before a Postgres crash could be accepted once more within its
ten minutes), and the limiter's increment is fail-open by design — here a
store that cannot answer **refuses** the callback instead, because a connect
is retried in seconds and a replayed grant is not undone.

## What stays provider-scoped

`POST /accounting/fortnox/push` (in `routes/accounting.ts`): the legacy
asserting voucher push, dark behind `HAVEN_LEGACY_BOOKKEEPING_ENABLED` (410 by
default). It pushes finished Fortnox vouchers — provider-specific by nature,
and exactly what the feed moved away from (#491/#492).
