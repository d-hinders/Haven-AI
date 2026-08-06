---
owner: "@d-hinders"
status: current
covers:
  - .dependency-cruiser.cjs
  - scripts/dep-lint.mjs
  - packages/core/src/**
  - packages/backend/dep-lint-baseline.json
  - packages/backend/src/index.ts
  - packages/backend/src/db.ts
  - packages/backend/src/lib/execution-rail.ts
  - packages/backend/src/lib/reporting/**
  - packages/backend/src/lib/fee/**
  - docs/contributing/ship-playbooks/backend.md
last-verified: "2026-07-26"
---

# Module Boundaries

> **This doc describes a target, not today's tree.** It is the reference the
> modularization epic [#980](https://github.com/d-hinders/Haven-AI/issues/980)
> is measured against. The "Today" section describes current state; everything
> else is where we are going. When #980 closes, "Today" gets deleted and this
> becomes a plain description of the backend.

Structure is cosmetic; the dependency graph is the architecture. A folder
reshuffle that leaves the graph unchanged buys nothing. This doc therefore
specifies the graph first and the folders second — and every rule below is
phrased so a linter can check it, because a rule that lives only in prose
decays within weeks.

## Why domain capability, not technical layer

`routes/` + `lib/` + `db/` is a *technical* taxonomy: it groups files by what
they are, not by why they change. The test is mechanical — take a realistic
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
registry. Instead the retirement is currently expressed at three separate
points — a decision branch in `resolveExecutionRail`, and independent
`=== 'session_key'` guards in `routes/payments.ts` and `lib/machine-payments.ts`
— which is precisely the symptom of a seam that exists as a type but not as a
boundary.

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
              explorers
  http/       thin fastify routes: validate -> call module -> serialize
```

This is not invented from scratch. `lib/reporting/` and `lib/fee/` already have
this shape — a directory, an entry point, colocated tests — and they are
visibly the most maintainable code in the backend. The target generalises them.

### What belongs where

| Layer | Holds | Never holds |
|---|---|---|
| `platform/` | Process-level concerns: config parsing, the `pg` pool, the Fastify instance, cache, leader-lock | Business rules |
| `domain/` | Pure functions and types: money arithmetic, address validation, the chain registry, policy predicates, the rail *decision*, payment-state taxonomy | I/O of any kind |
| `modules/` | One directory per domain capability, each with a public `index.ts` | Another module's internals |
| `rails/` | Rail implementations behind one interface, plus the registry that selects between them | Rail selection scattered elsewhere |
| `infra/` | Everything that talks to the outside world: repositories, chain clients, relayer, block explorers | Business rules |
| `http/` | Request validation, auth wiring, rate limiting, serialization | Orchestration or persistence |

## The dependency rules

These are the normative rules. `.dependency-cruiser.cjs` encodes them; if the
two ever disagree, **the lint config is authoritative and this doc is the bug.**

Only the subset checkable against today's tree is enabled — a rule about
`domain/` cannot fire before `domain/` exists. Enforcement status:

| Rule | Enforced today | Arrives with |
|---|---|---|
| 1. `domain/` is pure | ◐ `core-stays-pure` covers the shared kernel (#983); the backend's own `domain/` still to come | the `domain/` directory (#998) |
| 2. `modules/` may not import `http/` | ✗ | the `modules/` directories (#992 / #996 / #997) |
| 3. Only `infra/` touches the DB | ✅ `pg-only-in-infra` | zeroed by #985 / #988 / #995 |
| 4. Only `rails/` + `infra/` touch a chain SDK | ✅ `chain-sdk-not-in-routes` | zeroed by #994 |
| 5. `http/` imports module entry points only | ✗ | the `http/` directory (#998) |
| 6. Cross-module imports go through `index.ts` | ✅ scoped to `lib/{reporting,fee}/` | widens as modules land; zeroed by #998 |
| 7. The graph is acyclic | ✅ `no-circular` | already at zero — held absolutely |

`@haven_ai/core` also carries the GENERATED API wire types (#984):
`src/api-types.ts` is emitted from the backend's OpenAPI spec by
`scripts/generate-api-types.mjs` and gated against drift in CI
(`npm run check:api-types`). Generated code is still bound by
`core-stays-pure` — it imports nothing, by construction.

Two rules carry **no baseline at all** and never may: `no-circular` (the tree is
cycle-free and a new cycle must be broken, not grandfathered) and
`core-stays-pure` (the shared kernel starts clean, so an impure import there is
always a mistake in the new code, never inherited debt).

1. **`domain/` is pure.** It may not import `fastify`, `pg`, `ethers`, `viem`,
   `permissionless`, `@metamask/smart-accounts-kit`, or any path under
   `modules/`, `infra/`, `http/`, or `rails/`.
2. **`modules/` may import `domain/` and `platform/`.** It may not import
   `http/`, and it may not import another module's internals.
3. **Only `infra/` touches the database.** No `pg` import and no SQL string
   outside `infra/repositories/` — plus `infra/db.ts`, the shared repository
   primitives (`Executor` + `withTransaction`) promoted there by #985.
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

## Enforcement: shrink-only ratchet

Conventions decay. Boundaries survive only when CI fails on violation.

Haven already runs this exact pattern twice — design-lint
([#855](https://github.com/d-hinders/Haven-AI/issues/855)) and copy-lint
([#902](https://github.com/d-hinders/Haven-AI/issues/902)) — and #855's baseline
was subsequently driven to zero by
[#913](https://github.com/d-hinders/Haven-AI/issues/913). The dependency graph
gets the same treatment:

1. **Install the linter with a baseline of today's violations** (#982 — done).
   Nothing moves; new violations simply become impossible. The opening baseline
   is **66 violations across 48 files**: 47 `pg-only-in-infra`, 10
   `chain-sdk-not-in-routes`, 9 `no-deep-cross-module-import` — and **zero**
   cycles, so `no-circular` is asserted absolutely rather than baselined.
   `core-stays-pure` (#983) joined later and likewise carries **no** baseline
   entry: the shared kernel starts clean and must stay clean.
2. **Shrink the baseline** as each epic issue removes a class of violation. The
   script refuses to grow the baseline without an explicit `--update`.
3. **Delete the baseline** when it reaches zero
   ([#999](https://github.com/d-hinders/Haven-AI/issues/999)), promoting every
   rule to unconditional.

Doing this in the other order — move first, enforce later — reliably produces
tidy folders and an unchanged graph, because nothing prevents the moves from
re-establishing the same edges under new names.

If a rule turns out to be **wrong** rather than merely unmet — the tree is right
and the rule is too strict — change the rule and say why. Bending working code
to satisfy a bad rule is worse than having no rule.

## Today

Current state as of 2026-07-25, recorded so progress is measurable:

| Signal | Today | Target |
|---|---|---|
| `lib/` layout | 51 non-test files sitting flat in `lib/`; `reporting/` and `fee/` are the only module directories | Every file inside a module |
| Largest route | `routes/x402.ts`, 1532 lines | Under ~250 lines |
| `pool.query` call sites | 256, across 44 non-test files | Zero outside `infra/repositories/` |
| Chain SDK imported in `routes/` | 10 non-test route files | Zero |
| Rail branching outside the seam | 11+ non-test sites | Zero outside `rails/` |
| Boundary enforcement | `npm run lint:deps`, blocking, 66 violations baselined (#982) | Baseline deleted, rules unconditional (#999) |
| Dependency cycles | **0** — asserted absolutely, never baselined | 0 |

Reproduce these from `packages/backend/src`:

```bash
find lib -maxdepth 1 -type f -name '*.ts' -not -name '*.test.ts' | wc -l
find . -name '*.ts' -not -name '*.test.ts' -not -path '*/__tests__/*' \
  | xargs grep -o 'pool\.query' | wc -l
find ./routes -name '*.ts' -not -name '*.test.ts' \
  | xargs grep -lE "from 'ethers'|from 'viem'|permissionless|smart-accounts-kit" | wc -l
```

The flat `lib/` is the headline symptom: filename prefixes (`delegation-*`,
`machine-payment-*`) are doing the work that directories and interfaces should
do, which is why "what is the delegation rail?" can only be answered by knowing
which of sixty filenames to open.

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
  rather than picking a winner.
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
