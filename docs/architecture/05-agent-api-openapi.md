# Haven Agent API OpenAPI Contract

Haven publishes the agent payment API as OpenAPI 3.1 JSON:

- Production: `https://havenbackend-production-8a00.up.railway.app/openapi.json`
- Local development: `http://localhost:3001/openapi.json`

The source of truth lives in
[`packages/backend/src/openapi/spec.ts`](../../packages/backend/src/openapi/spec.ts)
and is served by the backend at `/openapi.json`.

## Coverage

The spec covers the agent-facing payment surface used by the SDK and MCP
server:

- agent creation, listing, lookup, and revocation
- direct Haven payment intents and signature submission
- `GET /payments/{id}/resume_state` for x402 and MPP resume context
- x402 funding authorization at `POST /x402/authorize`
- the legacy `POST /x402` alias used by older SDK clients
- MPP demo authorization and status under `/machine-payments/*`
- machine-payment allowance and receipt reads
- wallet transaction listing
- health and OpenAPI discovery

The SDK's quote and resume helpers are partly client-side by design. For
example, x402 quote probing calls the paid resource, not Haven, and x402/MPP
resume retries the original merchant request after `resume_state` is
rehydrated. The OpenAPI contract documents the Haven-hosted endpoints in that
flow, not merchant endpoints or local SDK methods.

## Drift Check

The backend test suite checks the public contract in CI:

- required agent payment paths are present
- `AgentPaymentPhase`, `AgentPaymentNextAction`, and `AgentPaymentRail` enum
  values match the backend taxonomy exports
- the security scheme states the authority boundary
- `/openapi.json` serves the same spec object the tests inspect

This is the current round-trip tolerance: generated clients should treat the
OpenAPI enum values and response field names as stable, while SDK-only helpers
such as `quoteX402()` and `resumeX402Payment()` remain documented as local
client behavior.

## Non-Custodial Boundary

The OpenAPI security scheme is intentionally narrow:

```text
API key = identity
delegate signature = authority
on-chain Safe allowance = enforcement
```

An API-key-only caller cannot move funds. Haven never receives the delegate
private key. `GET /payments/{id}/resume_state` returns stored context only; it
does not sign, execute, relay, or expand payment authority.
