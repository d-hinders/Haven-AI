---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-08-19" # #1607: published set corrected to five (cli was missing), wildcard-pin rule updated to the #1526 two-direction form; every other claim re-read against the current release process and stands
---

# SDK / API / credentials playbook

Loaded by `ship-next` for `area:sdk` and `area:mcp` issues — the published packages (`@haven_ai/{sdk,signer,mcp,connect,cli}`), the agent API contract, and credential surfaces. The playbook **links** the canonical procedures; it does not restate them.

## 1. Required reading

- [`docs/operations/mcp-runtime-compatibility.md`](../../operations/mcp-runtime-compatibility.md) — the runtime-compatibility checklist for MCP / signer / connect.
- [`scripts/README.md`](../../../scripts/README.md) — the release procedure, for any version-affecting change.

## 2. Keep generated artifacts in sync

When SDK/API behavior, credential semantics, x402/MPP behavior, setup prompts, or product language change, regenerate **and review** the artifacts that mirror them: `.env` examples, SDK snippets, credential files, demo scripts, and skill bundles. Apply the CASP guardrails to these too — they must not imply Haven holds funds, controls keys, or that an API credential is sufficient to spend (see [`money.md`](money.md)).

## 3. Type-check tests, last

Run the package `typecheck` (`tsc --noEmit`) as the **final** gate step, after every test file is written or edited. `vitest`/`tsx` strip types and do NOT type-check — a green test run says nothing about type errors in the test itself. `tsc` is the only thing that checks `*.test.ts`; a wrong config field or stale mock shape fails CI's typecheck but never the test run (the #776 miss — a test built the client with `apiUrl` instead of `baseUrl`, passed vitest, red CI). Both `npm run typecheck -w <pkg>` and `cd <pkg> && npx tsc --noEmit` include test files.

## 4. Contract & release integrity

- **OpenAPI drift** — keep `packages/backend/src/openapi/spec.test.ts` green; a documented agent-payment route must be in the spec or the `because:` allowlist.
- **Install-path** — `connect`/`mcp`/`sdk` changes run the install smoke (`npm run smoke:pack -w packages/connect`); don't break the packed tarball resolution.
- **Versioning** — never hand-edit version fields or cross-package dep pins; `scripts/release-bump.mjs` is the single source of truth. The internal-pin rule runs in **both directions** (#1526): wildcard pins are forbidden in the five **published** packages (sdk/signer/mcp/connect/cli), while **private workspace consumers** (`private: true` — backend, frontend, qa-agent, mcp-server) MUST pin `"*"` so npm always links the workspace. `npm run lint:workspace-pins` enforces both on every PR; the dividing line and its rationale live in CLAUDE.md § *Releasing & publishing packages*.

## 5. Merge

`area:sdk` / `area:mcp` PRs auto-merge on green CI + clean review. A change that also touches a money-path file or release tooling (`scripts/release-bump.mjs`, `.github/workflows/publish.yml`) is classified `money-path` — which loads `money.md` and its characterization-test bar, but does not pause the merge (#1024). Only database migrations are hard-gated, by `.github/CODEOWNERS`.
