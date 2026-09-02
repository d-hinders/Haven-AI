---
owner: "@d-hinders"
status: current
covers:
  - scripts/docs/**
  - scripts/ci/queue-framing-census.test.mjs
  - .github/workflows/docs.yml
  - .github/workflows/docs-coupling.yml
  - .agents/skills/haven-agent-workflow/references/doc-reviewer.md
  - .vale.ini
  - .lychee.toml
  - .markdownlint.json
  - .github/vale/**
  - packages/backend/src/openapi/spec.test.ts
  - packages/backend/src/docs-drift/docs-drift.test.ts
  - packages/backend/src/docs-drift/env-example-drift.test.ts
  - .env.example
last-verified: "2026-09-02" # #2300: the pin-scope sentence in the `covers:` front-matter bullet updated from "30 of the 46 globs" to "31 of the 47" (33 runtime globs after `packages/mcp-server/src/**` joined the money-path list; the two EXEMPT entries and the 14 controlGlobs are unchanged). Scope: that sentence only; nothing else re-verified in this pass. Prior: #2375: the one sentence in § *`last-verified` chain integrity* that named `product/design-system.md` oldest-first is corrected — it reads newest-first, exactly like `mcp-runtime-compatibility.md` (proven from git history on this branch: each of the last six commits touching `design-system.md` put its own entry FIRST on the line, `#2241` over `#2318` over `#2251` …), and the sentence now tells the reader to take the direction off the `Prior:` markers rather than off this doc, since a hard-coded example is a second copy that drifts. Scope: that sentence only; nothing else in Phases 1-4 re-verified in this pass. Prior: #2323: Phase 2's `satisfied-by` documentation re-read against `scripts/docs/coupling-gate.mjs` on this branch and extended for the shard-clears-the-BLOCKING-half-not-the-doc change: the measured pre-#2323 behaviour as a three-row table (an ADDED shard suppressed the parent in BOTH postures, so the doc was never named, not merely un-blocked), the #2274 reconstruction that reproduces it (15 advisory docs listed and neither shard-cleared contract doc among them), the four things #2323 changed or deliberately did not, and an explicit statement of what an advisory section is worth — the doc-reviewer ROUTING is the mechanical half, naming the doc is the ceiling. Adds the self-satisfying-shape survey (covers:, chain-integrity's containment + chain-reset hatch, EXEMPT_PACKAGE_DOCS, the advisory job) so it is not re-derived. Scope: Phase 2's `satisfied-by` subsection, PLUS one corrected count in Phase 1 — its `EXEMPT_PACKAGE_DOCS` bullet said "the five nested directory notes" and the map holds six (counted via `Object.keys`, and `docs:check` prints "6 exempt" itself); found by haven-doc-reviewer on this PR, pre-existing and untouched by this diff, fixed here rather than left sitting in a file this pass bumps. Nothing ELSE in Phases 1, 3 or 4 was re-verified, and the Coupling-gate and same-day-suppression subsections above the new text were read only far enough to place it. Prior: #2088: Phase 1 gains the `packages/**` Markdown boundary — the population census (322 Markdown files, 89 enumerated), why the fix is a declared boundary rather than a bigger scan, the two sets in `scripts/docs/package-docs.mjs` and the line between them, the two design choices (manifest instead of front-matter, because five of these files are published npm landing pages; advisory rather than `contract: true`), why `last-verified` is seeded from each file's last commit rather than stamped today, and what the boundary deliberately does not reach. That section written against the new module on this branch; Phase 1's existing subsections re-read only far enough to place it. Nothing in Phases 2-4 re-verified in this pass. Prior: #2200: Phase 2's "Coupling gate" subsection gains the fact that the gate, its front-matter parser and the workflow that runs it are now money-path `controlGlobs` — editing either draws the label and the money.md playbook, and this doc describes that code, so a contributor reading it here should not first learn it from a surprise label. States why `chain-integrity.mjs` is excluded, so the omission reads as decided rather than forgotten. Scope: that subsection only; nothing else in Phases 1-4 re-verified in this pass. Prior: #2192: Phase 2's `satisfied-by` documentation re-read against `scripts/docs/coupling-gate.mjs` and updated for the added-file rule — a satisfying file must now be ADDED, not merely changed, because the old any-match test let an edit to an already-merged shard clear the blocking gate for an unrelated money-path PR (measured: exit 1 -> exit 0 on a one-character append). Records the two consequences a reader needs: the parent-doc edit remains the escape hatch, and a bare `--changed=` list keeps the pre-#2192 behaviour because it carries no add/modify status. The front-matter schema example's `satisfied-by` comment corrected in the same pass. Nothing else in Phases 1-4 re-verified. Prior: #2124: Phase 2's queue-framing-census subsection re-read against `scripts/ci/queue-framing-census.test.mjs` and `.github/workflows/ci.yml`; records the census's guarded-files boundary, its every-PR CI home, and why it is neither the coupling gate nor claim-truth verification. Prior: #1993: added the empty-`covers` reason rule to the front-matter schema section, describing the new BLOCKING check in `scripts/docs/validate-frontmatter.mjs` (a `covers: []` must carry an inline `# reason`), why it is enforced rather than encouraged (a doc with `covers: []` looks governed while no coupling gate can implicate it — strictly worse than no front-matter, which is at least visibly outside the system), and its SCOPE (`docs/**` plus the four root gravity files; Markdown under `packages/**` has no front-matter and is outside the system entirely). That section re-read against the validator on this branch. Nothing else in Phases 1-4 re-verified in this pass. Prior: #1885: Phase 1 §"Finding a break that is already on `dev`" re-read against `scripts/docs/chain-sweep.mjs` and `chain-integrity.mjs` on `origin/dev` — records that the sweep now classifies a DECLARED RESET separately from an unrestored break (`N unrestored, M declared reset`), why the blanket `nowLine` check was rejected (one declared compaction would excuse every break in the doc, a false negative in the tool built to find silent losses), and the binding actually used (the commit that INTRODUCED the declaration). Also records `--ref=` and the `--follow` rename residual with the measurement that shows it currently empty. Nothing in Phases 2-4 re-verified in this pass. Prior: #1869: Phase 2 §"Coupling gate" re-read against `scripts/docs/coupling-gate.mjs` on `origin/dev` (not against #1824's description of itself) — the same-day-suppression paragraph #1854 flagged and left is REPLACED, because `implicatedDocs` no longer compares `last-verified` to today and the `today` parameter is gone from its signature rather than accepted-and-ignored. The replacement states the behaviour and carries only the reasoning a reader needs (the heuristic's entire live domain was somebody else's stamp, since `changedSet.has(doc)` already covers a doc this change verified), and quotes the 22-advisories/15-of-40-merges/0-blocking measurement WITH its window (`0d299034`) because the docstring records the counts as traffic-dependent. The `--strict` carve-out the old paragraph described is genuinely gone; the one that REMAINS is different and now documented where it lives — a `contract: true` doc under `--strict` skips the incidental-path filter (`filterIncidental = !(strict && contract)`). Phase 1 also gains `scripts/docs/chain-sweep.mjs` (#1876) and the reason it is needed: a chain break already on `dev` is invisible to the diff-scoped check permanently, not merely deferred to the next editor. Nothing else in Phases 2-4 re-verified in this pass. Prior: #1854: Phase 2 §"Scoping covers" re-read against `scripts/docs/coupling-gate.mjs` — documents the test-content carve-out (`packages/qa-agent/**`, `packages/frontend/e2e/**`) and the `__screenshots__/` carve-out from it, which is checked first; the same-day-suppression paragraph in this section is STALE since #1824 and is NOT fixed here (#1869) — nothing else re-verified in this pass. Prior: #1843: Phase 1 re-read against `scripts/docs/*` and `docs.yml` — gains the `last-verified` chain-integrity check (third `docs:check` step, inside the existing required job, needs `fetch-depth: 0`), the `chain-reset` escape hatch, and why the rule is containment rather than #1843's proposed subsequence; nothing in Phases 2–4 re-verified in this pass. Prior: #1337: strict-gaten släpper en BEVISAT beräknad tom change-set (ren merge/sync-PR); okänd/trasig diff förblir fail-closed (#1076)
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
  doc owner under #1899), and **none of the 14 `controlGlobs`**, which the test
  deliberately leaves out as CI configuration the doc reasons about
  individually. Within that set it asserts every matched tracked file is also
  matched by some `covers:` glob. There is **no** assertion in the other
  direction, so an unrelated entry ADDED to `covers:` is checked by nothing —
  measured by appending a marketing-page glob and watching all 10 tests stay
  green. Nothing pins any other doc's `covers:` in either direction.
- **The `last-verified` chain check** (`chain-integrity.mjs`) — the strongest
  remaining instance. `checkChain` verifies **containment** (every issue
  reference in the prior line survives into the new one) and nothing whatsoever
  about whether the note is true; and the `chain-reset(#N)` escape hatch is
  written by the author who wants the chain dropped. Its failure mode is
  different from #2323's, though: losing history, not shipping a false claim.
  It already applies #2323's lesson one level down — `CHAIN_RESET_RE` requires
  the parenthesised issue number precisely so prose *about* a reset cannot excuse
  a real one.
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
npm run docs:check   # front-matter + covers globs, agent skills, last-verified chains
npm run docs:chain   # just the chain check, against origin/dev
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

`scripts/docs/chain-integrity.mjs` is the third `docs:check` step and is
described under [`last-verified` chain integrity](#last-verified-chain-integrity-1843)
below. Unlike the other two it reads **git history**, so it needs a base
commit: locally `origin/dev`, in CI `BASE_SHA`/`HEAD_SHA` with
`fetch-depth: 0`. Without one it says NOTHING WAS CHECKED and, in CI, fails —
a gate that cannot see the diff must never report a clean bill of health
(the #1076 lesson).

## Check layers

### Phase 1 — deterministic checks (this PR)

Run by `.github/workflows/docs.yml` on **every** pull request:

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | **Blocking** |
| `packages/**` Markdown boundary ([#2088](https://github.com/d-hinders/Haven-AI/issues/2088)) | `scripts/docs/package-docs.mjs`, run from `validate-frontmatter.mjs` | **Blocking** |
| Agent-skill structure + adapter alignment | `scripts/docs/validate-agent-skills.mjs` | **Blocking** |
| `last-verified` chain integrity ([#1843](https://github.com/d-hinders/Haven-AI/issues/1843)) | `scripts/docs/chain-integrity.mjs` | **Blocking** |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**`) | Advisory |

All three blocking checks need no npm dependencies and finish in seconds, which is why the
`pull_request` trigger carries **no `paths:` filter** — a required check must
report on every PR or auto-merge deadlocks waiting for a run that never happens
(the #933 lesson; see [`autonomous-pr-loop.md`](autonomous-pr-loop.md) §One-time
setup). Add **Docs front-matter & agent skills** to the "Haven automerge rules"
ruleset for the blocking column above to be true.

The chain check runs **inside that same required job** rather than as a job of
its own. A new job would be a new check name, and a check name that is not in
the ruleset blocks nothing — so the rule would have started enforcing on the
day someone remembered to edit the ruleset, not the day it merged. The cost of
folding it in is that its failures are attributed to a job whose name says
"front-matter"; the failure message names the doc and the dropped references,
so nobody has to guess which of the three spoke.

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
every `packages/**/*.md` must be in exactly one:

- **`GOVERNED_PACKAGE_DOCS`** — the eight package-root READMEs, each with real
  `owner` / `status` / `covers` / `last-verified`. Five are the npm landing pages
  for `@haven_ai/sdk`, `signer`, `mcp`, `connect` and `cli` — user-facing
  contracts that can go stale and mislead; three are the hosted MCP server, the
  demo merchant and the QA harness. All eight become implicable by the coupling
  gate and rankable by the staleness audit.
- **`EXEMPT_PACKAGE_DOCS`** — the six nested directory notes, each with a
  written reason. A note to the next maintainer of one directory has no code
  mirror worth coupling; a `covers:` there would fire on every edit and be
  dismissed every time, which is how a gate teaches people to ignore it.

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

Every other check here asks whether a doc was **touched**, or whether its header
**parses**. None asks whether it still says what it said — so a deletion is the
one edit that satisfies all of them at once. The coupling gate goes green
because the doc changed (exactly what it wanted), front-matter validation
because the header is still well-formed, and the staleness audit *improves*,
because the edit bumped `last-verified`.

That is not hypothetical. Resolving the #1832/#1841 collision on
`ship-playbooks/frontend.md`, a session **picked a side instead of chaining**
and deleted `#1816`'s chain entry, the §4 paragraph it pointed at, and a
post-review correction — all already merged on `dev`. Valid front-matter, 145
coherent lines, every gate green.

