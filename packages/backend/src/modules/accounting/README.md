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
   token. `api_key`: nothing at all — `api-key-flow.ts` validates the key by
   calling your connector's `getCompanyInfo` and stores it encrypted.
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
   - `verify(userId, externalRef, paymentId)` reads back the record and
     reports `registered` / `booked` / `missing: 'deleted' | 'foreign_invoice'`
     (a record at that number that is not ours).
   - `getCompanyInfo(secrets)` reports the ledger's `baseCurrency`; the
     generic flows refuse a non-SEK ledger at connect (`assertSupportedBaseCurrency`,
     policy owned by #2864). Report `null` if the provider cannot say.
   - `revoke(secrets)` is called on disconnect **only** when the descriptor
     declares `capabilities.revoke`; implement it as a no-op otherwise.
4. **Register the instance** at boot in `src/index.ts`, gated on the
   provider's credentials being configured (the Fortnox pattern), so a
   deployment without them lists the provider as `configured: false`.
5. **Conformance.** Add `__tests__/<provider>-connector.conformance.test.ts`:
   a `ConformanceHarness` for your connector, then
   `runConnectorConformance(name, harness, oracle)`. The suite
   (`__tests__/connector-conformance.ts`) is the contract's executable form —
   idempotent re-push, the non-asserting guard, attachment degradation, verify
   verdicts, revoke-on-disconnect, post-push scope loss, non-SEK refusal — and
   runs the real orchestrator and flows against the feed oracle; your harness
   supplies recorded HTTP fixtures under `__tests__/fixtures/<provider>/` (see
   the Fortnox runner). It must pass before the descriptor goes `live`.
6. **Docs.** The route table in `docs/operations/accounting-feed.md` does not
   change (the routes are generic); add the provider's operator steps
   (credentials, redirect URI) to that runbook, and a CASP shard if the
   change touches a covered path (`docs/regulatory/casp-changelog/README.md`).

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
