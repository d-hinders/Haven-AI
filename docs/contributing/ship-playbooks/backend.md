---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-07-03"
---

# Backend / API playbook

Loaded by `ship-next` for `area:backend` issues.

- **OpenAPI drift.** Keep `packages/backend/src/openapi/spec.test.ts` green — a route on the agent-payment surface must be documented in `openapi/spec.ts` or carry a `because:` entry in the allowlist. Adding a route means updating the spec.
- **Package gate.** `npm run typecheck -w packages/backend` and `npm run test -w packages/backend` must pass. **Run `typecheck` as the LAST step, after every test file is written or edited** — `vitest`/`tsx` strip types and do NOT type-check, so a green test run says nothing about type errors in the test itself. `tsc` is the only thing that checks `*.test.ts`; a type error there (a wrong config field, a stale mock shape) fails CI's typecheck but never the test run (#781, the #776 miss).
- **SQL schema drift.** When the diff adds or changes a money-path query, add it to the curated list in `packages/backend/scripts/db-schema-smoke.ts` — CI applies the migrations and `PREPARE`s each query against a real Postgres, so a column/type mismatch fails in CI instead of dev (mocked route tests never validate SQL against the schema — how `agents.safe_address` reached dev, #757). Run locally against a throwaway DB with `DATABASE_URL=… npm run db:schema-smoke -w packages/backend`.
- **Money path.** If the change touches `routes/x402.ts`, `routes/x402-resources.ts`, `routes/payments.ts`, `routes/machine-payments.ts`, `lib/{machine-payments,payment-coverage,allowance-module}.ts`, `middleware/agentAuth.ts`, `db/migrations/`, or any other file in the canonical skill's [Merge Gate](../../../.agents/skills/ship-next/SKILL.md#merge-gate), also load [`money.md`](money.md) — characterization tests first, human approval gate.
- **Docs.** If the diff touches code a doc's `covers:` maps to, the coupling gate flags it; update those docs (see [`docs.md`](docs.md)).
