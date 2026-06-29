---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-29"
---

# Backend / API playbook

Loaded by `/ship-next` for `area:backend` issues.

- **OpenAPI drift.** Keep `packages/backend/src/openapi/spec.test.ts` green — a route on the agent-payment surface must be documented in `openapi/spec.ts` or carry a `because:` entry in the allowlist. Adding a route means updating the spec.
- **Package gate.** `npm run typecheck -w packages/backend` and `npm run test -w packages/backend` must pass.
- **Money path.** If the change touches `routes/x402.ts`, `routes/x402-resources.ts`, `routes/payments.ts`, `routes/machine-payments.ts`, `lib/{machine-payments,payment-coverage,allowance-module}.ts`, `middleware/agentAuth.ts`, `db/migrations/`, or any other file in the skill's Phase 6 money-path list, also load [`money.md`](money.md) — characterization tests first, human merge gate. (Phase 6 in `ship-next.md` is the authoritative list.)
- **Docs.** If the diff touches code a doc's `covers:` maps to, the coupling gate flags it; update those docs (see [`docs.md`](docs.md)).
