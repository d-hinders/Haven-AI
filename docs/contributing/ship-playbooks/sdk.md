---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-30"
---

# SDK / API / credentials playbook

Loaded by `ship-next` for `area:sdk` and `area:mcp` issues — the published packages (`@haven_ai/{sdk,signer,mcp,connect}`), the agent API contract, and credential surfaces. The playbook **links** the canonical procedures; it does not restate them.

## 1. Required reading

- [`docs/operations/mcp-runtime-compatibility.md`](../../operations/mcp-runtime-compatibility.md) — the runtime-compatibility checklist for MCP / signer / connect.
- [`scripts/README.md`](../../../scripts/README.md) — the release procedure, for any version-affecting change.

## 2. Keep generated artifacts in sync

When SDK/API behavior, credential semantics, x402/MPP behavior, setup prompts, or product language change, regenerate **and review** the artifacts that mirror them: `.env` examples, SDK snippets, credential files, demo scripts, and skill bundles. Apply the CASP guardrails to these too — they must not imply Haven holds funds, controls keys, or that an API credential is sufficient to spend (see [`money.md`](money.md)).

## 3. Contract & release integrity

- **OpenAPI drift** — keep `packages/backend/src/openapi/spec.test.ts` green; a documented agent-payment route must be in the spec or the `because:` allowlist.
- **Install-path** — `connect`/`mcp`/`sdk` changes run the install smoke (`npm run smoke:pack -w packages/connect`); don't break the packed tarball resolution.
- **Versioning** — never hand-edit version fields or cross-package dep pins; `scripts/release-bump.mjs` is the single source of truth, and pinning an internal `@haven_ai/*` dep to a wildcard is forbidden.

## 4. Merge

`area:sdk` / `area:mcp` PRs are non-money and auto-merge on green CI + clean review — **unless** the change also touches a money-path file or release tooling (`scripts/release-bump.mjs`, `.github/workflows/publish.yml`), which the canonical skill's [Merge Gate](../../../.agents/skills/ship-next/SKILL.md#merge-gate) routes to in-session approval. Only database migrations are additionally hard-gated by `.github/CODEOWNERS`.
