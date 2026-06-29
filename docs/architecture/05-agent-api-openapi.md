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
  - packages/backend/src/routes/transactions.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/types.ts
  - packages/backend/src/lib/agent-payment-taxonomy.ts
  - packages/backend/src/lib/agent-payment-taxonomy.parity.test.ts
  - .github/workflows/ci.yml
last-verified: "2026-06-29"
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
  wallet-approval evidence
- delegate balance inspection
- direct Haven payment intents and signature submission
- `GET /payments/{id}/resume_state` for x402 and MPP resume context
- x402 funding authorization at `POST /x402/authorize`
- the deprecated `POST /x402` alias still used by the current SDK
- MPP demo authorization and status under `/machine-payments/*`
- machine-payment evidence and reconciliation event writes
- machine-payment allowance, receipt, and payment-receipt reads
- direct Safe transfers and delegate sweep recovery
- wallet transaction listing
- catalog discovery
- health and OpenAPI discovery

The SDK's quote and resume helpers are partly client-side by design. For
example, x402 quote probing calls the paid resource, not Haven, and x402/MPP
resume retries the original merchant request after `resume_state` is
rehydrated. The OpenAPI contract documents the Haven-hosted endpoints in that
flow, not merchant endpoints or local SDK methods.

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
- the security scheme states the authority boundary
- `/openapi.json` serves the same spec object the tests inspect

This is the current round-trip tolerance: generated clients should treat the
OpenAPI enum values and response field names as stable, while SDK-only helpers
such as `quoteX402()` and `resumeX402Payment()` remain documented as local
client behavior.

Issue #161 also calls for a generated-client round-trip check. The current CI
guard remains narrower than that full acceptance criterion: it pins required
paths, taxonomy enum values, served-spec parity, and authority-boundary copy.
A deeper `openapi-typescript` comparison remains a follow-up before treating
the spec as a complete generated-client compatibility gate.

## Authentication And Authority Boundaries

The contract exposes three authentication schemes:

- `AgentApiKey` identifies an agent on payment and read surfaces.
- `DashboardJwt` authenticates the user for account management, setup, and
  dashboard read operations.
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