**The rule.** A `last-verified` note line is a chain, one entry per issue that
re-verified the doc (#1496). So:

> every issue reference on a doc's previous `last-verified` line must still
> appear on its new one.

Prepending and appending both satisfy it, so the check never has to know which
order a given doc uses — and **read the doc's own chain before you add to it**,
off the line itself rather than off a description of it: each `Prior:` marker
introduces an entry OLDER than the text before it, so the markers say which way
the chain runs. Both `mcp-runtime-compatibility.md` and
`product/design-system.md` read newest-first — the newest entry at the front,
every older one pushed rightward behind a `Prior:`, which is the #1496 prepend
convention. This sentence named `design-system.md` oldest-first until
[#2375](https://github.com/d-hinders/Haven-AI/issues/2375); an author who
trusted it would have appended into a prepended chain and produced two
interleaved ones. A hard-coded example is a second copy that drifts, so the file
is the authority and this line is not.

**Compacting a chain on purpose** says so on the line itself, which passes the
check and prints what was dropped:

```yaml
last-verified: "2026-08-22" # chain-reset(#1843): compacted, history in git log. #1799: …
```

The marker lives on the line rather than in a PR description so the excuse
lands in the diff of the file it excuses.

**What it deliberately does not do.** It is not a general "did prose disappear"
detector; it watches the one line where a lost entry is provable rather than
guessed. It also does not follow **renames**: a doc moved and chain-edited in
one pull request has no previous version at its new path, so that shape is a
known blind spot rather than a covered case. Two heavier designs were weighed in #1843 and rejected: a shrink-only
line-count ratchet on contract docs (more teeth, but it fires on every
legitimate deletion, and an escape hatch used routinely stops being read), and
surfacing deletions in the advisory coupling comment (nearly free, but the
incident's advisory comment was already green — a comment nobody must answer
would not have caught it).

The check is also **containment, not the order-preserving subsequence** the
issue proposed. Backtested over every feature PR merged into `dev` since the
chaining convention took hold, the ordering half caught zero real defects and
produced two false positives, both benign: a new note that CITES an older issue
in its prose ("#1816: … reuses #1800's mechanism") moves that reference to the
front without dropping anything. One of the two was the resolution that *fixed*
the incident.

A `dev → main` promotion pull request is exempt: its diff is weeks of history
that each `dev` PR already carried through this check, and no promoter can act
on a chain edited before the check existed. The exemption inherits this repo's
usual caveat — a commit that reached `dev` by direct push or admin merge was
never checked by any PR gate, this one included — so it is "already checked"
in the same sense every other gate here means it, not a stronger one. A
`hotfix/*` into `main` is real work and stays checked.

The measurement behind the containment decision is re-runnable rather than
quoted: `node scripts/docs/chain-integrity-backtest.mjs --since=<date>` replays
the check over merged pull requests. It is a development tool; nothing in CI
runs it.

**Finding a break that is already on `dev`
([#1876](https://github.com/d-hinders/Haven-AI/issues/1876)).** The check is
diff-scoped, so a chain broken by an earlier merge is examined by nothing —
and, because containment compares a contributor's new line against `dev`'s
current line, neither of which carries the lost reference, it does not surface
on the next edit either. It is silent permanently, not deferred. `node
scripts/docs/chain-sweep.mjs` replays the same exported containment rule over
every doc's own history and reports the drops whose references are still
missing today. Also a development tool, also not in CI, and also not
retroactive: it defaults to `--since=2026-08-15`, because before the chaining
convention (#1496) replacing the note *was* the convention and every doc reads
as broken. `--ref=<git ref>` picks the tree it sweeps, defaulting to
`origin/dev`.

**A declared reset is a separate class, not a silenced one
([#1885](https://github.com/d-hinders/Haven-AI/issues/1885)).** The sweep's
summary counts unrestored docs and declared-reset docs separately, and the
two are different findings. `chain-reset(#N)` is written on a doc's *current* line, while the
sweep replays *historical* pairs — so a marker added after the fact (both
#1496 compactions at `cf177982`, 2026-08-16, predate the marker syntax
introduced by #1843 at `178c67d0`, 2026-08-22) is invisible to a
naive replay, and those docs were reported as unrestored breaks in every run
forever. The fix is **not** to honour the marker on today's line: one declared
compaction would then excuse every break in that doc's history, before and
after it, and a false negative in the one tool built to find silent losses is
worse than the false positive it tidies. Instead a declaration is bound to the
single commit that **introduced** it — the commit that wrote the marker, or,
for a retroactive declaration, the commit that compacted the chain down to the
declaring issue's entry alone. Every other break in the same doc is still
reported. "Introduced" is doing the work: a marker persists on the line for
good, so a drop made a week later still carries it on both sides of its pair.

The retroactive half is deliberately keyed on the compaction *shape* — `#N` as
the line's only reference — and not on "the first commit to cite `#N`", which
was the first attempt and had a hole review found: a note that merely mentions
an issue in prose ("#1500: … plan tracked in #1496") is indistinguishable from
an entry to `issueRefs`, so an unrelated commit that dropped a reference while
name-checking #1496 got excused by #1496's declaration. A prose mention always
sits alongside the entries it did not delete, which is what standing alone
rules out. The rule is narrow on purpose and fails toward reporting: a partial
compaction does not match, and is then listed as unrestored **and** as an
unmatched declaration — a readable "your marker did not bind", never silence.
A declaration matching no break is likewise reported, so an inert escape hatch
cannot pass for a used one.

**The sweep does not use `--follow`**, so a doc renamed inside the `--since`
window hides the breaks it took under its old path — the same blind spot as the
diff-scoped check above and as `chain-integrity-backtest.mjs`. Adding `--follow`
alone would make it worse rather than better: the extra revisions predate the
rename, the per-revision `git show <rev>:<path>` lookups use today's path, and
every one of them would resolve to nothing — cost and a false air of
completeness, no findings. A real fix has to carry the old path per commit.
Currently the gap is empty rather than tolerated: `git log --diff-filter=R -M
--since=2026-08-15 origin/dev -- docs/` reports zero renames.

### Phase 2 — coupling gate + drift tests ([#644](https://github.com/d-hinders/Haven-AI/issues/644))

**Coupling gate** (`.github/workflows/docs-coupling.yml` →
`scripts/docs/coupling-gate.mjs`): on every PR, finds docs whose `covers` globs
match a changed file the PR did **not** also touch, and posts a single advisory
sticky comment naming each doc and its `last-verified` age.

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
**required** check. `chain-integrity.mjs` is deliberately **not** listed — the
gate does not import it, and it guards `last-verified` history rather than the
shard requirement.

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
`.agents/skills/haven-agent-workflow/references/` is read-only. Given a diff, it finds the docs whose `covers:` globs match
the changed code and reports any **specific** claim the diff made stale,
missing, or broken — with the smallest correct update. It's wired into the
agentic workflow (`ai-agent-workflow.md`) and the autonomous loop
(`autonomous-pr-loop.md`): when the coupling gate flags implicated docs, run the
doc reviewer and update them before opening the PR. Advisory in this phase — it
never blocks auto-merge.

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
  covered, non-archived doc by commits touching its `covers:` paths since its
  `last-verified` date. `docs-audit.yml` runs it Mondays 06:00 UTC and upserts
  the report into one tracking issue ("Docs staleness audit (weekly)") — a
  standing queue of which doc is most likely lying, never a spam of new
  issues. Run it locally anytime: `node scripts/docs/audit-staleness.mjs`.
