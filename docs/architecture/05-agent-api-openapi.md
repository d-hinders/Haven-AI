---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/openapi/**
  - packages/backend/src/index.ts
  - packages/backend/src/routes/openapi.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/hybrid-accounts.ts
  - packages/backend/src/routes/transactions.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/payment-state.ts
  - packages/sdk/src/types.ts
  - packages/backend/src/domain/agent-payment-taxonomy.ts
  - packages/backend/src/domain/__tests__/agent-payment-taxonomy.parity.test.ts
  - .github/workflows/ci.yml
  - scripts/generate-api-types.mjs
  - packages/core/src/api-types.ts
  - packages/backend/src/routes/dashboard.ts
  - packages/backend/src/routes/balances.ts
  - packages/backend/src/routes/portfolio.ts
  - packages/backend/src/routes/safe-details.ts
last-verified: "2026-08-23" # #1701: records that documenting a route and lifting its response shapes into named components are different acts, and only the second stops a frontend restatement — #1698's six re-key routes were documented inline, so the dashboard still had nothing to import and the #1447 ratchet refused the PR. Five re-key schemas promoted to components and $ref'd from the paths; the one deliberate open-object exception (the revoke prepare's relayed UserOperation) recorded with its reason. Only the response-shape section re-read; route counts not re-counted. Prior: #1446 slice 13 (final): the ten individually-excluded KNOWN_UNDOCUMENTED_ROUTES documented, on the owner's call to take these rather than the two #1440 Safe routes. Two exclusions were self-refuting: GET /chains' own reason said it SHOULD be in the spec and that this backfill owned it, and POST /x402/{id}/settle was excluded pending a sweep (#834) that closed without doing it — leaving the delegation rail's agent-facing settlement step undocumented. The other eight were held for "a separate dashboard spec" this epic overtook. Undocumented routes: 12 → 2, and the two that remain are the #1440 Safe pair its own deferral entry says not to document. Prior: #1446 slice 12: agent-activity.ts + analytics.ts documented (4 read-only routes). Records a pagination asymmetry a caller would otherwise hit blind: the per-agent activity list applies `limit` to each of its three sources and merges WITHOUT truncating (so up to 3x limit), while the combined feed merges the same way and then truncates. Ceilings 4/16 → 2/12; only the two #1440-caveated Safe modules remain. All three oneOf branches and both routes are asserted; note the general limit of expectMatchesSpec that this slice made visible — an OPTIONAL field a fixture omits is dropped from the JSON, so its type rule never runs, and only fields a fixture actually produces are really pinned. Prior: #1446 slice 11: auth.ts + passkeys.ts documented (5 routes, the credential surface taken as its own slice). Security properties recorded as such: login answers the SAME 401 for unknown email and wrong password (anti account-enumeration), signup normalises the email BEFORE the uniqueness check (or one person gets two treasuries), a second passkey per chain is the backup signer and deliberately allowed (#1229), and the attestation is stored but not yet cryptographically verified. Ceilings 6/21 → 4/16. Prior: #1446 slice 10: approvals.ts documented (5 routes — the human circuit breaker on the legacy rail). Two properties recorded because they are the point: every state flip is guarded inside the UPDATE's WHERE (race closed by the database, not by check-then-write), and approving executes NOTHING — it records consent and hands back the payment for the user's own wallet to execute. Carries the #1440 retirement caveat. Ceilings 7/26 → 6/21. Prior: #1446 slice 9: hybrid-accounts.ts documented (6 routes — counterfactual provisioning, the account-scoped signer set, and the owner-signed signer/transfer prepare+submit pairs). The custody argument travels with them: Haven prepares and relays, the owner's device signs, and the calldata is pinned to what was signed. Ceilings 8/32 → 7/26. Prior: #1446 slice 8: fortnox.ts documented (6 routes) — the credential boundary is the point: tokens live server-side only, /status exposes scope+expiry and nothing else, and the public OAuth callback is authenticated by a purpose-scoped signed state rather than a session, redirecting on every outcome so failure causes stay indistinguishable. Ceilings 9/38 → 8/32. Prior: #1446 slice 7: accounting.ts + reporting.ts documented (9 routes — SIE export, reconcile, BAS categories, and the non-asserting reporting feed with its read-back verification and verification-gated reopen); ceilings 11/47 → 9/38. fortnox.ts held back as its own slice so the OAuth surface gets an undivided review. Prior: #1446 slice 6: user.ts documented (8 routes — profile/wallet/safe writes, currency preference, the cross-Safe owner directory and its aliases); ceilings 12/55 → 11/47. Two shapes a guess would flatten: the profile write returns the FULL row while the wallet/safe writes return a narrower five-field projection, and the owner directory reports partial chain failure in camelCase (partialFailure/failedSafeIds) unlike the rest of this API. Prior: #1446 slice 5: user-safes.ts documented (11 routes — link/deploy/rename/default/unlink plus the approver registry and the UNSIGNED owner-change builder); ceilings 13/66 → 12/55. The custody boundary is stated on the block: Haven links, labels and constructs owner-change transactions, never signs one; membership truth stays on-chain. Note the #1440 caveat recorded in the spec block: 7 of these 11 (deploy, import, all 5 approver routes) are on the Safe-rail removal list and their entries come out with the rail; documented anyway because the spec describes today's API (owner call 2026-08-20). Prior: #1446 slices 3-4: x402-resources.ts (6 routes; 402-as-success on the challenge, 402-as-structured-negative on verify, regulatory framing in the x402 tag description) and the Agent Passport surface (agent-passports.ts + passport-verify.ts, 4 routes); ceilings 16/76 → 13/66. Verification caught two real spec errors: token_address is NOT guaranteed lowercase without a CHECK, and passportStanding returns an OBJECT, not a bare string. Prior: #1446 slice 2: agent-delegations.ts documented (10 routes, new Delegations tag + Delegation schema); ceilings 17/86 → 16/76; every documented shape pinned by expectMatchesSpec against the real payloads, both oneOf branches included. Prior: #1464: malformed uuid params are a documented 400 via central 22P02 mapping (infra/http-error-handler.ts); premise + 404-boundary proven on the real-PG harness; 8 spec operations gained 400. Entry in casp-changelog/2026-08-16-1464.md. #1446: backfill started — contacts.ts documented and off the deferral list; ceilings lowered 18/90 → 17/86. #1445: four spec corrections found by making the generated types load-bearing in the frontend (has_stranded_funds, passport_requested, skill_installed, CatalogEntry.required), plus a named DelegateBalance schema. #1444: adds `expectMatchesSpec` — real responses validated against the spec's own schema (4 routes), with the mutation proofs and the `additionalProperties: true` limit recorded. #1443: the drift check no longer scopes itself to seven hand-listed route files — route-coverage.test.ts derives its scope from the app registration table; records that 89 of 136 registered routes are undocumented, deferred to #1446 under a shrink-only ceiling
---

# Haven Agent API OpenAPI Contract

Haven publishes the agent payment API as OpenAPI 3.1 JSON:

- Production: `https://havenbackend-production-8a00.up.railway.app/openapi.json`
- Local development: `http://localhost:3001/openapi.json`

The source of truth lives in
[`packages/backend/src/openapi/spec.ts`](../../packages/backend/src/openapi/spec.ts)
and is served by the backend at `/openapi.json`.

## Coverage

The spec covers Haven's public integration surface used by the SDK, MCP
servers, connector, and selected dashboard setup flows:

- agent creation, listing, lookup, and revocation
- Connect Agent setup creation, pairing, registration, install status, and
  rail-aware approval evidence (`wallet-approval` on the legacy rail,
  `budget-approval` on the delegation rail)
- delegate balance inspection
- direct Haven payment intents and signature submission
- `GET /payments/{id}/resume_state` for x402 and MPP resume context
- x402 funding authorization at `POST /x402/authorize`
- the deprecated `POST /x402` alias still used by the current SDK
- machine-payment status/identity/allowance reads under `/machine-payments/*`
  (`POST /machine-payments/authorize`, the legacy internal `mpp_demo` flow, is
  retired — it now documents an unconditional HTTP 410, #1328)
- machine-payment evidence and reconciliation event writes
- machine-payment allowance, receipt, and payment-receipt reads
- direct Safe transfers and delegate sweep recovery
- wallet transaction listing
- catalog discovery
- health and OpenAPI discovery

The SDK's quote and resume helpers are partly client-side by design. For
example, x402 quote probing calls the paid resource, not Haven, and x402
resume retries the original merchant request after `resume_state` is
rehydrated. The OpenAPI contract documents the Haven-hosted endpoints in that
flow, not merchant endpoints or local SDK methods. `resume_state` can still
carry the `mpp` shape for a historical `mpp_demo` payment (the read path is
unchanged), but the SDK no longer exposes a client method that consumes it —
`quoteMpp`/`payMppChallenge`/`resumeMppPayment` are retired along with the
`mpp_demo` authorize flow (#1328).

For catalog discovery specifically, the published `GET /catalog` contract now
includes three read-only query parameters: `category`, `search`, and `rail`.
`category` is matched case-insensitively after trim; `search` matches product
`name`, `description`, or `category`; `rail` keeps its existing filter. This
surface only returns curated metadata and may yield zero or multiple entries.
It never quotes, signs, or authorizes a payment, and catalog prices remain
indicative rather than authoritative.

## Endpoints intentionally not in the spec

Issue [#161](https://github.com/d-hinders/Haven-AI/issues/161) originally
listed `POST /x402/quote` and `POST /x402/resume` as candidate endpoints.
Neither exists in the implementation. The omissions are deliberate:

- **`POST /x402/quote` does not exist** because quoting an x402 endpoint is
  a *client-side* operation. `quoteX402(url, init)` in the SDK probes the
  paid resource directly, parses the HTTP 402 response, and constructs the
  `X402Quote` shape locally. Haven's backend has no role in the quote phase
  — there is nothing to authorize, no balance to check, no allowance to
  evaluate. A `/x402/quote` endpoint would either need to proxy the
  merchant call (a privacy and reliability footgun) or duplicate parsing
  logic Haven already ships in the SDK.

- **`POST /x402/resume` does not exist** because resume is consolidated
  under `GET /payments/{id}/resume_state`. The same rehydration logic
  serves both rails — the response is a discriminated union of
  `X402ResumeState | MppResumeState`. Resume itself (the actual retry with
  `X-PAYMENT`) is a client-side operation in `resumeX402Payment(state)`:
  Haven returns the *state*, and the agent constructs and sends the
  merchant request. A rail-specific resume endpoint would be redundant and
  would fork the schema across rails for no benefit.

Non-TypeScript integrators rebuilding `quoteX402` / `payX402Quote` against
the OpenAPI surface should keep the two signatures distinct:

1. Call the merchant directly to receive the 402 challenge and construct the
   merchant EIP-3009 authorization locally.
2. Call `/x402/authorize` without a funding signature to create the Safe funding
   intent.
3. Sign the returned funding `sign_data` with the delegate key and submit that
   signature to `/payments/{id}/sign`.
4. Wait for the Safe-to-delegate funding transaction to confirm so the merchant
   can observe the funded balance.
5. Retry the merchant request with the separately created `X-PAYMENT` proof.

Resume rehydration uses `GET /payments/{id}/resume_state`, followed by the same
local merchant-proof and retry steps. The deprecated `/x402` alias currently
remains in use by the SDK but has the same funding semantics.

## Drift Check

The backend test suite checks the public contract in CI, surfaced as a
dedicated `OpenAPI drift check` step in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):

- required agent payment paths are present
- `AgentPaymentPhase`, `AgentPaymentNextAction`, and `AgentPaymentRail` enum
  values match the backend taxonomy exports
- a cross-package parity test asserts the backend taxonomy mirror agrees
  with the SDK source of truth (`@haven_ai/sdk`)
- every Fastify route declared in the agent-payment route files
  (`agents.ts`, `agent-connection-setups.ts`, `payments.ts`, `x402.ts`,
  `machine-payments.ts`, `transactions.ts`, and `catalog.ts`) is either
  documented in the spec or listed on an explicit
  `KNOWN_UNDOCUMENTED_ROUTES` allowlist with a justification
- **(#1443)** every route module the server *registers* — not a hand-listed
  subset — is documented, individually justified, or explicitly deferred to the
  #1446 backfill, and the deferred surface is **shrink-only**
  (`route-coverage.test.ts`)
- **(#1444)** selected route tests hand their REAL response payload to
  `expectMatchesSpec` (`openapi/response-shape.ts`), which validates it against
  the spec's own schema with ajv — see *What the response-shape assertion can
  and cannot catch* below
- the security scheme states the authority boundary
- `/openapi.json` serves the same spec object the tests inspect

This is the current round-trip tolerance: generated clients should treat the
OpenAPI enum values and response field names as stable, while SDK-only helpers
such as `quoteX402()` and `resumeX402Payment()` remain documented as local
client behavior.

Issue #161 also calls for a generated-client round-trip check. The current CI
guard remains narrower than that full acceptance criterion: it pins required
paths, taxonomy enum values, served-spec parity, and authority-boundary copy.
Since #984, `openapi-typescript` runs against the spec in earnest: the
frontend's wire types are GENERATED from it (`packages/core/src/api-types.ts`,
via `scripts/generate-api-types.mjs`), and a blocking CI drift check
(`npm run check:api-types`) fails any PR that edits the spec without
regenerating. Editing the spec now changes the dashboard's compile-time types
— an inaccurate spec entry fails the frontend typecheck, which is exactly the
pressure that keeps the contract honest.

### What The Response-Shape Assertion Can And Cannot Catch (#1444)

`check:api-types` compares the spec to types generated FROM that spec. Both
sides derive from one file, so they agree by construction — including when the
spec describes a shape no route returns. Nothing compared the spec to an actual
response until `expectMatchesSpec(method, path, payload)`.

It catches, proven by mutation on `GET /agents/{id}`:

| Mutation applied to the route | Result |
|---|---|
| `status` dropped from the response | fails — `must have required property 'status'` |
| `status` set to a value outside the enum | fails — `must be equal to one of the allowed values` |
| an id that is not a uuid | fails — `must match format "uuid"` |

The uuid case was not hypothetical: wiring `ajv-formats` failed the agents
route test immediately, because its fixture returned `'agent-1'` where the spec
promises a uuid and the database delivers one. Fixtures now use realistic uuids
on the asserted paths.

It does **not** catch an undeclared extra field on a schema that sets
`additionalProperties: true` — `Agent` is one. The helper injects
`additionalProperties: false` only where the schema states no preference, so an
explicitly open schema stays open. That is the spec's decision; tightening it
is a separate contract change, not something a test helper should do behind the
spec's back.

A schema composed with `allOf` is also left open, on purpose. `additionalProperties`
only sees the properties declared at its own level, so closing one `allOf` member
makes it reject the properties its siblings contribute — a valid payload would be
reported as a spec violation. The spec has such shapes (`mpp`,
`AgentConnectionAllowance`); none is on an asserted route yet, which is exactly why
this is guarded by a test now rather than rediscovered as a baffling false failure
during the #1446 backfill.

Coverage is deliberately partial: four assertions today (`GET /agents`,
`GET /agents/{id}`, `POST /agents/{id}/archive`,
`GET /machine-payments/agent`). Widening it is per-route work that belongs with
the #1446 backfill rather than a big-bang sweep.

### Four Contract Corrections The Type Migration Surfaced (#1445)

Making the generated types load-bearing in the frontend is a type-level change
with no runtime effect — but `tsc` acts as a differ between what the spec says
and what the UI had assumed, and it found four places where the spec was wrong
about routes that had shipped long ago:

| Correction | What was wrong |
|---|---|
| `Agent.has_stranded_funds` added | The list and detail reads derive it in SQL and return it; the spec never declared it. Not required — the creation response is built from the inserted row and omits it. |
| `CreateAgentResponse.passport_requested` added | Returned by `POST /agents` on every creation, undeclared. |
| `AgentConnectionInstallStatus.skill_installed` added | The connector reports it and the backend persists it — and that schema is `additionalProperties: false`, so the spec **forbade** a field the API sends. A strict generated client would have rejected a valid response. |
| `CatalogEntry.required` widened from 8 keys to 16 | `serialize()` emits all 16 on every row, nullable ones as `null`. The narrow list made 8 fields optional in the generated type, so the UI defended against a shape the route does not produce. |

The first two went unnoticed because `Agent` sets `additionalProperties: true` —
the same limit recorded above. An open schema is a deliberate choice, but it
means undeclared fields accumulate silently, and consumers generating clients
from the spec never learn the fields exist.

`DelegateBalance` was also lifted out of the inline
`/agents/{id}/delegate-balance` response into a named component. An inline
schema generates an anonymous type, which is precisely why the frontend
hand-wrote a copy instead of importing one.

**The same thing happened again with re-key, and the gate caught it (#1701).**
The six #1698 routes were documented in the same PR that added them, but their
response bodies were written **inline** — so when the dashboard came to render
them there was still no importable type, and the hook hand-wrote five. The
wire-type ratchet (#1447) refused the PR, which is the gate doing exactly its
job: a route being *in the spec* is not the same as its shapes being
*importable*, and only the second one stops a restatement. `AgentRekeyPreflight`,
`AgentRekeyIssuedDelegation`, `AgentRekeyIssueResponse`,
`AgentRekeyCompleteResponse` and `AgentRekeyResidual` are now named components
and the paths `$ref` them, so there is one definition rather than two.

Worth generalising, because documenting a route and lifting its shapes are
different acts and the second is the one a renderer needs: **a response body a
client will render belongs in `components/schemas`, not inline.** The
exception is honest and narrow — `POST /agents/{id}/rekey/{rekeyId}/revoke`
stays an open object, because it carries a bundler-shaped UserOperation the
client only relays back verbatim, and inventing a narrower type would be a
second, weaker contract. That one is marked `ui-local` at the call site with
that reason.

## Authentication And Authority Boundaries

The contract exposes three authentication schemes:

- `AgentApiKey` identifies an agent on payment and read surfaces.
- `DashboardJwt` authenticates the user for account management, setup, and
  dashboard read operations. Since #984 the dashboard read surface is
  documented in the spec itself (tag `Dashboard`: `/dashboard/overview`,
  `/balances/{safeAddress}`, `/portfolio/{safeAddress}`,
  `/transactions/filters`, `/transactions/{safeAddress}`,
  `/safe/{safeAddress}/details`) — it is the source for the frontend's
  generated response types, so it must describe what the routes actually
  emit, not an idealization (e.g. `from`/`to` can be the empty string;
  `amountSek` is present on enriched rows).
- `SetupToken` is a narrowly scoped, expiring connector pairing credential.

Authentication does not itself create payment authority. For agent payments,
the non-custodial boundary is:

```text
API key = identity
delegate signature = authority
on-chain Safe allowance = enforcement
```

An API-key-only caller cannot move funds. Haven never receives the delegate
private key. Dashboard JWT and setup-token operations cannot create signatures
or bypass the user-approved on-chain budget. `GET /payments/{id}/resume_state`
returns stored context only; it does not sign, execute, relay, or expand payment
authority.

### Delegation rail

The enforcement clause above (`on-chain Safe allowance = enforcement`) is the
**legacy AllowanceModule rail** (import-only, existing accounts; the Smart
Sessions session rail is retired, #834 — `session_key` accounts get HTTP 410
from `POST /payments`). On the **delegation rail** (new accounts,
`account_type='delegator_hybrid'`, epic #821) the `API key = identity` and
`delegate signature = authority` clauses are identical, but enforcement is a
signed MetaMask delegation redeemed via the DelegationManager with audited caveat
enforcers (period budget, recipient pin, expiry) — not a Safe allowance. The
agent-facing contract is the same `POST /payments` → `POST /payments/{id}/sign`
shape; only the returned `sign_data` scheme differs (`eip712_userop` typed data
the account validates verbatim, vs an AllowanceModule transfer hash). Delegation
lifecycle lives under `/agents/{id}/delegations/*` (build/activate/revoke) and
account provisioning under `POST /accounts/hybrid`.

The agent-facing spend-authority read is rail-aware (#1135):
`GET /machine-payments/allowances` returns the on-chain AllowanceModule
snapshot on the legacy rail, the ACTIVE budget delegations (same #1090
derivation the dashboard uses; remaining = the period budget) on the
delegation rail in the same response shape, and the #993 fail-closed 410 for
retired `session_key` accounts. The SDK derives its `readiness` signal from
this endpoint, so both rails report honest spendability. On the delegation
rail, each `onchain` row also carries an additive, optional
`remaining_is_from_chain` boolean (#1319): true when `remaining` came from a
live on-chain enforcer read, false when that read failed and `remaining` is
the #1145 fallback (the full configured budget) — reporting only, absent on
the legacy rail. `haven_prepare_catalog_purchase` (#1306) reads it to warn
when the figure it is using is optimistic; see
[`04-x402-payment-sequence.md`](04-x402-payment-sequence.md).

Every delegation-rail route is now in the spec, including the settlement route
`POST /x402/{id}/settle` (#830). It sat on the drift check's
`KNOWN_UNDOCUMENTED_ROUTES` allowlist for a long time on the strength of a
promise that a docs sweep (#834) would cover it; that issue closed without
doing so, and #1446 documented it instead — a reminder that an exclusion
justified by future work outlives the work unless something re-checks it. That
allowlist is now empty. Deep model:
[`docs/security/delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

**How much of the API the spec actually describes (#1443, measured 2026-08-15; total re-counted 2026-08-21 for #1698):**
144 registered routes, **2 of them undocumented** — only safe-deploy.ts and safe-exec.ts, deliberately, under the #1440 Safe-rail retirement. (#1698's six re-key routes were documented in the same PR that added them, which is the gate working as intended: the undocumented count is shrink-only, so a new route module has nowhere to hide. Note that only the undocumented count is enforced — the TOTAL here is prose and goes stale silently with every route added, so re-count it rather than trusting it.)
(#1446 is working the backfill one domain at a time: `contacts.ts` came off the
list first, then the whole `agent-delegations.ts` lifecycle — grant, activate,
per-hash and batch revocation, signer management — then the x402 demo-resource
surface, the Agent Passport routes and the Safe-management surface, taking the
ceilings from 18 modules / 90 routes to 2 / 2 — the backfill is complete except for the two Safe-rail routes #1440 retires.) That was invisible until the
coverage gate widened its scope beyond the seven hand-listed files above, which
is the finding epic #1442 was opened on. The gap is now *recorded* rather than
absent: `route-coverage.ts` carries a per-module deferral list with a reason per
entry and a shrink-only ceiling, and #1446 documents the modules one domain at a
time. Read the numbers there as the current truth; this paragraph is a pointer,
not a second copy.
