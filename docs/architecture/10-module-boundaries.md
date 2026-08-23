---
owner: "@d-hinders"
status: current
covers:
  - .dependency-cruiser.cjs
  - scripts/dep-lint.mjs
  - packages/core/src/**
  - packages/backend/src/index.ts
  - packages/backend/src/db.ts
  - packages/backend/src/rails/execution-rail.ts
  - packages/backend/src/modules/reporting/**
  - packages/backend/src/modules/fee/**
  - packages/backend/src/infra/**
  - docs/contributing/ship-playbooks/backend.md
last-verified: "2026-08-23" # #1712: `infra/http/` is a new KIND of infra — an SSRF-guarded outbound reader for untrusted, submitter-chosen hosts — and both enumerations of what infra/ holds (Target structure, and the "what belongs where" table) listed only repositories/chain clients/relayer/explorers, so each was incomplete rather than wrong. Both corrected, and the "rules 2 and 5 still await the `http/` directory" note disambiguated: that is the TOP-LEVEL routes directory, which still does not exist, not `infra/http/`, which now does — a reader skimming for "has http/ landed" would otherwise conflate them. Only the infra/ enumerations and that note were re-read; the dependency rules were NOT re-verified in this pass (they are unaffected — `npm run lint:deps` passes with zero violations and no new waiver). Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected
---

# Module Boundaries

> **This doc describes the enforced state of the backend.** It was written as
> the target of the modularization epic
> [#980](https://github.com/d-hinders/Haven-AI/issues/980); with
> [#999](https://github.com/d-hinders/Haven-AI/issues/999) the epic closed and
> every enabled rule became absolute. The "Today" section records the achieved
> end state (with the deliberate, inline-waived exceptions); rules 2 and 5
> still await the top-level `http/` routes directory and remain future work —
> which is a different thing from `infra/http/`, the outbound SSRF-guarded
> reader added by #1712. That one exists; the routes directory does not.

Structure is cosmetic; the dependency graph is the architecture. A folder
reshuffle that leaves the graph unchanged buys nothing. This doc therefore
specifies the graph first and the folders second — and every rule below is
phrased so a linter can check it, because a rule that lives only in prose
decays within weeks.

## Why domain capability, not technical layer

`routes/` + `lib/` + `db/` (the pre-#998 layout) is a *technical* taxonomy: it
groups files by what they are, not by why they change. The test is mechanical —
take a realistic
feature ("add a spending cap to x402 authorization") and count the directories
it touches. If the answer is "all of them, every time", the boundaries are not
boundaries; they are filing cabinets.

A good module boundary is one where a whole category of change lands *inside*
one directory. For a payments product the axes that actually vary are domain
capabilities: accounts and custody, agent identity and credentials, policy and
authority, execution rails, protocol adapters, ledger and reporting.

### Deletability is the test

A module is defined by what it hides, and the sharpest check on a boundary is
how cheaply the thing behind it can be deleted. The worked example is in our
own history: the session-rail retirement
([#834](https://github.com/d-hinders/Haven-AI/issues/834)). A well-bounded rail
would have been an `rm -rf` of one directory plus one line removed from a
registry. Instead the retirement was, for a while, expressed at several
separate points — a decision branch in `resolveExecutionRail` plus independent
`=== 'session_key'` guards scattered across the payment entry points — which
is precisely the symptom of a seam that exists as a type but not as a boundary.
[#993](https://github.com/d-hinders/Haven-AI/issues/993) collapsed those into
the one gate in `rails/execution-rail.ts`.

### Stable dependencies

Code changes at different rates, and dependencies must point from the volatile
toward the stable — never the reverse:

- **Volatile**: a new rail, a new settlement scheme, a new protocol adapter, a
  new merchant integration.
- **Stable**: money and address types, the chain registry, policy primitives,
  the payment-state taxonomy.

A new rail may depend on the money types. The money types may never depend on a
rail. When that inverts, adding the *next* rail requires editing the core, and
the core stops being safe to touch.

## Target structure

```text
packages/backend/src/
  platform/   config, db pool, logging, http bootstrap, cache, leader-lock
  domain/     PURE: money, address, chains, policy, rail decision, taxonomy
              — no fastify, no pg, no ethers/viem
  modules/    accounts, agents, policy, payments, x402, mpp, reporting, fee
  rails/      allowance-module/, delegation/, registry.ts
  infra/      repositories (SQL lives here only), chain clients, relayer,
              explorers, outbound HTTP (the SSRF-guarded reader in
              infra/http/ — NOT the top-level http/ routes directory below)
  http/       thin fastify routes: validate -> call module -> serialize
```

This is not invented from scratch. `modules/reporting/` and `modules/fee/`
(folded from `lib/reporting/` and `lib/fee/` by #998) already have this shape
— a directory, an entry point, colocated tests — and they are visibly the
most maintainable code in the backend. The target generalises them.

### What belongs where

| Layer | Holds | Never holds |
|---|---|---|
| `platform/` | Process-level concerns: config parsing, the `pg` pool, the Fastify instance, cache, leader-lock | Business rules |
| `domain/` | Pure functions and types: money arithmetic, address validation, the chain registry, policy predicates, the rail *decision*, payment-state taxonomy | I/O of any kind |
| `modules/` | One directory per domain capability, each with a public `index.ts` | Another module's internals |
| `rails/` | Rail implementations behind one interface, plus the registry that selects between them | Rail selection scattered elsewhere |
| `infra/` | Everything that talks to the outside world: repositories, chain clients, relayer, block explorers, outbound HTTP to untrusted hosts (`infra/http/`'s SSRF-guarded reader) | Business rules |
| `http/` | Request validation, auth wiring, rate limiting, serialization | Orchestration or persistence |

## The dependency rules

These are the normative rules. `.dependency-cruiser.cjs` encodes them; if the
two ever disagree, **the lint config is authoritative and this doc is the bug.**

Only the subset checkable against today's tree is enabled — a rule about
`domain/` cannot fire before `domain/` exists. Every enabled rule is **error
severity and unconditional** (#999). Enforcement status:

| Rule | Enforced today | Arrives with |
|---|---|---|
| 1. `domain/` is pure | ✅ `core-stays-pure` covers the shared kernel (#983); `domain-stays-pure` covers the backend's own `domain/` (#998), zero violations on both | landed |
| 2. `modules/` may not import `http/` | ✗ | the `http/` directory (routes/ → http/ is not part of #998's scope — a separate future rename) |
| 3. Only `infra/` touches the DB | ✅ `pg-only-in-infra`, absolute | #985 / #988 / #995 extracted the money path; #999 drove the residue to zero, #1167 retired three more waivers and #1180 the signup/login one — 12 deliberate exceptions carry inline `dep-lint-exempt` waivers with their reasons |
| 4. Only `rails/` + `infra/` touch a chain SDK | ✅ `chain-sdk-not-in-routes`, zeroed for `routes/**` (#994) | `rails/` itself landed with #998; the rule's positive form (asserting infra/rails ARE the only importers, everywhere) is still follow-up work |
| 5. `http/` imports module entry points only | ✗ | the `http/` directory (see rule 2 — not part of #998) |
| 6. Cross-module imports go through `index.ts` | ✅ every `modules/**` directory (accounts, agents, payments, catalog, accounting, reporting, fee, passport, x402, mpp, transactions) — zero violations | landed (#998 widened from the five `lib/{reporting,fee}` + `modules/{transactions,x402,mpp}` directories to all of `modules/**`) |
| 7. The graph is acyclic | ✅ `no-circular` | at zero — held absolutely, and the one rule an inline waiver can never silence |

`@haven_ai/core` also carries the GENERATED API wire types (#984):
`src/api-types.ts` is emitted from the backend's OpenAPI spec by
`scripts/generate-api-types.mjs` and gated against drift in CI
(`npm run check:api-types`). Generated code is still bound by
`core-stays-pure` — it imports nothing, by construction.

Three rules carry **no waivers at all** and never may: `no-circular` (the tree
is cycle-free and a new cycle must be broken, not grandfathered — the linter
refuses to honor a waiver on it), `core-stays-pure` (the shared kernel starts
clean, so an impure import there is always a mistake in the new code, never
inherited debt), and `domain-stays-pure` (#998 — every file placed in the
backend's own `domain/` was verified pure before landing there; one candidate,
`execution-rail.ts`, was kept OUT of `domain/` specifically because it reached
the database directly, and lives in `rails/` instead — its query itself moved
behind `infra/repositories/` in #999). `no-deep-cross-module-import` likewise
carries no waivers today (#998 emptied it), though unlike `no-circular` it is
not mechanically unwaivable — a future module could, in principle, need a
reviewed, temporary exception.

1. **`domain/` is pure.** It may not import `fastify`, `pg`, `ethers`, `viem`,
   `permissionless`, `@metamask/smart-accounts-kit`, or any path under
   `modules/`, `infra/`, `http/`, or `rails/`.
2. **`modules/` may import `domain/` and `platform/`.** It may not import
   `http/`, and it may not import another module's internals.
3. **Only `infra/` touches the database.** No `pg` import and no SQL string
   outside `infra/repositories/`.
4. **Only `rails/` and `infra/` touch a chain SDK.** No `ethers`, `viem`,
   `permissionless`, or `@metamask/smart-accounts-kit` import anywhere else —
   in particular, never in `http/`.
5. **`http/` may import module public entry points only.** A route may not
   reach past `modules/<name>/index.ts`.
6. **Cross-module imports resolve to `modules/<name>/index.ts`.** Never a deep
   path into another module's private files.
7. **The graph is acyclic.** No cycles between modules, ever. Cycles are what
   make a codebase impossible to test in isolation, split, or delete from.

Rule 7 is the one to defend hardest. The other six are conventions that can be
relaxed with an argument; a cycle is a defect regardless of intent.

### Two rules that are security properties, not style

- **Rule 3 is tenant isolation.** Much of Haven's authorization lives in the
  `WHERE user_id = $1` clause of a query. Once queries move into repositories,
  the scoping parameter stays **required and explicit** in the function
  signature — never defaulted, never optional. A repository function callable
  without its scope is a privilege-escalation bug waiting for its first
  careless caller.
- **Rule 4 is not just tidiness.** The two chain SDKs format amounts
  differently at the edges (`formatUnits` / `parseUnits` decimal handling), and
  those amounts are payments. Confining them behind a port means substitutions
  are testable in one place instead of ten route files.

## Enforcement: absolute, with inline waivers

Conventions decay. Boundaries survive only when CI fails on violation.

`npm run lint:deps` (scripts/dep-lint.mjs) is blocking and **absolute**: it
simply passes or fails — new code complies from its first commit. The ratchet
that got here is history, recorded because the sequencing was the point:

1. **#982 installed the linter with a shrink-only baseline** of the then-current
   debt — 66 violations across 48 files (47 `pg-only-in-infra`, 10
   `chain-sdk-not-in-routes`, 9 `no-deep-cross-module-import`), zero cycles.
   Nothing moved; new violations simply became impossible — the same pattern
   design-lint ([#855](https://github.com/d-hinders/Haven-AI/issues/855), zeroed
   by [#913](https://github.com/d-hinders/Haven-AI/issues/913)) and copy-lint
   ([#902](https://github.com/d-hinders/Haven-AI/issues/902)) run.
2. **The epic's sub-issues shrank it to zero** (#985/#988/#992/#994/#995/#996/
   #997/#998, then [#999](https://github.com/d-hinders/Haven-AI/issues/999) for
   the residue).
3. **#999 deleted the baseline and its machinery**, promoting every rule to
   unconditional.

Doing this in the other order — move first, enforce later — reliably produces
tidy folders and an unchanged graph, because nothing prevents the moves from
re-establishing the same edges under new names.

The one escape hatch is an inline waiver on the offending import:

```ts
// dep-lint-exempt: pg advisory locks are session-scoped, so the lock must
// hold ONE dedicated connection for its whole lease
import pool from '../db.js'
```

A waiver must say **why, concretely** — the linter rejects reasons under 20
characters, and `no-circular` can never be waived. Every honored waiver is
printed in the lint output with its reason, so the exception list is visible in
each CI run rather than buried in a JSON file.

The lint also prints the **inline-SQL call-site gauge**: the count of
`.query(` call sites in `packages/backend/src` outside `db/`, `db.ts` and
`infra/repositories/` (production code only). The retired baseline was a
file-edge count and went blind exactly there — it held flat at 66 files while
call sites grew 256 → 344 (+34%), because a file that already imported the
pool could grow inline SQL forever without moving any metric. The gauge sees
intensity, not just presence. Since #1166 it is also a **shrink-only gate**:
`packages/backend/dep-lint-callsite-ceiling.json` holds the committed total
plus per-file counts, and the lint enforces BOTH (#1210): it fails when the
total grows past the ceiling, and also when any single file exceeds its
committed count even under an unchanged total — per-file counts originally
informed only the failure message, which let a file grow for free against
another file's cleanup. `node scripts/dep-lint.mjs --update-ceiling` locks in
a shrink — it refuses to raise the total or any file, so growth and
redistribution alike mean hand-editing the JSON and defending that in the PR.

If a rule turns out to be **wrong** rather than merely unmet — the tree is right
and the rule is too strict — change the rule and say why. Bending working code
to satisfy a bad rule is worse than having no rule.

## Today

Achieved state as of 2026-08-07 (#999, the epic's closing issue):

| Signal | Achieved |
|---|---|
| `lib/` layout | Gone (#998) — every former file lives in `platform/`, `domain/`, `infra/`, `rails/`, or a `modules/**` directory, each `modules/**` directory with a public `index.ts` |
| Largest route | `routes/agent-connection-setups.ts`, 1246 lines (`routes/x402.ts` split by #996, `routes/machine-payments.ts` split into `modules/mpp/` by #997); further route slimming is post-epic work |
| Inline SQL call sites | 68 `.query(` call sites across 14 production files outside `db/`, `db.ts` and `infra/repositories/` — gauged on every lint run and capped by the shrink-only ceiling (#1166). Was 108 across 18 files; #1167 emptied `routes/user.ts`, `routes/dashboard.ts` and `routes/agent-activity.ts`, #1180 `routes/auth.ts` |
| Chain SDK imported in `routes/` | **0** (#994 — `ChainClient` port + `@haven_ai/core` amount helpers) |
| Rail branching outside the seam | The retirement gate is decided ONCE, in `rails/execution-rail.ts` (#993); outside migrations, no non-test file but the seam itself mentions `session_key` |
| Boundary enforcement | `npm run lint:deps`, blocking, **0 baseline entries — the baseline file and its ratchet machinery are deleted**; 13 deliberate `pg-only-in-infra` exceptions carry inline `dep-lint-exempt` waivers, each printed with its reason (16 until #1167 retired three) |
| Dependency cycles | **0** — `no-circular` is absolute and unwaivable |

The gauge exists because the retired baseline was a file-edge count, and that
was a real limit: `pg-only-in-infra` fired once per file that imported `db.ts`,
whatever that file's query volume — `routes/agent-connection-setups.ts` was 1
violation and 56 `.query` call sites (24 statements plus 32
BEGIN/COMMIT/ROLLBACK) before #985 removed all of them. The baseline held flat
at 66 from 2026-07-26 while inline SQL grew from 256 call sites to 344 in the
same set of files. #999 fixed the measure before retiring it, and #1166 made
the fixed measure enforcing: the call-site count prints in every
`npm run lint:deps` run AND fails the lint if it grows past the committed
ceiling — the ratchet is back, but on the dimension that actually moves.

Reproduce: `npm run lint:deps` prints both the waiver list and the gauge.

The flat `lib/` (removed by #998) was the headline symptom: filename prefixes
(`delegation-*`, `machine-payment-*`) did the work that directories and
interfaces should do, which is why "what is the delegation rail?" could
previously only be answered by knowing which of sixty filenames to open. The
delegation rail is now the seven `rails/delegation-*.ts` and `rails/hybrid-*.ts`
files, one directory, one thing to open.

## Non-goals

Explicitly **not** part of #980, so nobody expands the epic by inference:

- **No behaviour changes.** The epic is behaviour-preserving. The two
  deliberate exceptions
  ([#990](https://github.com/d-hinders/Haven-AI/issues/990) chain defaults,
  [#993](https://github.com/d-hinders/Haven-AI/issues/993) dead-branch deletion)
  say so in their own scope and carry their own approval gates.
- **No new published npm package.** `packages/core` is `"private": true`.
  `scripts/release-bump.mjs` stays the single source of truth for the five
  published packages and is not touched.
- **No TypeScript project references.** Real build-speed and
  compile-time-enforcement value, but fiddly against `NodeNext` + Next.js.
  Worth its own issue once the module map is stable.
- **No `@safe-global/protocol-kit` adoption.** Direct `ethers` contract calls
  remain the convention for the legacy rail.
- **No unification of the two chain SDKs.** `ethers` for the legacy rail and
  `viem` for the delegation rail both stay; rule 4 puts a port in front of them
  rather than picking a winner. What a port does NOT buy you is agreement: the
  two implementations had silently drifted on `getTokenBalance`'s handling of a
  zero token address (native balance vs. a contract call at `0x0`) because only
  one of them had any caller. [#1149](https://github.com/d-hinders/Haven-AI/issues/1149)
  answers that structurally — one conformance suite in
  `infra/chain/__tests__/chain-client.test.ts` runs the same expectations
  against **both**, so a divergence fails on whichever side moved.
- **No frontend architecture work** beyond extracting the worst 1000+ line
  components ([#989](https://github.com/d-hinders/Haven-AI/issues/989)).

## Don't over-modularize

Modules cost indirection, build config, and review overhead. The right
granularity is the largest unit that changes as a whole. Splitting a service
into fifteen packages before there are fifteen owners buys ceremony, not
scalability — which is why the *package* split
(`sdk` / `signer` / `mcp` / `connect` / `cli` / `backend` / `frontend`) is
already correct and stays exactly as it is. The problem this doc addresses is
entirely *inside* two of those packages.

## Related

- [Architecture overview](00-overview.md) — the whole stack at a glance.
- [Backend ship playbook](../contributing/ship-playbooks/backend.md) — how the
  dependency gate runs per PR.
- [Documentation-quality system](../contributing/docs-quality-system.md) — the
  `covers:` mapping that keeps this doc honest as the tree moves.
