---
owner: "@d-hinders"
status: current
covers:
  - .dependency-cruiser.cjs
  - scripts/dep-lint.mjs
  - scripts/dep-cycles.mjs
  - scripts/lint-route-line-ceiling.mjs
  - packages/backend/route-line-ceiling.json
  - packages/core/src/**
  - packages/backend/src/index.ts
  - packages/backend/src/db.ts
  - packages/backend/src/rails/execution-rail.ts
  - packages/backend/src/modules/accounting/**
  - packages/backend/src/modules/fee/**
  - packages/backend/src/infra/**
  - docs/contributing/ship-playbooks/backend.md
last-verified: "2026-11-10"
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
  platform/   config, db pool, logging, http bootstrap, cache, leader-lock,
              job-scheduler
  domain/     PURE: money, address, chains, policy, rail decision, taxonomy
              — no fastify, no pg, no ethers/viem
  modules/    accounts, accounting, agents, budget-scope, catalog, dashboard, fee,
              feedback, mpp, ops, owner-profile, passport, payments, sub-budgets,
              task-budgets, transactions, x402
  rails/      delegation/, execution-rail.ts, hybrid-*, sweep.ts
  infra/      repositories (SQL lives here only), chain clients (the shared
              chain reads live in infra/chain/relayer-reads.ts), relayer,
              explorers, outbound HTTP (the SSRF-guarded reader in
              infra/http/ — NOT the top-level http/ routes directory below)
  http/       thin fastify routes: validate -> call module -> serialize
```

This is not invented from scratch. `modules/accounting/` (`modules/reporting/` until #2859) and `modules/fee/`
(folded from `lib/reporting/` and `lib/fee/` by #998) already have this shape
— a directory, an entry point, colocated tests — and they are visibly the
most maintainable code in the backend. The target generalises them.

### What belongs where

| Layer | Holds | Never holds |
|---|---|---|
| `platform/` | Process-level concerns: config parsing, the `pg` pool, the Fastify instance, cache, leader-lock, the generic job scheduler | Business rules |
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
| 3. Only `infra/` touches the DB | ✅ `pg-only-in-infra`, absolute | #985 / #988 / #995 extracted the money path; #999 drove the residue to zero, #1167 retired three more waivers and #1180 the signup/login one — deliberate exceptions carry inline `dep-lint-exempt` waivers with their reasons (8 at #4379, of the 15 waived edges the lint prints; live count printed by every lint run) |
| 4. Only `rails/` + `infra/` touch a chain SDK | ✅ `chain-sdk-not-in-routes`, zeroed for `routes/**` (#994) | `rails/` itself landed with #998; the rule's positive form (asserting infra/rails ARE the only importers, everywhere) is still follow-up work |
| 5. `http/` imports module entry points only | ✗ | the `http/` directory (see rule 2 — not part of #998) |
| 6. Cross-module imports go through `index.ts` | ✅ two arms, absolute: `no-deep-cross-module-import` (an import into `modules/<name>/` from outside `modules/`) and `no-deep-module-to-module-import` (one module importing another module's private file, #4379 — before it, the first arm's `from` excluded every `modules/` file, so 14 such imports were unchecked). Every `modules/**` directory — zero violations, 3 + 4 inline waivers (see below). `modules/dashboard/` (#3847) is the one directory without an `index.ts`, deliberately: #3804's owner decision makes `routes/dashboard-budget-remaining.ts` the only importer of its display-only budget-remaining cache, through one of the 3 `no-deep-cross-module-import` waivers, and `modules/dashboard/__tests__/budget-remaining-import-guard.test.ts` pins that no other file imports it | landed (#998 widened from the five `lib/{reporting,fee}` + `modules/{transactions,x402,mpp}` directories to all of `modules/**`; the 2026-09-11 #2881 rename dissolved `modules/reporting/` into `modules/accounting/` and split its asserting code out; `modules/task-budgets/` joined with #3329; `modules/owner-profile/` joined with #3332; `modules/sub-budgets/` joined with #3444; `modules/ops/` joined with #3509; `modules/feedback/` joined with #3597 — `domain-stays-pure` forbids its `viem/accounts` import inside `domain/`, and it lives here carrying no waiver today; `modules/budget-scope/` joined with #3616 (PR #3622) and `modules/dashboard/` with #3847) |
| 7. The graph is acyclic | ✅ `no-circular` — two passes, two definitions (#4763): `npm run lint:deps` over `packages/backend` and `packages/core` under the STRICT definition (type-only imports counted), and `npm run lint:dep-cycles` over the other eleven packages under the RUNTIME definition (type-only imports are not edges) | at zero on both — held absolutely, and the one rule an inline waiver can never silence |

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
behind `infra/repositories/` in #999). Rule 6's two rules are not among them:
at #4379 `no-deep-cross-module-import` carries 3 inline waivers (`index.ts`,
`routes/accounting.ts`, `routes/dashboard-budget-remaining.ts`) and
`no-deep-module-to-module-import` carries 4 (`modules/accounting/entry.ts` →
`transactions/normalize.ts`, and three `modules/mpp/evidence.ts` → `x402/`
leaves), each naming the cycle an `index.ts` import would close — `no-circular`
is the one rule no waiver can silence, so a deep import into a zero-cycle leaf
is the reviewed alternative. Unlike `no-circular`, both are waivable.

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
   path into another module's private files — from outside `modules/`
   (`no-deep-cross-module-import`) or from another module
   (`no-deep-module-to-module-import`, #4379). A module's own files import
   each other freely.
7. **The graph is acyclic.** No cycles between modules, ever. Cycles are what
   make a codebase impossible to test in isolation, split, or delete from.

Rule 7 is the one to defend hardest. The other six are conventions that can be
relaxed with an argument; a cycle is a defect regardless of intent.

### Rule 7 has two meanings, and both are enforced (#4763)

The rule is checked on all thirteen packages, but not under one definition:

- **`packages/backend` and `packages/core` — STRICT.** `npm run lint:deps`
  (`scripts/dep-lint.mjs`) runs the repo's own ruleset, which sets
  `tsPreCompilationDeps: true` (`.dependency-cruiser.cjs`): a **type-only
  import is an edge**. Both trees are at zero.
- **The other eleven — RUNTIME.** `npm run lint:dep-cycles`
  (`scripts/dep-cycles.mjs`) runs a one-rule `no-circular` pass over each
  package's `src` with `tsPreCompilationDeps: false`: a **type-only import is
  not an edge**. It resolves each package's own `tsconfig.json` (so the
  frontend's `@/` alias is a real edge) and reads `.tsx` as well as `.ts`. All
  eleven are at zero.

The split is an owner decision (2026-11-10, on
[#4763](https://github.com/d-hinders/Haven-AI/issues/4763)): **runtime cycles
only** outside backend and core. Before it, rule 7 was checked on two of the
thirteen packages, and the eleven unchecked ones held one runtime cycle —
`packages/sdk/src/merchant-answer.ts` ↔ `merchant-completion.ts`, two value
imports pointing at each other — which #4763 broke by moving both receipt
parsers into `merchant-answer.ts`.

**The nine type-only cycles are known and deliberately unenforced.** Measured
on `origin/dev` @ `49747fac3` with the same one-rule probe at
`tsPreCompilationDeps: true`: `frontend` 5, `sdk` 2 (one of them the runtime
cycle above), `connect` 1, `qa-agent` 1, `signer` 1 — ten in total, nine of
them type-only. They are not defects under the owner's definition, and nothing
grandfathers them: if one becomes a runtime cycle it fails the pass. Breaking
them is separate work, not a waiver.

Both passes are **unwaivable**: a `// dep-lint-exempt` comment does not silence
`no-circular` in either, and `scripts/dep-cycles.test.mjs` pins that with a
planted value cycle carrying the comment.

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

**Rule 3's SQL-string clause has one recorded exception** ([#2138](https://github.com/d-hinders/Haven-AI/issues/2138)).
`domain/passport-issuance-rail.ts` exports `passportIssuableRailSql(alias)`, which
*returns* a SQL predicate for `infra/repositories/agent-passports.ts` to interpolate.
It reaches no database — no `pg` import, no `.query(` call site — so neither
mechanical form of the rule fires, and the "lint config is authoritative" clause
above resolves it as permitted. It is written down anyway, because the prose says
*no SQL string*, and an unrecorded divergence from a normative rule is worse than a
stated one.

Why it sits in `domain/` at all: the rule it encodes — passport issuance is
delegation-rail only — has to hold in two languages at once, a SQL predicate for the
retry sweep's join and a TypeScript predicate for the route and `issuePassport`.
Splitting those across layers is precisely how they drift apart; a real-DB test
varies both axes and fails if they ever disagree. The tenant-isolation rationale
does not reach it either: the predicate carries no user scoping and takes no user
input, its one parameter being a table alias validated against `^[a-z_][a-z0-9_]*$`
(case-insensitive) before interpolation. Contrast `execution-rail.ts`, kept OUT of `domain/` because it
genuinely *reached the database* — that is the line, and this stays on the pure side
of it.

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

A second shrink-only ceiling covers **route file size**. `npm run lint:route-lines`
(`scripts/lint-route-line-ceiling.mjs`, built on the repo's shared ratchet engine)
fails when a non-test `.ts` file directly under
`packages/backend/src/routes/` grows past its committed line count in
`packages/backend/route-line-ceiling.json`. A route file at or under **400
lines** counts as zero and needs no entry, so a new small route passes with no
ceremony and a file that shrinks under the threshold drops out of the baseline
on `npm run lint:route-lines:update`; a file over the threshold counts as its
line count, and a file over it with no entry fails. `--update` lowers entries
and refuses to raise or add one, so growth — and a net-additive fix to a large
route, a security fix included — means hand-editing the JSON and defending that
in the PR, exactly as for the call-site ceiling above. The gate exists because
slices 1 and 2 of epic [#4759](https://github.com/d-hinders/Haven-AI/issues/4759)
(#4760, #4761) took `routes/payments.ts` from 1572 lines to 291 and nothing
stopped it growing back.

If a rule turns out to be **wrong** rather than merely unmet — the tree is right
and the rule is too strict — change the rule and say why. Bending working code
to satisfy a bad rule is worse than having no rule.

## Today

Achieved state as of 2026-08-07 (#999, the epic's closing issue):

| Signal | Achieved |
|---|---|
| `lib/` layout | Gone (#998) — every former file lives in `platform/`, `domain/`, `infra/`, `rails/`, or a `modules/**` directory, each `modules/**` directory with a public `index.ts` except `modules/dashboard/` (#3847), which deliberately has none: its one file, the display-only budget-remaining cache, is reached only through the waived import in `routes/dashboard-budget-remaining.ts` (#3804) |
| Largest route | `routes/agent-connection-setups.ts`, 1556 lines, then `routes/agent-delegations.ts` at 1389 and `routes/agent-rekey.ts` at 1276 (`routes/payments.ts` fell from 1572 to 291 when slices 1 and 2 of epic #4759 moved the payments lifecycle into `modules/payments/`; `routes/x402.ts` split by #996, `routes/machine-payments.ts` split into `modules/mpp/` by #997; re-measured 2026-11-10 with `wc -l packages/backend/src/routes/*.ts` — further route slimming is post-epic work, and the shrink-only ceiling above now holds the gain) |
| Inline SQL call sites | 35 `.query(` call sites across 9 production files outside `db/`, `db.ts` and `infra/repositories/` — gauged on every lint run (`npm run lint:deps`; re-measured 2026-10-25 by the weekly docs audit, #4418) and capped by the shrink-only ceiling, now also 35 (#1166; `packages/backend/dep-lint-callsite-ceiling.json`, 9 per-file entries). Was 108 across 18 files; #1167 emptied `routes/user.ts`, `routes/dashboard.ts` and `routes/agent-activity.ts`, #1180 `routes/auth.ts`; the epic-#1440 deletions (incl. #2055 removing `routes/approvals.ts`) and later moves account for the rest; the ceiling was locked down from 58 to 35 by #4044 |
| Chain SDK imported in `routes/` | **0** (#994 — `ChainClient` port + `@haven_ai/core` amount helpers) |
| Rail branching outside the seam | The retirement gate is decided ONCE, in `rails/execution-rail.ts` (#993); outside migrations, no non-test file but the seam itself mentions `session_key` as a live value — the remaining mentions are the passport rail-domain enum and its OpenAPI mirror, which list `session_key` only as a retired member (#2110) |
| Boundary enforcement | `npm run lint:deps`, blocking, **0 baseline entries — the baseline file and its ratchet machinery are deleted**; 15 deliberate exceptions carry inline `dep-lint-exempt` waivers, each printed with its reason — 8 `pg-only-in-infra`, 3 `no-deep-cross-module-import` and 4 `no-deep-module-to-module-import` (re-measured at #4379: "No dependency-boundary violations across 501 source files (15 import edge(s) waived)") |
| Dependency cycles | **0** on both passes — `no-circular` is absolute and unwaivable. `npm run lint:deps` (backend + core, strict) and `npm run lint:dep-cycles` (the other eleven, runtime-only) both report zero; the nine type-only cycles outside backend/core are known and unenforced by the owner's decision (#4763) |

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
delegation rail is now the nine `rails/delegation-*.ts` and `rails/hybrid-*.ts`
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
(`sdk` / `signer` / `mcp` / `connect` / `cli` / `backend` / `frontend`, and
the rest of the 13 workspace packages) is already correct, and this doc does
not change it. The problem this doc addresses is
entirely *inside* two of those packages.

## Related

- [Architecture overview](00-overview.md) — the whole stack at a glance.
- [Backend ship playbook](../contributing/ship-playbooks/backend.md) — how the
  dependency gate runs per PR.
- [Documentation-quality system](../contributing/docs-quality-system.md) — the
  `covers:` mapping that keeps this doc honest as the tree moves.

Historical verification records for this document are kept in the [archive](../archive/re-verification-notes-2026-11.md).
