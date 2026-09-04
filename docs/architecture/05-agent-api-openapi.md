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
  - packages/backend/src/domain/request-origin.ts
  - packages/backend/src/middleware/auth.ts
  - packages/backend/src/middleware/agentAuth.ts
last-verified: "2026-09-04" # #2530: new § *Discoverability from a bare URL* — the three unauthenticated surfaces, the request-derived `servers[0]`, the two things the origin helper deliberately does NOT do (the trust-gated host with an UNgated scheme, and the path prefix it cannot infer because the frontend rewrite strips `/api` before the backend sees it — measured as a 404, not assumed), the 401 `hint` with the two constraints it must not break (#1640 body identity; the uniform invalid-key string), and the public catalogue allow-list. Three new `covers:` entries. Scope: that section and the front matter — the coverage tables, the drift check and the authority-boundaries section were not re-read. Prior: chain-reset(#2542): scoped re-count after the documented health routes; prior notes remain in git history.
---

# Haven Agent API OpenAPI Contract

Haven publishes the agent payment API as OpenAPI 3.1 JSON:

- Production: `https://havenbackend-production-8a00.up.railway.app/openapi.json`
- Local development: `http://localhost:3001/openapi.json`

The source of truth lives in
[`packages/backend/src/openapi/spec.ts`](../../packages/backend/src/openapi/spec.ts)
and is served by the backend at `/openapi.json`.

## Discoverability from a bare URL (#2530)

An agent handed only a backend URL has three things to read, none of which need
a credential:

| Surface | What it gives |
| --- | --- |
| `GET /` | The root document: what this service is, the absolute URL of its OpenAPI spec, which credential each door wants, and the health path. |
| `GET /openapi.json` | The machine-readable contract. |
| `GET /catalog` | The merchant catalogue, in a reduced public shape — see below. |

**The root document is deliberately thin.** Names, paths, and credential
guidance — no version, build identifier or environment name. A service banner
that fingerprints the deployment is a gift to a scanner and buys an agent
nothing.

**`servers[0]` is derived from the request, not read from the static list.**
The static list named the production Railway host first, always, so the dev
backend served a spec telling clients to call production. Production stays
listed as the documented second entry. The origin comes from
`packages/backend/src/domain/request-origin.ts`, which is also what builds the
connector command and the root document's own URLs — one answer, three
surfaces.

Two things that helper does **not** do, both recorded because they look like
omissions:

- It honours `x-forwarded-host` only when `TRUST_PROXY_HOPS > 0`. The header is
  client-supplied, and trusting it unconditionally lets a caller choose the
  host this service names in its own contract. The **scheme** is deliberately
  not gated: the host is the spoofable target, while gating the scheme would
  make every TLS-terminating deployment that has not set the variable advertise
  `http://` for its own API.
- It cannot infer a path prefix. The frontend proxies `/api/:path*` and its
  rewrite **strips** the prefix before the backend sees the path — measured:
  `GET /api/openapi.json` against the backend is a 404. A deployment that wants
  its spec to advertise `https://preview.example/api` sets `HAVEN_API_URL` to
  exactly that. A stated fact, not an inference, is the right shape for
  something a client will call.

**401s name the credential they want.** `authMiddleware` and
`agentAuthMiddleware` add a `hint` alongside the unchanged `error` string. Two
constraints hold: the #1640 rule that a purpose-scoped token gets a body
**identical** to a failed verification (the bodies are shared constants, so the
identity is structural rather than remembered), and the uniformity of
`Invalid or revoked API key` across archived, revoked, unknown-status and
no-such-key — the hint must not say which, or it puts back the distinction the
single error string exists to hide.

