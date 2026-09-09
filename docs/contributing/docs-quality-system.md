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
last-verified: "2026-09-09"
---

# Documentation-quality system

Keep the repo's docs trustworthy as code ships — so both agents and people can
read this repository and know its real state. This is the living spec for epic
[#642](https://github.com/d-hinders/Haven-AI/issues/642).

## Why

We've repeatedly hit inaccurate docs after code changed. Nothing coupled docs to
the code they describe, so drift was silent. The one exception — the OpenAPI
drift test (`packages/backend/src/openapi/spec.test.ts`) — is exactly the
pattern this system generalizes: fail loudly when a doc and the code it mirrors
disagree.

## Design principles

- **Defense in depth.** Several independent layers, cheapest and most
  deterministic first, the LLM/agent layer last.
- **Advisory before blocking.** New checks land non-blocking. They are promoted
  to required only once the signal is trusted (Phase 4).
- **The mapping is the linchpin.** You cannot detect a stale doc without knowing
  which code it describes. That mapping lives in each doc's `covers:`
  front-matter and every later layer hangs off it.

## Front-matter schema (Phase 1)

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
last-verified: "2026-06-28" # YYYY-MM-DD a human last confirmed accuracy
---
```

**Shard-first is the convention, not the fallback (#1496).** When a doc declares
`satisfied-by:`, a PR touching its covered code writes the shard and does NOT
edit the doc — not even to bump `last-verified`. Three merge conflicts landed in
one day between PRs that had each already written a satisfying shard, because
the gate's old error message said only "update each doc" and everyone obeyed it;
the mandatory line-prepend also eventually corrupted the note line itself. The
strict error now names the shard path for docs that declare one. Bump
`last-verified` only when you genuinely re-read the doc body against the code —
the per-change history lives in the shards and git log, not on that line.

**The satisfying file must be ADDED, not merely changed (#2192).** The gate
originally asked only whether *some* changed file matched a `satisfied-by`
glob. It never asked whether the file was new — so a one-character edit to a
shard that merged months ago cleared the blocking gate for an unrelated
money-path PR, silently and on green CI, with the record the gate exists to
force never written. Measured before the fix: money-path edit alone → exit 1;
the same edit plus a one-character append to an already-merged shard → exit 0.

The rule is "at least one **added** match", never "no modified matches" — a PR
that writes its own shard *and* tidies an old one still passes. Renames do not
count: an old record under a new name is not a new record. Two consequences
worth knowing:

- **Editing the parent contract doc is still the escape hatch**, and it is the
  right one when a money-path change genuinely warrants no new shard: touching
  the doc itself clears the gate and leaves a reviewable statement of why.
- **A bare `--changed=` list carries no add/modify status**, so the rule is not
  applied to it and the pre-#2192 behaviour stands for that path alone. This is
  deliberate and narrow: `--changed=` is a local/debugging affordance, while the
  job that actually gates a PR sets `BASE_SHA` and gets real status from git.
  Pass `--added=` alongside it to exercise the rule by hand.

**A shard clears the BLOCKING half. It does not clear the doc ([#2323](https://github.com/d-hinders/Haven-AI/issues/2323)).**
Until #2323 a qualifying shard made the gate `continue` *before* the `covers:`
test, so the parent was not merely un-blocked — it was never **named**, in either
posture. Measured on `origin/dev` with `casp-risk-guardrails.md`'s real front
matter and one covered code file:

| change set | strict | advisory |
|---|---|---|
| covered code only | 1 finding, parent named | 1 finding, parent named |
| covered code + **added** shard | **0 findings, parent absent** | **0 findings, parent absent** |
| covered code + *edited* shard (#2192) | 1 finding, parent named | 1 finding, parent named |

The middle row is the defect, and [#2274](https://github.com/d-hinders/Haven-AI/issues/2274)
(PR #2322) paid for it: that diff moved the retired-rail 410 above token
resolution on `/payments` and `/x402/authorize`, wrote a correct shard, and went
green — while `casp-risk-guardrails.md`'s #2245 Current-state blockquote still
listed token resolution as preceding the x402 410, a sentence the same diff had
just made false, **in the very document the shard was satisfying**. Re-running
#2274's real file set against the pre-#2323 gate reproduces it: fifteen advisory
docs listed and *neither* shard-cleared contract doc among them — the second
being `04-x402-payment-sequence.md`, which had the same paragraph wrong and was
corrected in a later pass.

The gate's green tick reads as "the coupled docs are consistent with this
change". What it asserted was "a shard exists that claims to cover this change".
The shard is written by the same person making the change, so that is
self-certification: the author asserts the change is documented and the gate
accepts the assertion as the evidence.

What #2323 changed, and what it deliberately did not:

- **The blocking half is byte-identical.** A qualifying added shard still clears
  `--strict`. Requiring a parent edit instead would reinstate the `last-verified`
  line collision that #1366 moved records into shards to escape (four PRs in one
  day) and that #1496 saw three more of, and would buy a rubber-stamped date —
  worse than a stale one, because the weekly staleness audit ranks on it.
- **The doc is now reported**, in its **own section** of the advisory comment
  (*"Parent docs cleared by a shard — body not re-read"*), naming the shard that
  cleared it and the changed files to re-read it against. Its own section rather
  than a bullet in the list above it, because that list is where "the one ⚠️
  finding that mattered on #1076 was skimmed past in a list of eleven".
- **It is keyed on the `covers:` match, not on the shard.** A PR that writes a
  shard but changes nothing the parent describes stays silent about it —
  otherwise the section would be a permanent banner rather than a signal.
- **The shard-cleared match set is noise-filtered.** The incidental-path
  carve-out, which was `filterIncidental = !(strict && contract)` and is now
  `!(strict && contract && satisfiedByShard.length === 0)`, exists so the
  *blocking* half cannot under-report. A shard-cleared finding never blocks, so
  it takes the filtered set and a test-only money-path PR draws no re-read
  request. The added conjunct is the only change to that expression, and it is
  unreachable for any finding that can block.

**Be precise about what this buys, because it is less than it looks.** No gate
can verify that a body was re-read; it can only refuse to hide the doc. The
section lands in an **advisory** comment that exits 0, so it is worth exactly as
much as the reader. What it does fix mechanically is *routing*: `ship-next`'s
doc-reviewer step runs over the docs the gate implicates, and a shard-cleared
parent was not in that set — so on #2274 `haven-doc-reviewer` was pointed at that
document by luck rather than by the gate's output. It now is, by construction.
The honest ceiling of the gate is naming the doc; `haven-doc-reviewer` remains
the control that reads the body.

**Where else the self-satisfying shape lives**, surveyed under #2323 so it is not
re-derived. "Same shape" means: the artifact that satisfies a check is written by
the person the check is aimed at. Three of the four are left as they are, with
reasons, and none was fixed in that PR:

- **`covers:` front-matter** — the author declares which code a doc describes,
  and `validate-frontmatter.mjs` only checks that each glob resolves to at least
  one real file. Nothing asks whether the list is *complete*, so a doc can
  under-declare and exempt itself from the gate permanently. Related but **not**
  the same shape: it is a standing, reviewable declaration by the doc's owner,
  not a per-change assertion by whoever is shipping. It also has the one real
  antidote in this system — `scripts/ci/money-path.test.mjs` pins
  `casp-risk-guardrails.md`'s `covers:` against `.github/money-path-globs.json`,
  an *independent* list, so that one doc cannot silently narrow its own scope.
  **Be exact about what that pin asserts, because it is narrower than its
  reputation** (counted against the JSON and the test, not inferred): it is a
  one-directional FLOOR over **31 of the 47 globs** (as of #2300, which added
  `packages/mcp-server/src/**`; it was 30 of 46 when #2323 counted) — every
  entry in the runtime `globs` list (33) except the two its own `EXEMPT` map
  carves out (`infra/chain/**`, `infra/repositories/**`, both deferred to the
  doc owner under #1899), and **none of the 15 `controlGlobs`**, which the test
  deliberately leaves out as CI configuration the doc reasons about
  individually. Within that set it asserts every matched tracked file is also
  matched by some `covers:` glob. There is **no** assertion in the other
  direction, so an unrelated entry ADDED to `covers:` is checked by nothing —
  measured by appending a marketing-page glob and watching all 10 tests stay
  green. Nothing pins any other doc's `covers:` in either direction.
- **The `last-verified` chain check** (`chain-integrity.mjs`, retired by
  [#2681](https://github.com/d-hinders/Haven-AI/issues/2681)) — was the strongest
  instance while it ran. It verified **containment** (every issue reference in
  the prior entry survived into the new one) and nothing about whether the note
  was true; the `chain-reset(#N)` escape hatch was written by the author who
  wanted the chain dropped. Retired with the convention it guarded; the history
  it protected is archived verbatim in
  `docs/archive/last-verified-chains-2026-09.md`.
- **`EXEMPT_PACKAGE_DOCS`** (`package-docs.mjs`) — a `packages/**` Markdown file
  leaves the system by its author writing a reason string, and check (4b)
  verifies only that the string is non-empty. Same shape, small blast radius: the
  boundary itself is visible and enumerated, which was #2088's whole point.
- **The advisory coupling job** — always exits 0 by design. It is not
  self-certifying, but it is the reason #2323's fix is a report rather than a
  block, and its strength is bounded by whether a human reads the comment.

- `covers` is **required** but may be empty (`covers: []`) for narrative docs
  with no direct code mirror (indexes, research, archives, process prose). Keep
  it **tight** — list only the code whose change would actually invalidate the
  doc, so the Phase 2 coupling gate stays high-signal.
- **An empty `covers` must say why, inline** (#1993):
  `covers: []  # narrative — no direct code mirror`. Blocking in
  `validate-frontmatter.mjs`.

  The reason it is enforced rather than merely encouraged: a doc with
  front-matter and `covers: []` *looks* governed — it has an owner, a
  `last-verified`, a row in the inventory — while **no coupling gate can ever
  implicate it**, because an empty glob list matches nothing. That is strictly
  worse than a doc with no front-matter at all, which is at least *visibly*
  outside the system; here the registration itself is the misleading signal. It
  bit for real: `ABOUT_HAVEN.md`, the designated first-read mental-model doc,
  came to flatly contradict five merged Safe-retirement slices, and nothing
  mechanical would ever have said so (#1992).

  The rule does not forbid an empty `covers` — plenty of docs genuinely have no
  code mirror. It forces the DECISION to be written down, so an audit can tell
  *deliberately uncoupled, here is why* from *nobody ever decided*. Twenty of
  the twenty-two empty-covers docs already carried such a note by hand; #1993
  made the convention mechanical and filled the two that did not.

  **What it does not reach.** Only the files this validator enumerates —
  `docs/**` plus the four root gravity files. A Markdown file under
  `packages/**` (`packages/qa-agent/README.md`, the package READMEs) has no
  front-matter at all and sits outside the docs-quality system entirely. That
  is a separate, *visible* gap and is tracked on its own; this rule closes the
  invisible one.
- `status` must match location: `docs/archive/**` is `archived`,
  `docs/research/**` is `research`.

### Scaffold a new doc

Don't hand-write the header — scaffold it so it's valid on the first try:

```bash
npm run docs:new -- docs/operations/new-thing.md          # → owner @d-hinders, status current, today's date
npm run docs:new -- docs/research/idea.md --owner "@you"   # status inferred as research
```

`scripts/docs/new-doc.mjs` emits a correct front-matter block (owner default
`@d-hinders` overridable with `--owner`, `status` inferred from the path,
`covers: []` with a hint comment, `last-verified` = today) plus an H1 heading,
then you fill in `covers` and the body. It refuses to overwrite an existing
file and is dependency-free like the other `scripts/docs/*` tools.

### Validate locally

```bash
npm run docs:check   # front-matter + covers globs, agent skills, README agent section, retired UI merge-gate wording, covers gaps
npm run docs:test    # unit tests for the docs and agent-skill validators
```

`scripts/docs/validate-frontmatter.mjs` is dependency-free (no `js-yaml`): it
checks required keys, the `status` enum, the `last-verified` date format, and
that every `covers` glob resolves to at least one real path. It exits non-zero
on any problem.

`scripts/docs/validate-agent-skills.mjs` validates the canonical skills under
`.agents/skills/`, their relative references, the thin client-adapter targets,
and the boundary between portable workflow text and client-specific mechanics.
It is dependency-free and runs as part of `npm run docs:check`.

`scripts/docs/validate-readme-agent-section.mjs` is the third step
([#2533](https://github.com/d-hinders/Haven-AI/issues/2533)). It checks that the
agent-facing section every published README carries is byte-identical to
`AGENT_README_SECTION_MD` in `packages/sdk/src/agent-guidance.ts`, reading the
constant out of the TypeScript source as text so it needs no build. It lives
here rather than only in the SDK suite for a reason this document's own closing
paragraph explains: `scripts/ci/change-classifier.mjs` routes a README-only
change to NO surface, so the SDK job would not run for the single edit the
guard exists to catch, while this job has no `paths:` filter and always does.

`scripts/docs/chain-integrity.mjs` was the fourth step until
[#2681](https://github.com/d-hinders/Haven-AI/issues/2681) retired the
`last-verified` chain (see [`last-verified` chain integrity](#last-verified-chain-integrity-1843)
below for what it was). Of the `docs:check` steps, only `validate-frontmatter.mjs`
still touches the chain: it **rejects** a `verified:` block or an inline annotation
on the `last-verified:` scalar, naming the archive that holds the historical
entries. The archive itself is guarded by `retire-verified-chains.mjs verify()`,
run from the docs unit tests.

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

**There is still exactly one editable copy, and it is the source**
(the single-copy invariant is pinned by
[`packages/frontend/src/lib/__tests__/served-docs.test.ts`](../../packages/frontend/src/lib/__tests__/served-docs.test.ts),
#2680).
`packages/frontend/scripts/serve-docs.mjs` regenerates the served files from
the sources, and `packages/frontend/public/docs/` is gitignored.

The generator is invoked from `next.config.ts`, not from an npm `prebuild`
hook, and the difference is not cosmetic: a hook fires for `npm run build`
(which is what CI uses) but would be skipped by a deployment whose build
command calls `next build` directly — and every `/docs/*.md` path would then
404 in production with nothing failing. There is no `vercel.json` in this
repository, so the deployed command is not knowable from the tree. Invoking
from the config makes the question stop mattering, for `next dev` as well.

It is **phase-gated**: `next start` loads the config too (measured — deleting
the output and starting the server without rebuilding put the files back), so
an unguarded call does filesystem work at server start for no reason. Build and
dev generate; a server does not.

The gate is *not* a standalone-crash guard, though an earlier draft of this
paragraph said it was: the standalone `server.js` inlines the config as
serialized JSON at build time and never re-executes `next.config.ts`, so the
deployed runtime could not have thrown there. What the sources genuinely must
be present for is the BUILD — which is why
`packages/frontend/Dockerfile` copies `docs/` into its builder stage, and why a
test asserts that COPY covers every allowlisted source. Without it,
`docker compose build frontend` fails with `ENOENT`, a hard build failure
rather than a soft 404.
Tests get the same files from `vitest.global-setup.ts`, because a test that
asserts on build output must not depend on a build having happened. A hand-copied doc is a doc that goes stale silently; this one
cannot, because it does not exist in the repository.

**The allowlist in that script is the control.** `docs/contributing/` and
`docs/operations/` are deliberately absent — they are addressed to people who
work on Haven and carry internal URLs, runbook steps and operator state.
Adding a doc is a decision someone makes on purpose, and the build **fails**
if an allowlisted doc's `status` is not `current`: a superseded document must
never be served as the product answer.

**Relative links are rewritten, and the served copy is therefore not byte-identical.**
Every one of these sources links to siblings by relative path, and most of
those targets are not served — copying verbatim would publish
`](../regulatory/casp-risk-guardrails.md)` to an agent, which resolves against
the serving origin and 404s. That is the defect
[#2520](https://github.com/d-hinders/Haven-AI/issues/2520) removed from the
discovery artifacts, and re-introducing it through a copy step would be the
same lie in a new place. A link to another served doc becomes its served path;
everything else becomes a repository URL, which works because the repository is
public. `packages/frontend/src/lib/__tests__/served-docs.test.ts` asserts that
no unresolvable relative link survives.

**Copy-lint does not scan the served copies, deliberately.** Its `SCAN_FILES`
entries must exist in a checkout (it fails on a missing target, by design), and
these files exist only after a build. The sources are governed by this system —
front matter, `covers:`, and the coupling gate — which is the stronger
instrument for a document anyway.

## Check layers

### Phase 1 — deterministic checks (this PR)

Run by `.github/workflows/docs.yml` on **every** pull request:

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | **Blocking** |
| `packages/**` Markdown boundary ([#2088](https://github.com/d-hinders/Haven-AI/issues/2088)) | `scripts/docs/package-docs.mjs`, run from `validate-frontmatter.mjs` | **Blocking** |
| Agent-skill structure + adapter alignment | `scripts/docs/validate-agent-skills.mjs` | **Blocking** |
| Agent-facing README section, six copies ([#2533](https://github.com/d-hinders/Haven-AI/issues/2533)) | `scripts/docs/validate-readme-agent-section.mjs` | **Blocking** |
| `last-verified` chain integrity ([#1843](https://github.com/d-hinders/Haven-AI/issues/1843), [#2477](https://github.com/d-hinders/Haven-AI/issues/2477), [#2504](https://github.com/d-hinders/Haven-AI/issues/2504)) | `scripts/docs/chain-integrity.mjs` — **retired** by [#2681](https://github.com/d-hinders/Haven-AI/issues/2681); `validate-frontmatter.mjs` rejects a reintroduced `verified:` block | Retired |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Retired UI merge-gate wording ([#2657](https://github.com/d-hinders/Haven-AI/issues/2657)) | `scripts/docs/ui-gate-wording.mjs` | **Blocking** — and since [#2747](https://github.com/d-hinders/Haven-AI/issues/2747) its `--update` **refuses to raise** the baseline, like the OTHER five gates on `scripts/lib/ratchet.mjs` it now imports from rather than cloning. `covers-gaps.mjs` is the deliberate seventh: it keeps its own `hasShrunk` because its baseline stores gap FILES rather than counts, and it already refuses a rise (`--accept-new` is the explicit override, [#2679](https://github.com/d-hinders/Haven-AI/issues/2679)). Since [#2759](https://github.com/d-hinders/Haven-AI/issues/2759) the shared engine validates the baseline's SHAPE on read, so a malformed entry fails loudly instead of allowing everything for that key |
| `covers:` gaps — a doc naming a file its `covers:` cannot reach ([#2679](https://github.com/d-hinders/Haven-AI/issues/2679)) | `scripts/docs/covers-gaps.mjs` | **Blocking** (shrink-only baseline) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**`) | Advisory |

All five blocking scripts need no npm dependencies and finish in seconds, which is why the
`pull_request` trigger carries **no `paths:` filter** — a required check must
report on every PR or auto-merge deadlocks waiting for a run that never happens
(the #933 lesson; see [`autonomous-pr-loop.md`](autonomous-pr-loop.md) §One-time
setup). Add **Docs front-matter & agent skills** to the "Haven automerge rules"
ruleset for the blocking column above to be true.

The archive-integrity probe (`retire-verified-chains.mjs verify()`, driven by
its test) runs in the docs unit tests — which are the *Test the docs validators*
step of the same required job, `if: always()` and without `continue-on-error` —
so a hash mismatch in the historical archive or a reintroduced `verified:` block
fails the required check like any other docs test. It is not a separate
`docs:check` step.

### Empty-coverage disposition (#2681)

The #2678 baseline counted eleven governed `covers: []` docs. One of those,
`docs/contributing/code-quality-loop.md`, was folded into the quality-scan
reference and archived by #2640 before this retirement landed; the remaining
ten are current and now declare the real surface each document references.

| Document | Disposition | Destination / declared surface |
| --- | --- | --- |
| `docs/contributing/code-quality-loop.md` | fold + archive | `.agents/skills/quality-scan/references/discovery-method.md` (#2640) |
| `ABOUT_HAVEN.md` | cover | `docs/product/README.md` |
| `docs/README.md` | cover | `docs/contributing/docs-quality-system.md` |
| `docs/contributing/ship-playbooks/backend.md` | cover | `packages/backend/src/openapi/**` |
| `docs/contributing/ship-playbooks/docs.md` | cover | `scripts/docs/**` |
| `docs/contributing/ship-playbooks/frontend.md` | cover | `docs/product/**` |
| `docs/contributing/ship-playbooks/money.md` | cover | `.github/money-path-globs.json`, `docs/regulatory/casp-risk-guardrails.md` |
| `docs/contributing/ship-playbooks/sdk.md` | cover | published package source directories |
| `docs/operations/demo-agent-purchase-runbook.md` | cover | demo merchant and reporting source directories |
| `docs/product/agent-passport.md` | cover | `docs/architecture/11-agent-passport-schema.md` |
| `docs/regulatory/casp-changelog/README.md` | cover | `docs/regulatory/casp-changelog/**` |

Until [#1023](https://github.com/d-hinders/Haven-AI/issues/1023) these ran as a
hard gate only inside `ship-next`, which made the canonical workflow stricter
than opening a pull request by hand — a standard's enforcement should not depend
on which tool opened the PR.

Vale is scoped to `docs/product/**` on purpose: engineering docs legitimately use
"Safe", "AllowanceModule", and "signer", so the terminology rule must not flood
them.

#### The `packages/**` Markdown boundary ([#2088](https://github.com/d-hinders/Haven-AI/issues/2088))

Everything above enumerates `docs/**` plus the four root gravity files — 89 files.
The repo holds **322** Markdown files. The other 233 were not merely unchecked;
they were outside the system entirely: no `owner`, no `covers`, no
`last-verified`, never implicable by the coupling gate, skipped by the staleness
audit (which `continue`s on an empty `covers`), and pointed at by no gate.

That is the same shape [#1993](https://github.com/d-hinders/Haven-AI/issues/1993)
closed one bucket in — *a system reporting success about the part it can see* —
and it had already bitten: `packages/qa-agent/README.md` described three
legacy-rail QA legs as live long after
[#1986](https://github.com/d-hinders/Haven-AI/issues/1986) made all three
impossible, and a human found it
([#1992](https://github.com/d-hinders/Haven-AI/issues/1992)).

**The fix is not a bigger scan.** Sweeping every Markdown file into front-matter
would manufacture ceremony on files that have no code mirror, and a requirement
nobody can satisfy gets bypassed — the next contributor adds a blanket ignore
and the system ends up weaker than before. What is enforced instead is that the
**boundary** is declared. `scripts/docs/package-docs.mjs` holds two sets, and
every `packages/**/*.md` must be in exactly one — enforced by
`checkPackageDocBoundary` in both directions and pinned by
`scripts/docs/package-docs.test.mjs` (#2680) — with one narrow exception
added by [#2532](https://github.com/d-hinders/Haven-AI/issues/2532): a path
under a declared `GENERATED_MARKDOWN_PREFIXES` entry is excluded from the
enumeration altogether, because a generated file has no decision for anyone to
make. It is not in git, does not exist in a fresh checkout, and the exemption
map itself errors on a path that does not exist. A prefix qualifies only if the
output is regenerated on every build AND gitignored; anything a human can edit
stays in the boundary:

- **`GOVERNED_PACKAGE_DOCS`** — the eight package-root READMEs, each with real
  `owner` / `status` / `covers` / `last-verified`. Five are the npm landing pages
  for `@haven_ai/sdk`, `signer`, `mcp`, `connect` and `cli` — user-facing
  contracts that can go stale and mislead; three are the hosted MCP server, the
  demo merchant and the QA harness. All eight become implicable by the coupling
  gate and rankable by the staleness audit.
- **`EXEMPT_PACKAGE_DOCS`** — the seven entries outside the system, each with a
  written reason. Most are notes to the next maintainer of one directory: that
  has no code mirror worth coupling, and a `covers:` there would fire on every
  edit and be dismissed every time, which is how a gate teaches people to ignore
  it. Two are served public artifacts (`402.md`, `for-agents.md`) whose audience
  is a model mid-task, so front-matter would be tokens it pays for and cannot
  use — and the second is generated from an SDK constant, pinned by a parity
  test rather than by this gate.

A file in neither set is a **named blocking error**, so a new `packages/**/*.md`
cannot land silently outside both — that, not the size of the enforced set, is
what closes the gap.

Two deliberate choices, stated so the design is not re-litigated by guess:

1. **Metadata lives in a manifest, not in front-matter.** A `---` YAML block at
   the top of a published README renders — as a metadata table on GitHub, and as
   loose text under a horizontal rule wherever the renderer has no front-matter
   plugin. Defacing a user-facing artifact to satisfy an internal hygiene gate is
   the wrong trade. The manifest uses the *same four keys*, so a reader who knows
   one knows the other, and it is the "one reviewable place" #2088 asked for.
2. **No package doc is a `contract: true` blocking doc.** They are advisory
   implications: the aim is to put a drifting README in front of a reviewer, not
   to fail every PR touching `packages/sdk/src/**` until someone edits prose.

`last-verified` for these eight is **seeded from each file's last commit date**,
not from a verification pass in #2088 — registering a doc is not verifying it,
and the staleness audit ranks on that date, so a rubber stamp would be worse than
a stale one. The first PR the coupling gate implicates re-reads the body and
bumps it.

**What the boundary does not reach**, enumerated in
`boundaryScopeNotes()` in the manifest itself rather than only here, so a green
run cannot be over-read: `.agents/**` and `.claude/**` (32 files, already
enumerated by `validate-agent-skills.mjs`, which checks the structure those files
actually have); `.github/**` and `scripts/README.md` (4 files, the same class as
the exempt entries, left out to keep this one population wide); and *behaviour* —
registration makes a doc implicable, it does not read the prose. Nothing here
would have caught #1992 on its own; it would have put the file in front of a
reviewer, which is the whole claim.

#### `last-verified` chain integrity ([#1843](https://github.com/d-hinders/Haven-AI/issues/1843))

**Retired by [#2681](https://github.com/d-hinders/Haven-AI/issues/2681)
(PR #2775, 2026-09-09).** The heading stays so older links resolve; what follows
is the record, not a live rule.

**What it was.** Every other check here asks whether a doc was **touched** or
whether its header **parses**; none asks whether it still says what it said. The
chain was the answer: each doc's `last-verified` carried a list of what each
re-verification pass had read and had *not* re-verified, and
`scripts/docs/chain-integrity.mjs` ran three checks on every PR — no prior entry
dropped (#1843), no entry duplicated (#2477), every prior entry byte-verbatim in
the new list (#2504). #2637 moved the chain from one hand-packed comment line to
a `verified:` list, one entry per line. That did not make concurrent entries
merge — two branches inserting different lines at the same anchor still conflict
in git's line merge, measured both orderings — but it turned the conflict into a
two-line hunk resolved by keeping both, instead of one rewritten multi-KB line;
and the byte ceiling (#2477, #2562) went away.

**Why it was retired.** The chain recorded what a session *said* it re-read; it
could be satisfied by writing a sentence, and it never asserted a note was true;
the retrospective's evidence points the same way — across the three skill PRs
(#2499, #2500, #2501) every wrong claim was caught by an independent read and
none by a gate. It had grown to 74,442 words (504,844 bytes) across the 72
governed docs — `npm run docs:measure` at `1671d2bf`, the 2026-09-08 tree #2681's
re-measure names; the metric now reports 0 by construction, since the splitter
returns an empty chain — larger on `CLAUDE.md` than the manual it annotated, and on
`CLAUDE.md` and `AGENTS.md` that annotation loaded into every session and every
reviewer pass. The question it stood in for — *is this claim still true* — is
answered by the `covers:` gap check ([#2679](https://github.com/d-hinders/Haven-AI/issues/2679))
and by the test-pinned claims that [#2680](https://github.com/d-hinders/Haven-AI/issues/2680)
moved out of prose, neither of which a sentence can satisfy.

**What replaced it.**

- Every governed doc keeps `last-verified: "YYYY-MM-DD"` and nothing else on
  that key. `validate-frontmatter.mjs` rejects a `verified:` block and rejects an
  inline `#` annotation on the scalar, naming the archive in the error.
- Every chain was moved **verbatim** to
  `docs/archive/last-verified-chains-2026-09.md`, one combined archive grouped
  by doc. `scripts/docs/retire-verified-chains.mjs` did the move and asserts
  byte equality; its test pins the section count and each section's inline
  SHA-256 marker, so a deleted section or an edited block is a red docs test
  rather than a green nothing.
- `git log -p -- <doc>` still holds every entry with the diff it accompanied.
  That, plus a grep over the archive, is the forensic path the chain used to
  provide inline.

**What was learned, kept here because it still applies to the checks that
remain.** A check that reads text *about* a thing rather than the thing lets a
sentence stand in for the work (#2323, and the chain's own `chain-reset` hatch
one level down). A base refresh resolved by hand can keep a marker while
rewriting what it marks (#2504). A diff-scoped check examines nothing about a
defect an earlier merge left behind. Each of these shaped the gates that
survive: the `covers:` gap check reads the body against the file system, the
coupling gate reads the diff against the mapping, and neither accepts prose as
evidence.


#### `covers:` gaps ([#2679](https://github.com/d-hinders/Haven-AI/issues/2679))

`covers:` is **declared, not derived**. A doc can assert something about a file
it never lists, and then nothing implicates it when that file changes — the
coupling gate's silence on such a file is the absence of a mapping, not
evidence. That is how `CLAUDE.md`'s `remove_passkey` sentence stayed false for
24 days ([#1199](https://github.com/d-hinders/Haven-AI/issues/1199)): the hybrid-signer
rail file was named in `CLAUDE.md`'s body and absent from its `covers:`. It is
in `covers:` today, which is what that fix was.

That sentence is also this check's first catch. Written with the full path in
it, `covers-gaps.mjs` reddened on **this** document — an eighth gap against a
baseline of seven — on the pull request that added the check. It was resolved
the way the failure message's second remedy says: the claim was deleted, not
declared, because this document has no business asserting anything about that
rail file. The path is one hop away in `CLAUDE.md`, where it is covered.

`scripts/docs/covers-gaps.mjs` extracts path-like tokens from each governed
doc's **body** (a `packages/`, `scripts/` or `.github/` prefix plus a code
extension), intersects them with `git ls-files` so only real tracked files
count, and subtracts everything the doc's own `covers:` globs already reach —
glob-expanded through the same `globToRegExp` the coupling gate uses, so
"uncovered" means exactly "the coupling gate will not implicate this doc when
that file changes".

A gap has **two legitimate remedies and the failure message names both**:
declare the path in `covers:`, or **delete the claim** because the doc should
not be asserting it. The second is the one
[#2678](https://github.com/d-hinders/Haven-AI/issues/2678) prefers — that epic
is net-reducing, and a check that only ever grew `covers:` lists would work
against it.

The baseline (`scripts/docs/covers-gaps-baseline.json`) is **shrink-only** and
stores **doc → the gap FILES**, not a count. It was a count first, in the house
style of `ui-gate-wording-baseline.json`, and a review of the shipping PR proved
that shape cannot do the job: a doc could **close one gap and open a different
one in the same edit** — totals unchanged, no shrink hint, a brand-new false
claim about a file it had never mentioned, accepted in silence. That is the
#1199 shape this check exists for, walking through the check. Identity closes
it, and `covers-gaps.test.mjs` pins the swap case directly. `--update` refuses
a rise outright (`--accept-new` is the explicit, reviewed override) rather than
writing it under the word "ratcheted". Seeded at **129 pairs across 40 of 73
governed docs**.

**The governed set here is this check's own definition, not an inherited one.**
`validate-frontmatter.mjs` governs **97** docs and applies no status carve-out;
`covers-gaps.mjs` additionally drops `status: archived` and `status: research`,
which is what gives 73 (= 97 − 11 archived − 13 research). Saying otherwise
would make the next paragraph read as somebody else's decision.

That filter is an **unguarded bypass**, and it is stated rather than hidden:
nothing constrains `status: archived` outside `docs/archive/` — there is a live
precedent in `docs/operations/session-rail-vendor-ops.md` — so flipping one word
in a doc's front matter removes it and every gap it carries from the check.
The tool no longer misreports that as progress: a doc carrying that status
outside the archive folders is named in a **"no longer governed"** list and
excluded from the "residue shrank" hint that would otherwise invite an
`--update` discarding those gaps permanently. The list is built from the docs
actually dropped, **not from the baseline's keys** — reading the baseline alone
made the report silent for the 33 of 73 governed docs that have no baseline
entry, which is most of them.

**An over-broad `covers:` glob was the same bypass through a wider door, and it
is refused rather than disclosed.** Declaring `packages/**`, `scripts/**` and
`.github/**` closes every gap a doc has or will ever have — and because closing
gaps is what progress looks like, the run reported "residue shrank" and invited
an `--update` locking the loss in. That is strictly worse than the archived
flip, which at least prints a line. Refusing it cost nothing: **0 of 73**
governed docs declare a bare scan prefix today, against 33 that use some `**`
glob, so the zero is a measurement and not a broken instrument.
`packages/backend/**` remains perfectly legal — the guard catches only the bare
prefixes, which are not a description of coverage but an opt-out written as
one.

**What this does not catch** is listed in the script's header and pinned by
`covers-gaps.test.mjs`. False negatives in the extraction: a path split across a
hard wrap or by inline markup, a path outside the three prefixes, a path with no
code extension, a package-relative path, and a file that no longer exists. And
one false POSITIVE class, since a list of only false negatives implies a
precision the check does not have: a path inside an illustrative fenced
`covers:` example is counted as a claim. This document is its own example —
its front-matter schema block names `packages/backend/src/routes/payments.ts` as
a placeholder and that line is in the baseline. The count is a floor, not an
inventory, and the baseline must not be read as completeness.

#### Reproducing the #2678 baseline — `npm run docs:measure`

Four read-only, dependency-free scripts under `scripts/docs/measure/` re-derive
every figure in epic [#2678](https://github.com/d-hinders/Haven-AI/issues/2678):
corpus and chain mass, the derivable-claim census, the `covers:` gaps (the same
implementation `docs:check` runs, so the gate and the measurement cannot
disagree), and the correction rate. They gate nothing and write nothing.

Each script prints the epic's own figure next to its own and says which
reproduce. Three did not and were corrected in the epic body rather than fitted
to: the "63 declared `covers:` entries" is a count of **governed docs declaring
at least one entry** (73 governed − 10 with `covers: []`), not of entries —
there are **807** of those; the 227 gap pairs are **129** under glob-expanded
subtraction; and three of the seven claim classes have no reproducible
definition.

### Phase 2 — coupling gate + drift tests ([#644](https://github.com/d-hinders/Haven-AI/issues/644))

**Coupling gate** (`.github/workflows/docs-coupling.yml` →
`scripts/docs/coupling-gate.mjs`): on every PR, finds docs whose `covers` globs
match a changed file the PR did **not** also touch, and posts a single advisory
sticky comment naming each doc and its `last-verified` age. It also reports the
reverse edge: when a governed doc changes, the same comment names its declared
`covers` entries so a reviewer can re-check the code claims against the diff.
This reverse report is advisory-only and does not make an edited contract doc
block the PR.

**Only `current` docs are governed (#2638).** A doc whose front-matter `status`
is `archived` or `research` is skipped by the gate in **both** directions, and by
the weekly staleness audit. Neither can be stale in the sense these tools
measure: an `archived` doc describes how something *used* to work, so "the code
moved on" is its defining condition rather than its defect, and a `research`
spike or pilot report is a dated record of what was true when the investigation
ran — re-verifying it against today's code would destroy what makes it useful.
The predicate is `isGoverned(status)` in `coupling-gate.mjs`, with the same rule
inlined in `audit-staleness.mjs`.

Two things worth knowing rather than assuming. **The two halves are not
symmetric:** measured when this landed, *no* `archived` doc declared `covers:` at
all, so that half changes nothing today and exists so a future archived doc that
keeps its `covers:` does not start firing; the work is in the **research** half,
where nine docs declared 30 `covers:` globs between them. And **a doc with no
`status` is treated as governed** — the validator requires the field, so a
missing one is a broken doc rather than an exemption, and failing open would let
a front-matter error silently drop a doc out of the gate.

**Editing the gate itself is a money-path change (#2200).**
`scripts/docs/coupling-gate.mjs`, `scripts/docs/validate-frontmatter.mjs` and
`.github/workflows/docs-coupling.yml` are `controlGlobs` in
[`.github/money-path-globs.json`](../../.github/money-path-globs.json),
so a PR touching any of them gets the `money-path` label and the
[`money.md`](ship-playbooks/money.md) playbook — a human read, but no
`qa-freshness` QA re-run, since re-running the money-flow harness proves nothing
about a docs gate. The reason is that this gate is what forces a money-path PR to
write its CASP perimeter analysis, so weakening it weakens that discipline;
`validate-frontmatter.mjs` is listed because the gate imports its
`globToRegExp`/`parseFrontMatter` and can therefore be disabled from outside
itself, and the workflow because its `contract` job is what makes the script a
**required** check.

**Run `npm run docs:coupling` locally — it is the strict, CI-equivalent form.**
The bare `node scripts/docs/coupling-gate.mjs` is the *advisory* posture: it always
exits 0, so it does not tell you what CI will say. Since Phase 4 the same script
also runs `--strict`, where a `contract: true` doc is **blocking** (see below).
`--changed=path/a,path/b` still forces an explicit file list.

With no `--changed` and no `BASE_SHA`, the candidate set is the working tree —
`origin/dev...HEAD` **plus** staged, unstaged and untracked files. Committed
changes alone reported "no covered docs implicated" for an uncommitted diff, and
that false green is how [#1076](https://github.com/d-hinders/Haven-AI/pull/1076)
reached CI with an untouched contract doc ([#1077](https://github.com/d-hinders/Haven-AI/issues/1077)).
For the same reason an empty candidate set is reported as "nothing was checked"
and fails closed under `--strict`, rather than passing.

**There is no same-day suppression** ([#1824](https://github.com/d-hinders/Haven-AI/issues/1824)).
A doc is implicated whenever a changed file matches its `covers` globs and the
PR did not also touch the doc — whatever the doc's `last-verified` date says,
including today's. The heuristic that used to skip a doc stamped today was
removed outright, and so was the `--strict` carve-out that existed only to keep
it away from the blocking half.

The mechanical reason it could never be right: a doc *this* change verified is a
doc *this* change edited, and the gate already skips docs the PR touched. So the
only suppression the heuristic could still perform was on a stamp written by
somebody else's work — the situation [#1077](https://github.com/d-hinders/Haven-AI/issues/1077)
had already ruled unacceptable for the blocking half. It was not mostly-right
with an edge case; its entire live domain *was* the edge case. Measured before
removing rather than argued: across the 40 merges into `dev` in the window
ending at `0d299034`, it hid 22 advisories over 15 merges — and zero blocking
findings, which matches what the code already guaranteed structurally. Those
counts describe this repository's traffic in that window, not a standing number;
re-derive them if they ever have to carry an argument again.

The `today` parameter was **removed** from `implicatedDocs` rather than left
accepted-and-ignored, so reintroducing the behaviour is a visible change rather
than a one-line revival. `last-verified` dates are still read — `ageDays` reports
each implicated doc's staleness in the advisory comment, where a wall-clock
skew of a day never changes an outcome.

#### Queue-framing census ([#2107](https://github.com/d-hinders/Haven-AI/issues/2107))

The [queue-framing census](../../scripts/ci/queue-framing-census.test.mjs) runs
in the every-PR `ci_config_checks` job and checks a small, explicit
`GUARDED_FILES` list, including agent-facing surfaces no `covers:` glob names.
It is deliberately zero-tolerance rather than a shrink-only baseline: a guarded
file either has no queue-and-approve phrase hit or cannot join the list.

The two checks answer different questions. The coupling gate asks whether a
doc that describes changed code was touched; the census asks whether selected
prose is absent. **Neither establishes that the prose which remains is true** —
that needs the per-claim evidence and review in the shipping PR. The census also
cannot cover a surface whose job is to describe the retired rail: a substring
scanner cannot distinguish a correct retirement record from a false live claim.
That deliberate gap includes the architecture and operations docs, the root
README and OpenAPI spec; [#2121](https://github.com/d-hinders/Haven-AI/issues/2121)
is the live example of the claim-level drift that can still pass both checks.

**Scoping `covers` (#1077).** `covers` means *this doc describes that code*, not
*this doc applies to that code*. A standing checklist that globs
`src/components/**` fires on every frontend PR and buries the one ⚠️ finding that
mattered — so scope a checklist to the design system it checks against **plus the
money and authority screens it actually contains rules about**, not to every
screen it is applied to. Narrowing to zero is the opposite failure: a doc that
matches nothing never gets the doc-reviewer nudge, so keep a real net.
Two related rules the gate applies for you:
test files and generated files (`__tests__/`, `*.test.*`, `*.spec.*`,
`__screenshots__/`, `packages/core/src/api-types.ts`) implicate a doc only when
`covers` names the path **exactly** — a wildcard does not sweep them up, since
prose is not made stale by a test being added; and a `#` comment may only trail
a `covers` item, never occupy its own line, which would silently truncate the
list.

The incidental-path filter is the one place `--strict` still behaves
differently, and in the opposite direction to the suppression it replaced: a
`contract: true` doc under `--strict` skips the filter entirely and sees every
changed file its globs match, incidental or not. Without that, a test-only PR
against a wildcard-covered money-path package (`packages/sdk/src/**`,
`packages/signer/**`) passes the blocking gate silently.

That list has one deliberate carve-out and one carve-out *from* the carve-out,
and the order between them is load-bearing. Packages whose **content is tests**
— `packages/qa-agent/**` and `packages/frontend/e2e/**` — are never incidental:
those scenarios and specs are what their runbooks (`agent-qa.md`,
`e2e-qa-runbook.md`) document, not a test of some other source, so treating them
as incidental would silently un-cover the docs that describe them. But
`__screenshots__/` is checked **first**
([#1854](https://github.com/d-hinders/Haven-AI/issues/1854)), because Playwright
writes the committed visual-regression baselines *inside* the e2e tree
(`snapshotPathTemplate` in `packages/frontend/playwright.config.ts`) and the
*Update visual baselines* workflow commits them. Those PNGs are generated and
described by no runbook, so before #1854 every baseline regeneration implicated
`docs/bug-reports/_run-report-template.md` — noise on a whole class of PR. An
e2e **spec** change still implicates the runbooks, unchanged.

**Drift tests** (`packages/backend/src/docs-drift/`): vitest tests, modeled on
the OpenAPI drift test, that pin hand-maintained doc/config claims to the code
they mirror:

| Mirror | Pinned to | Test |
| --- | --- | --- |
| `CLAUDE.md` API surface table | `openapiSpec.paths` (path + method) | `docs-drift.test.ts` |
| `CLAUDE.md` chain claims (Base 8453 / Gnosis 100) | `domain/chains.ts` registry | `docs-drift.test.ts` |
| `.env.example` documented keys | env vars read in the code (`process.env.X`, `requireEnv`/`optionalEnv`) | `env-example-drift.test.ts` |

The `.env.example` mirror is two-directional: every var the **backend** reads
must be documented, and every documented key must be read **somewhere** in the
repo (backend, frontend, scripts, or the qa/demo packages) — so config docs
can't silently drift from what a deployment actually reads.

Each carries a `because:` allowlist for intentional exceptions — the default is
"document it correctly" / "delete the dead key", not "add an exception". The
`.env.example` allowlists are self-checked so they can't rot: an entry that no
longer applies (the var is now documented, or is no longer read) fails the suite.

### Phase 3 — `haven-doc-reviewer` agent ([#645](https://github.com/d-hinders/Haven-AI/issues/645))

The canonical `haven-doc-reviewer` role under
`.agents/skills/haven-agent-workflow/references/` is read-only. Given a diff, it
derives its scope from the diff's **claims** — sweeping `docs/**`,
`packages/**/*.md`, code comments and JSDoc, fixtures, skill text and CASP
shards for every place a claim is repeated — with the coupling gate's
`covers:`-implicated list as the **floor**, not the scope
([#2499](https://github.com/d-hinders/Haven-AI/issues/2499): the stale copies
that survived first passes on #2242, #2408 and #2422 all sat in files the gate
does not name). It reports any **specific** claim the diff made stale, missing,
or broken — with the smallest correct update — re-runs every re-runnable figure
the diff quotes, derives `covers:` from the body of any contract doc it reviews,
and binds its verdict to the reviewed head via `scripts/ci/review-isolation.mjs`.
It's wired into the agentic workflow (`ai-agent-workflow.md`) and the autonomous
loop (`autonomous-pr-loop.md`): run the doc reviewer after implementation and
update the docs it finds stale before opening the PR — the docs the coupling gate
flags are the floor of that set, not the whole of it. Advisory in this phase —
it never blocks auto-merge.

### Phase 4 — promotion + audit cron ([#646](https://github.com/d-hinders/Haven-AI/issues/646), shipped 2026-07-18)

Two mechanisms, both live:

- **Contract docs block.** A doc marked `contract: true` in front-matter is
  promoted from advisory to blocking: the `Contract-doc coupling` job in
  `docs-coupling.yml` reruns the gate with `--strict`, which exits 1 when a
  contract doc's covered code changed but the doc wasn't touched in the PR
  (a crash also fails closed in strict mode). The fix is always in-PR: update
  the doc, or genuinely re-verify it and bump `last-verified`. The advisory
  comment marks contract findings with ⚠️. Initial contract set:
  `dev-environment`, `branch-and-release-flow`,
  `delegation-rail-security-model`, `casp-risk-guardrails`,
  `mcp-runtime-compatibility`. **Operator note:** the check must be added to
  the "Haven automerge rules" ruleset's required checks — without a paths
  filter (the #933 lesson).
- **Weekly staleness audit.** `scripts/docs/audit-staleness.mjs` ranks every
  covered, non-archived, non-research doc by commits touching its `covers:` paths since its
  `last-verified` date. `docs-audit.yml` runs it Mondays 06:00 UTC and upserts
  the report into one tracking issue ("Docs staleness audit (weekly)") — a
  standing queue of which doc is most likely lying, never a spam of new
  issues. Run it locally anytime: `node scripts/docs/audit-staleness.mjs`.
  It ranks `current` docs only — `archived` and `research` are skipped, per
  *Only `current` docs are governed* above.
- **The audit is read at promotion (#2638).** A standing queue nobody is
  required to read is a backlog, not a gate, so
  [`../operations/promoting-dev-to-main.md`](../operations/promoting-dev-to-main.md)
  carries a checklist item: open the tracking issue and give every ranked doc a
  disposition — the three of [`ship-next` § *Filing bar*](../../.agents/skills/ship-next/SKILL.md#filing-bar-2767)
  (#2767): **fix** it, **drop** it with a reason recorded in the promotion PR, or
  **file** it only above the bar (a doc claim on its own does not). This is
  the counterpart to contract-doc blocking, and the division of labour is the
  point: a `contract: true` doc is stopped on the PR that made it stale and
  never reaches promotion, while **non-contract** docs are deliberately allowed
  to drift on `dev` between promotions, and this is the one place that drift is
  swept.
