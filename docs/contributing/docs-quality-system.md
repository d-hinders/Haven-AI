---
owner: "@d-hinders"
status: current
covers:
  - scripts/docs/**
  - scripts/ci/queue-framing-census.test.mjs
  - .github/workflows/docs.yml
  - .github/workflows/docs-coupling.yml
  - .agents/skills/haven-agent-workflow/references/doc-reviewer.md
  - scripts/ci/review-isolation.mjs
  - .vale.ini
  - .lychee.toml
  - .markdownlint.json
  - .github/vale/**
  - packages/backend/src/openapi/spec.test.ts
  - packages/backend/src/docs-drift/docs-drift.test.ts
  - packages/backend/src/docs-drift/env-example-drift.test.ts
  - .env.example
  - packages/frontend/scripts/serve-docs.mjs
  - packages/frontend/src/lib/__tests__/served-docs.test.ts
  - scripts/frontend-copy-lint.mjs
  - scripts/lib/ratchet.mjs
last-verified: "2026-09-12"
---

# Documentation-quality system

Keep the repo's docs trustworthy as code ships — so both agents and people can
read this repository and know its real state. This is the living spec for epic
[#642](https://github.com/d-hinders/Haven-AI/issues/642). History — why each
gate exists, the incidents behind it, the backtests — lives in `git log` for
this file, and for the retired `last-verified` chain in
[the archive](../archive/last-verified-chains-2026-09.md); never here.

## Front-matter schema

Every doc under `docs/` plus the root gravity files (`CLAUDE.md`, `AGENTS.md`,
`README.md`, `ABOUT_HAVEN.md`) carries:

```yaml
---
owner: "@handle"           # who keeps this doc honest
status: current            # current | research | archived
contract: true             # OPTIONAL (Phase 4): promotes the coupling gate
                           # from advisory to BLOCKING for this doc
covers:                    # repo globs of the code this doc describes
  - packages/backend/src/routes/payments.ts
satisfied-by:              # OPTIONAL (#1366): globs whose NEW files count as
  - docs/some-dir/**       # touching THIS doc in the coupling gate — built
                           # for per-PR changelog shards, so concurrent PRs
                           # write separate files instead of colliding on one
                           # doc's lines. Declare it only when the doc has a
                           # real shard convention (see
                           # docs/regulatory/casp-changelog/README.md).
                           # last-verified: YYYY-MM-DD a human last confirmed
                           # accuracy. A bare date, nothing after it: the
                           # validator refuses any `#` on this scalar (#2681).
last-verified: "2026-06-28"
---
```

- **`covers` is required and must be tight** — list only the code whose change
  would actually invalidate the doc, so the coupling gate stays high-signal.
  `covers` means *this doc describes that code*, not *this doc applies to that
  code* (#1077); narrowing to zero is the opposite failure, because a doc that
  matches nothing never gets the doc-reviewer nudge.
- **An empty `covers` must say why, inline** (#1993):
  `covers: []  # narrative — no direct code mirror`. Blocking in
  `validate-frontmatter.mjs`. The rule forces the decision to be written down;
  it does not forbid an empty list. **Empty-coverage disposition (#2681):** a
  governed doc with `covers: []` looks governed and can never be implicated, so
  each one either declares the real surface it references or is folded and
  archived.
- **`status` must match location:** `docs/archive/**` is `archived`,
  `docs/research/**` is `research`.
- **Shard-first when a doc declares `satisfied-by:` (#1496).** A PR touching
  that doc's covered code writes the shard and does NOT edit the doc — not even
  to bump `last-verified`. The satisfying file must be **added**, not merely
  changed (#2192); a rename does not count, and a bare `--changed=` list
  carries no add/modify status, so pass `--added=` to exercise the rule by hand.
  Editing the parent contract doc
  remains the escape hatch when no new shard is warranted.
- **A shard clears the blocking half, not the doc (#2323).** The advisory
  comment names such a parent in its own *"Parent docs cleared by a shard — body
  not re-read"* section; re-read it against the changed files.
- **Bump `last-verified` only on a genuine re-read.** It is a date, not a change
  log — a rubber stamp is worse than a stale one, because the weekly staleness
  audit ranks on it. A `verified:` block or an inline annotation on the
  `last-verified:` scalar is rejected by `validate-frontmatter.mjs` (#2681); the
  historical chains are archived in
  [`../archive/last-verified-chains-2026-09.md`](../archive/last-verified-chains-2026-09.md).

### Scaffold a new doc

Don't hand-write the header — scaffold it so it's valid on the first try:

```bash
npm run docs:new -- docs/operations/new-thing.md          # → owner @d-hinders, status current, today's date
npm run docs:new -- docs/research/idea.md --owner "@you"   # status inferred as research
```

`scripts/docs/new-doc.mjs` refuses to overwrite an existing file; fill in
`covers` and the body yourself.

### Validate locally

```bash
npm run docs:check     # front-matter + covers globs, agent skills, README agent section, retired UI merge-gate wording, covers gaps
npm run docs:test      # unit tests for the docs and agent-skill validators
npm run docs:coupling  # the STRICT, CI-equivalent coupling gate
npm run docs:measure   # re-derives the #2678 epic's figures; gates nothing, writes nothing
```

`npm run docs:coupling` is the form that tells you what CI will say: the bare
`node scripts/docs/coupling-gate.mjs` is the advisory posture and always exits 0.
With no `--changed` and no `BASE_SHA` the candidate set is the working tree —
`origin/dev...HEAD` plus staged, unstaged and untracked files (#1077) — and an
empty candidate set is reported as "nothing was checked" and fails closed under
`--strict`, rather than passing.

## The gates

Each row names the script, workflow or runner that reports it. The `docs.yml`
rows run on **every** pull request: that trigger carries **no `paths:` filter**,
because a required check must report on every PR or auto-merge deadlocks waiting
for a run that never happens (#933; see [`autonomous-pr-loop.md`](autonomous-pr-loop.md)
§ One-time GitHub setup). Doc/config drift is surface-gated — it rides the
backend vitest job, so a PR touching no backend surface never runs it.

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | **Blocking** |
| `packages/**` Markdown boundary ([#2088](https://github.com/d-hinders/Haven-AI/issues/2088)) | `scripts/docs/package-docs.mjs`, run from `validate-frontmatter.mjs` | **Blocking** |
| Agent-skill structure + adapter alignment | `scripts/docs/validate-agent-skills.mjs` | **Blocking** |
| Agent-facing README section, six copies ([#2533](https://github.com/d-hinders/Haven-AI/issues/2533)) | `scripts/docs/validate-readme-agent-section.mjs` | **Blocking** |
| Retired UI merge-gate wording ([#2657](https://github.com/d-hinders/Haven-AI/issues/2657)) | `scripts/docs/ui-gate-wording.mjs` | **Blocking** (shrink-only baseline; `--update` refuses a rise, [#2747](https://github.com/d-hinders/Haven-AI/issues/2747)) |
| `covers:` gaps — a doc naming a file its `covers:` cannot reach ([#2679](https://github.com/d-hinders/Haven-AI/issues/2679)) | `scripts/docs/covers-gaps.mjs` | **Blocking** (shrink-only baseline of gap FILES; `--accept-new` is the explicit override) |
| `last-verified` chain integrity ([#1843](https://github.com/d-hinders/Haven-AI/issues/1843)) | `scripts/docs/chain-integrity.mjs` | **Retired** by [#2681](https://github.com/d-hinders/Haven-AI/issues/2681) |
| Archive integrity | `retire-verified-chains.mjs verify()`, driven by the docs unit tests | **Blocking** (a hash mismatch fails the required job) |
| Doc/config drift | `packages/backend/src/openapi/spec.test.ts`, `packages/backend/src/docs-drift/*.test.ts`, which pins `.env.example` in **both** directions — every variable the backend reads is listed, every listed key is read somewhere; the values and comments beside a key are prose the test does not check | **Blocking** (vitest) |
| Queue-framing census ([#2107](https://github.com/d-hinders/Haven-AI/issues/2107)) | `scripts/ci/queue-framing-census.test.mjs`, in `ci_config_checks` | **Blocking** (zero-tolerance: a guarded file either has no hit or cannot join the list) |
| Coupling gate — contract docs ([#644](https://github.com/d-hinders/Haven-AI/issues/644)) | `scripts/docs/coupling-gate.mjs --strict`, `.github/workflows/docs-coupling.yml` | **Blocking** for `contract: true` docs |
| Coupling gate — advisory comment | `scripts/docs/coupling-gate.mjs` | Advisory (always exits 0) |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**` so engineering docs may say "Safe", "AllowanceModule", "signer") | Advisory |
| Weekly staleness audit | `scripts/docs/audit-staleness.mjs`, `docs-audit.yml` Mondays 06:00 UTC | Advisory (upserts one tracking issue) |
| `haven-doc-reviewer` | [`doc-reviewer.md`](../../.agents/skills/haven-agent-workflow/references/doc-reviewer.md); binds its verdict to the reviewed head via `scripts/ci/review-isolation.mjs` | Advisory (never blocks auto-merge) |

The shrink-only gates share `scripts/lib/ratchet.mjs`, which validates a
baseline's shape on read (#2759) and runs each gate's `main` through `runGate`
so a refusal reaches an operator as one line (#2761). On a true first run,
`--update` creates an empty baseline without ceremony; if the scan finds debt,
initialization refuses until the operator reviews it and explicitly reruns with
`--update --accept-new` (#2758). That flag cannot raise an existing baseline.
`covers-gaps.mjs` keeps its own comparison because its baseline stores gap
**files** rather than counts.

Adding **Docs front-matter & agent skills**, and the `Contract-doc coupling`
job, to the "Haven automerge rules" ruleset's required checks — without a paths
filter — is what makes the blocking column above true.

## Rules the gates apply

- **Only `current` docs are governed (#2638).** `archived` and `research` docs
  are skipped by the coupling gate in both directions and by the staleness
  audit. A doc with **no** `status` is treated as governed — a missing field is a
  broken doc, not an exemption. The predicate is `isGoverned(status)` in
  `coupling-gate.mjs`, inlined in `audit-staleness.mjs`.
- **Test and generated files are incidental.** `__tests__/`, `*.test.*`,
  `*.spec.*`, `__screenshots__/` and `packages/core/src/api-types.ts` implicate a
  doc only when `covers` names the path exactly. Two carve-outs, in this order:
  `__screenshots__/` is checked **first** (#1854), then `packages/qa-agent/**`
  and `packages/frontend/e2e/**` are never incidental, because their scenarios
  are what their runbooks document. Under `--strict`, a `contract: true` doc with
  no shard skips the filter entirely.
- **A `#` comment may only trail a `covers` item**, never occupy its own line.
- **There is no same-day suppression (#1824).** A doc is implicated whenever a
  changed file matches its `covers` globs and the PR did not also touch the doc,
  whatever its `last-verified` says.
- **Editing the gate itself is a money-path change (#2200).**
  `coupling-gate.mjs`, `validate-frontmatter.mjs` and `docs-coupling.yml` are
  `controlGlobs` in [`.github/money-path-globs.json`](../../.github/money-path-globs.json):
  the `money-path` label and the [`money.md`](ship-playbooks/money.md) playbook,
  but no `qa-freshness` re-run.
- **The staleness audit is read at promotion (#2638).**
  [`../operations/promoting-dev-to-main.md`](../operations/promoting-dev-to-main.md)
  requires a disposition for every ranked doc — fix, drop with a reason, or file
  above the bar ([`ship-next` § *Filing bar*](../../.agents/skills/ship-next/SKILL.md#filing-bar-2767)).
  Non-contract docs are deliberately allowed to drift on `dev` between
  promotions, and this is the one place that drift is swept.
- **What none of these establish** is that the prose which remains is *true*.
  That needs the per-claim evidence and review in the shipping PR.

### The `packages/**` Markdown boundary (#2088)

Markdown under `packages/**` carries no front-matter and is outside this system.
What is enforced instead is that the **boundary** is declared:
`scripts/docs/package-docs.mjs` holds two sets and every `packages/**/*.md` must
be in exactly one — `GOVERNED_PACKAGE_DOCS`, whose `owner` / `status` /
`covers` / `last-verified` live in the
manifest rather than in front-matter so a published README is not defaced by a
YAML block, or `EXEMPT_PACKAGE_DOCS`, each entry carrying a written reason. A
path under a declared `GENERATED_MARKDOWN_PREFIXES` entry is excluded from the
enumeration altogether, and qualifies only if the output is regenerated on every
build **and** gitignored (#2532). A file in neither set is a **named blocking
error**. `checkPackageDocBoundary` enforces both directions, pinned by
`scripts/docs/package-docs.test.mjs`; `boundaryScopeNotes()` in the manifest
enumerates what the boundary does not reach, so a green run cannot be over-read.

## Docs served to agents (#2532)

Four product docs are also served from the frontend as Markdown, so an agent
reading `llms.txt` can follow a link to the product answer without leaving the
origin it is reading:

| Served path | Source |
| --- | --- |
| `/docs/account-recovery.md` | `docs/product/account-recovery.md` |
| `/docs/agent-key-rotation.md` | `docs/product/agent-key-rotation.md` |
| `/docs/agent-passport.md` | `docs/product/agent-passport.md` |
| `/docs/security-model.md` | `docs/security/delegation-rail-security-model.md` |

- **There is exactly one editable copy, and it is the source.**
  `packages/frontend/scripts/serve-docs.mjs` regenerates the served files,
  `packages/frontend/public/docs/` is gitignored, and the invariant is pinned by
  [`served-docs.test.ts`](../../packages/frontend/src/lib/__tests__/served-docs.test.ts)
  (#2680).
- **The generator is invoked from `next.config.ts`**, not an npm `prebuild`
  hook, and is phase-gated to build and dev — a server does not generate.
  `packages/frontend/Dockerfile` copies `docs/` into its builder stage, and a
  test asserts that COPY covers every allowlisted source; tests get the same
  files from `vitest.global-setup.ts`.
- **The allowlist in that script is the control.** `docs/contributing/` and
  `docs/operations/` are deliberately absent. Adding a doc is a deliberate
  decision, and the build **fails** if an allowlisted doc's `status` is not
  `current`.
- **Relative links are rewritten**, so the served copy is not byte-identical: a
  link to another served doc becomes its served path, everything else becomes a
  repository URL (#2520). Copy-lint deliberately does not scan the served copies
  — they exist only after a build, and the sources are governed here.

## Reproducing the #2678 baseline

```bash
npm run docs:measure
```

Four read-only, dependency-free scripts under `scripts/docs/measure/` re-derive
every figure in epic [#2678](https://github.com/d-hinders/Haven-AI/issues/2678):
corpus and chain mass, the derivable-claim census, the `covers:` gaps (the same
implementation `docs:check` runs, so the gate and the measurement cannot
disagree), and the correction rate. Each script prints the epic's own figure
next to its own and says which reproduce. They gate nothing and write nothing.