**`GET /catalog` reads without a credential, in a reduced shape.** The
catalogue is a discovery surface by design (#1717) and used to answer 401,
which meant an agent could not find a payable merchant until after the
onboarding the catalogue was supposed to lead to. The public shape is an
**allow-list** (`PUBLIC_CATALOG_FIELDS`) and a test fails on any key outside
it, so the exposure is reviewable as a list. It gives the endpoint **host**,
not the full callable URL, and withholds prices and tool-invocation detail: an
agent that intends to pay holds a credential by then. Every other catalogue
route still requires one, and a caller presenting a **bad** credential still
gets its 401 rather than a silent downgrade — serving a reduced answer to a
revoked agent would hide the revocation from the only party who would notice.
There is no per-agent or per-user data in `merchant_catalog` to leak; every
column is merchant metadata, which somebody checked rather than assumed.

## Coverage

The spec covers Haven's public integration surface used by the SDK, MCP
servers, connector, and selected dashboard setup flows:

- agent creation, listing, lookup, and revocation
- Connect Agent setup creation, pairing, registration, install status, and
  approval evidence (`budget-approval`; the legacy `wallet-approval` route was
  deleted with the Safe rail in #2259)
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
- delegate sweep recovery (direct Safe transfers via `POST /machine-payments/send`
  are RETIRED — the operation documents only its 410/422 refusals, #1987/#2105)
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

The sibling `POST /catalog/submit` is a public, unauthenticated self-service
submission endpoint (epic #1717, #1711): it writes a queue row and returns an
`id` plus a `verify_token`, and the request path makes **no outbound request of
any kind** — no probe, no quote, no signature, no payment. Submission is not
listing: the seller must first prove domain control (well-known token / DNS
TXT, #1712), then a leader-locked, SSRF-hardened, read-only probe must watch a
live 402 challenge on the endpoint (#1713) before an entry can appear in
`GET /catalog`. Until that pipeline completes, `active` keeps its #1669
meaning: it says the merchant answers the 402 challenge, never that it settles.

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

  > Everything above is about endpoint SHAPE and is unchanged. Separately,
  > **`resumeX402Payment()` completes when its trigger fires** (#2145): the
  > guard requires `next_action: retry_original_x402_request`, which the
  > status projection emits for a confirmed eip3009 payment whose merchant
  > leg was never reported (funded-but-undelivered), and throws otherwise.
  > The rehydration half — `GET /payments/{id}/resume_state` — is a plain
  > read with no status precondition. Full analysis:
  > [`04-x402-payment-sequence.md` § *Resuming An Authorized Payment*](04-x402-payment-sequence.md#resuming-an-authorized-payment).

Non-TypeScript integrators rebuilding `quoteX402` / `payX402Quote` against
the OpenAPI surface should keep the two signatures distinct:

1. Call the merchant directly to receive the 402 challenge and construct the
   merchant EIP-3009 authorization locally.
2. Call `/x402/authorize` without a funding signature to create the funding
   intent.
3. Sign the returned funding `sign_data` with the delegate key and submit that
   signature to `/payments/{id}/sign`.
4. Wait for the funding transaction to confirm so the merchant can observe the
   funded balance. On the delegation rail that transaction redeems the agent's
   **budget delegation** to fund the delegate wallet — it is not a Safe
   transfer, and this step applies only to the EIP-3009 bridge; erc7710 direct
   settlement has no funding leg at all.
5. Retry the merchant request with the separately created payment proof, setting BOTH
   `PAYMENT-SIGNATURE` (x402 v2) and `X-PAYMENT` (v1) to it — a strict v2 merchant reads
   only the first.

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
  with the SDK source of truth (`@haven_ai/sdk`) — since **#2262** on the
  per-value DESCRIPTIONS as well as the values, because the served spec now
  publishes them
- **(#2262)** `AgentPaymentPhase` and `AgentPaymentNextAction` carry
  `x-enumDescriptions` in the served spec, so the five retired approval values
  (`user_approval_required`, `user_execution_required`,
  `waiting_for_additional_approvals`, `wait_for_user_approval`,
  `wait_for_user_to_complete_payment`) state their own retirement to a raw-API
  integrator. They remain in the `enum` for wire compatibility; nothing
  produces them. Before #2262 `x-enumDescriptions` appeared **zero** times in
  `/openapi.json` — the prose existed only in the SDK's exported schema
  fragments, so an SDK user was warned and an integrator reading the contract
  of record was not
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
`/agents/{id}/delegate-balance` response into a named component. The frontend
now imports the generated `ApiSchema<'DelegateBalance'>` type, so the OpenAPI
component is the load-bearing source for that response shape.

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
client will render belongs in `components/schemas`, not inline.**

`POST /agents/{id}/rekey/{rekeyId}/revoke` was the one exception, left as an
open object because it carries a bundler-shaped UserOperation the client only
relays back verbatim. #1870 removed the exception rather than narrowing it,
because the exception turned out to be load-bearing in the wrong direction:
that response now has to tell the client **which signature scheme** the server
resolved, and an open object cannot say so. It is `AgentRekeyRevokePrepare` — a
`oneOf` over the EIP-712 branch, the WebAuthn branch and the no-authority
short-circuit, discriminated by `signature_scheme`.

The narrow exception that survives is one **field**: the nested
`user_operation` stays `additionalProperties: true`, which is the same
treatment its sibling `POST /agents/{id}/delegations/revoke-all` already gave
it. Scope an open shape to the part that is genuinely opaque; an open
*envelope* hides the fields a client must branch on.

That principle had one more envelope to collect, found by #2400 rather than by
this section: **`PUT /agents/{id}` declared `{ type: 'object',
additionalProperties: true }`** while returning the same payload as
`GET /agents/{id}`, so a round trip against it proved only "is an object". It
now carries `$ref: Agent`. Measured on that change: with the route dropping a
required field, the open envelope passed the suite 23/23 and the `$ref`
version failed naming `status` — the envelope was not merely imprecise, it was
inert.

**Two response-level open shapes are left, and neither is accidental**, so read
the rule as "no *accidental* open envelope" rather than "none":

- `POST /payments`' `200` idempotent replay is an `AgentPaymentStatus` plus
  `idempotent_replay: true`, and that schema is `additionalProperties: false`,
  so a strict `$ref` would be a claim the route does not honour. Its spec entry
  says so in its own description.
- `GET /openapi.json`'s `200` returns this document. There is no useful schema
  for "an OpenAPI document" that the spec could hold about itself, so the open
  shape is the honest one.

Count the pattern, not the prose, if you re-check this: the literal is
`schema: { type: 'object', additionalProperties: true }`, and a first pass at
this section reported **one** because its regex required no trailing comma —
`/openapi.json` writes the property across lines and ends it with one. Both
reviewers caught it. Two, as of #2400.

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
on-chain budget delegation = enforcement
```

This restates the `AgentApiKey` security-scheme description, which is attached
to every agent-authenticated operation — 26 of the document's 134, the rest
being `DashboardJwt`, `SetupToken` or public. (The description itself is prose;
the block above is a three-line paraphrase of its middle sentence.) #2105 moved
the third clause off
the retired primitive: it read `on-chain Safe allowance = enforcement`, naming
the AllowanceModule the whole of epic #1440 retired. Enforcement is the agent's
owner-signed budget delegation — its audited caveat enforcers, checked by the
DelegationManager at redemption. The first two clauses are unchanged.

An API-key-only caller cannot move funds. Haven never receives the delegate
private key. Dashboard JWT and setup-token operations cannot create signatures
or bypass the user-approved on-chain budget. `GET /payments/{id}/resume_state`
returns stored context only; it does not sign, execute, relay, or expand payment
authority.

### Delegation rail

The enforcement clause above named the **legacy AllowanceModule rail** until
#2105 corrected it. That rail is **RETIRED** (#1440): closed to new
accounts (#1984), HTTP 410 on every payment and x402 entry point (#1986), and its
machinery deleted (#1987/#1988/#1989). Existing Safe accounts stay READABLE but
cannot spend through Haven's retired payment/API paths; any residual AllowanceModule
permission remains outside Haven until the Safe owner revokes it externally. The Smart Sessions
session rail is retired too (#834) — `session_key` accounts get HTTP 410 from
`POST /payments`. On the **delegation rail** — the only rail that can pay
(`account_type='delegator_hybrid'`, epic #821) the `API key = identity` and
`delegate signature = authority` clauses are identical, but enforcement is a
signed MetaMask delegation redeemed via the DelegationManager with audited caveat
enforcers (period budget, recipient pin, expiry) — not a Safe allowance. The
agent-facing contract is the same `POST /payments` → `POST /payments/{id}/sign`
shape; only the returned `sign_data` scheme differs (`eip712_userop` typed data
the account validates verbatim, vs an AllowanceModule transfer hash). Delegation
lifecycle lives under `/agents/{id}/delegations/*` (build/activate/revoke) and
account provisioning under `POST /accounts/hybrid`.

The agent-facing spend-authority read is rail-aware (#1135):
`GET /machine-payments/allowances` returns the ACTIVE budget delegations
(same #1090 derivation the dashboard uses; remaining = the period budget) on
the delegation rail, and the fail-closed 410 on BOTH retired rails — session
(`session_key`, #993) and, since #2020 reversed #1986's left-readable
decision, the legacy AllowanceModule rail too. The SDK derives its `readiness` signal from
this endpoint, so both rails report honest spendability. On the delegation
rail, each `onchain` row also carries an additive, optional
`remaining_is_from_chain` boolean (#1319): true when `remaining` came from a
live on-chain enforcer read, false when that read failed and `remaining` is
the #1145 fallback (the full configured budget) — reporting only. The spec used
to add "absent on the legacy rail"; #2105 dropped that clause as a consequence
of the 410 above, since a legacy-rail account no longer receives this summary at
all. `haven_prepare_catalog_purchase` (#1306) reads it to warn
when the figure it is using is optimistic; see
[`04-x402-payment-sequence.md`](04-x402-payment-sequence.md).

### `allowance_amount` Is Two Shapes, And The Spec Now Says Which (#2295)

One field name carries two incompatible wire shapes. This was tribal knowledge
until #2295; #2283 was what it cost, when `/agents` shipped a raw
`"250.000000 USDC per week"` to production because a display helper
discriminated between the shapes by catching a `BigInt` throw.

| schema | shape | emitted by |
|---|---|---|
| `AgentConnectionAllowanceInput` / `AgentConnectionAllowance` | **atomic** integer string (`"25000000"` = 25 USDC) | `POST /agent-connection-setups`, and read back verbatim as `agent_budget[]` by `GET /agent-connection-setups/*` |
| `AgentAllowance` (on `Agent.allowances`) | **human-decimal** (`"25.00"`, or a bare `"0"`) | `GET /agents`, `GET /agents/{id}`, `PUT /agents/{id}` (there is no `PATCH` — #2392); `POST /agents` carries the same schema as a literal empty array |

Both are now named schemas — `allowanceAtomicAmount` and
`allowanceHumanAmount` in `openapi/spec.ts` — each with its own pattern and a
description naming the unit, so a consumer reads the shape off the contract
instead of the route that builds it. The generated `packages/core/src/api-types.ts`
carries those descriptions as JSDoc on the field itself.

Two things follow that a reader should not have to derive:

- **The human shape has exactly one producer.** `rails/delegation-budget-view.ts`
  builds it with `formatTokenValue(row.budget_atomic, decimals)`, and since #2020
  that view is the only source of an `allowances` array anywhere —
  `agent_allowances` is read nowhere, and since #2263's migration 075 the table
  does not exist at all. Its production callers are exactly five —
  `GET /agents`, `GET /agents/{id}`, `PUT /agents/{id}`, `GET /dashboard/overview`
  and `GET /machine-payments/allowances` (#2392 corrected the view's own header,
  which named a `PATCH /agents/{id}` that never existed). `GET /dashboard/overview`
  carries the same value as `allowanceAmount`, which since #2400 is the named
  `allowanceHumanAmount` on `DashboardAgentAllowance` rather than a bare
  `string` (the generated TypeScript type is still `string` — the schema is
  what changed).

  **Since #2408 the pattern also DISCRIMINATES.** Because that one producer's
  output set is narrower than a bare integer — `formatTokenValue` returns `'0'`
  or `<integer>.<2–6 fraction digits>`, for any `decimals >= 0` — the human
  pattern is `^(0|[0-9]+\.[0-9]{2,6})$`, which rejects `'500'`, `'1000000'` and
  every other atomic value except `'0'`. That closes a measured hole rather
  than a theoretical one: #2392 watched a view emitting the atomic
  `budget_atomic` **pass** the `GET /dashboard/overview` round trip, caught only
  by the hand-written `'1.00'` literal in
  `routes/__tests__/dashboard.test.ts`. That literal stays, now as
  belt-and-braces rather than as the sole guard; the round trip pins the field
  set, types and uuid formats as before, and the creation response
  (`POST /agents`, `allowances: []`, no view call) is round-tripped against
  `CreateAgentResponse` the same way.

  Two limits on what that buys, since a guard oversold is a guard misused.
  `'0'` is legal in both shapes and always will be — it is the same number
  either way. And discrimination here is an assertion about what one known
  emitter produces, not a property a string carries: **a consumer must still
  never sniff the shape at runtime.** A future emitter bypassing
  `formatTokenValue` is a spec violation the pattern now catches, not a new
  legal shape. `openapi/spec.test.ts` pins the produced set against
  `formatTokenValue` itself so the premise is measured on every run.
- **`GET /machine-payments/allowances` reports the same budget twice.**
  `configured_amount` is the human projection; the sibling `onchain.amount`
  (with `spent`, `remaining`, `effective_spent`) is atomic from `budget_atomic`.
  Both are typed and described as of #2295; confusing them is an error of
  `10 ** decimals`.

**The shapes themselves are unchanged, deliberately.** Unifying them is a
breaking wire change for every `/agents` consumer, so #2295 made the split
legible rather than closing it; the decision is recorded on that issue.

Every delegation-rail route is now in the spec, including the settlement route
`POST /x402/{id}/settle` (#830). It sat on the drift check's
`KNOWN_UNDOCUMENTED_ROUTES` allowlist for a long time on the strength of a
promise that a docs sweep (#834) would cover it; that issue closed without
doing so, and #1446 documented it instead — a reminder that an exclusion
justified by future work outlives the work unless something re-checks it. That
allowlist is now empty. Deep model:
[`docs/security/delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).

**How much of the API the spec actually describes (#1443, measured 2026-08-15; total re-counted 2026-08-24 for #1988):**
131 registered routes, **2 of them undocumented** — only safe-deploy.ts and safe-exec.ts, deliberately, under the #1440 Safe-rail retirement. Re-counted 2026-09-04 after #2542 added documented public `/health` and operator-only `/health/ops` routes; the live delegation-rail x402 routes remain registered. (#1698's six re-key routes were documented in the same PR that added them, which is the gate working as intended: the undocumented count is shrink-only, so a new route module has nowhere to hide. Note that only the undocumented count is enforced — the TOTAL here is prose and goes stale silently with every route added, so re-count it rather than trusting it.)
(#1446 is working the backfill one domain at a time: `contacts.ts` came off the
list first, then the whole `agent-delegations.ts` lifecycle — grant, activate,
per-hash and batch revocation, signer management — then the x402 demo-resource
surface, the Agent Passport routes and the Safe-management surface, taking the
ceilings from 18 modules / 90 routes to 2 / 2 — the backfill is complete except for the two Safe-rail routes #1440 retires. #1988 removed five approver routes outright, which is why the total moved 145 → 140 while the undocumented count held at 2 — a reminder that the total is prose and only ever right on the day someone re-counts it.) That was invisible until the
coverage gate widened its scope beyond the seven hand-listed files above, which
is the finding epic #1442 was opened on. The gap is now *recorded* rather than
absent: `route-coverage.ts` carries a per-module deferral list with a reason per
entry and a shrink-only ceiling, and #1446 documents the modules one domain at a
time. Read the numbers there as the current truth; this paragraph is a pointer,
not a second copy.
