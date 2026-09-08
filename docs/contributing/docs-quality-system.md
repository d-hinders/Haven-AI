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
last-verified: "2026-09-08"
verified:
  - "#2637: § *`last-verified` chain integrity* rewritten for the list shape — the chain is a `verified:` block list, one entry per line, newest first, and the validator rejects the retired inline `#` form by name. The RETENTION subsection and the check-inventory band row are DELETED with the 64 KiB ceiling and the 40 KiB band they described. States the measured correction to this issue's own premise: git does NOT merge concurrent entries as ordinary line insertions — two entries inserted at the same anchor conflict in both orderings — so what the reshape buys is a two-line conflict with every other entry as untouched context, instead of hand-merging one 37,561-byte line, which is how #1843 dropped entries and #2504 rewrote them. Scope: that section, its retention subsection and one inventory row. NOT re-verified: the front-matter schema, the coupling-gate subsections, the `packages/**` boundary, or Phases 3-4."
  - "#2679 (review follow-up 2): a SECOND review pass on the ratchet semantics, and two of its four findings were claims I introduced while correcting others. (a) The comment and a test asserted the baseline keeps DUPLICATE gap files because \"each mention is its own claim\" — `namedFiles()` reports each file once at its first mention, so that state is unreachable; measured directly. The prose now says identity is a SET today and `surplus()` is multiset-safe only as defence against a future extractor. (b) The \"the archived bypass is not silent\" disclosure read the BASELINE alone, and 33 of the 73 governed docs have no baseline entry — for those the flip printed nothing at all, so the disclosure was false for most of the corpus. `departed()` now takes the docs `governedDocs()` dropped, narrowed to those OUTSIDE docs/archive/ and docs/research/ so the line names the anomaly (1 today) rather than all 24 permanently-archived docs on every clean run. (c) The `--update` rise refusal and the legacy-format error lived only in `main()` and BOTH survived mutation to `if (false)` with the suite green — the exact \"mutate before you trust a guard\" failure, on guards added by a review that raised it. `BASELINE_PATH` is now overridable via HAVEN_COVERS_GAPS_BASELINE and four CLI tests drive the real binary against a throwaway file; both mutations now redden, as do the two halves of `departed()`. (d) A SECOND bypass, undisclosed and strictly worse: an over-broad `covers:` glob (`packages/**` + `scripts/**` + `.github/**`) closes every gap a doc has or will ever have, and the run reported \"residue shrank\" and invited an `--update` locking it in — reproduced with two new false claims admitted and announced as a win. REFUSED rather than disclosed (`tooBroadCovers()`), which was free: 0 of 73 governed docs declare one, against 33 using some `**` glob (positive control). `packages/backend/**` stays legal. The three scan prefixes became ONE definition (`SCAN_PREFIXES`, used by the path regex and the new guard) because a prefix added to one and not the other is a bypass arriving silently — the #2625 shape from the same day. 27/27 unit tests, docs:check green, baseline still 129/40/73. Scope: that ONE subsection and this note."
  - "#2679 (review follow-up): the § *`covers:` gap check* subsection REWRITTEN on three findings from the independent review of PR #2690, all reproduced by execution. (1) The baseline was doc -> COUNT, so a doc could close one gap and open a different one in the same edit and stay green — totals unchanged, no shrink hint, a new false claim accepted silently. Reproduced on docs/architecture/03-payment-sequence.md; the baseline now stores the gap FILES and the swap fails with a NEW marker naming the added path. (2) `--update` wrote a RISE while printing \"ratcheted\"; it now refuses one (exit 1, baseline byte-unchanged) unless `--accept-new` is passed. (3) The sentence attributing the governed set to \"validate-frontmatter.mjs's own definition\" was FALSE — that validator governs 97 docs and applies no status filter, and the archived/research carve-out giving 73 is covers-gaps.mjs's own; corrected, and the `status: archived` bypass it implies is now stated with its live precedent (docs/operations/session-rail-vendor-ops.md) and no longer misreported as a shrink — a departed doc is named instead. Also records the one false POSITIVE class the old list lacked: a path inside an illustrative fenced `covers:` example is counted as a claim, and this document is its own example. Re-derived at this commit: 129 pairs across 40 of 73 governed docs, unchanged by the format migration; `validate-frontmatter.mjs` prints 97. Scope: that ONE subsection and this note. NOT re-verified: Phases 2-4, the front-matter schema, the chain-integrity mechanics, the check-inventory table, or any other `covers:` target."
  - "#2679: EDITED, scope = Phase 1 ONLY. The check-inventory table gains a sixth Blocking row (`covers-gaps.mjs`), the two counts that name that set are re-derived (\"fourth of five\" -> \"fourth of six\", \"All five blocking scripts\" -> \"All six\"), and two new subsections document the check and `npm run docs:measure`. The counts were not incremented by hand: `docs-check-count.test.mjs` derives them from the `docs:check` chain in `package.json` and reddened on the stale values before they were fixed, which is what #2666 built it for. Three figures in epic #2678 did NOT reproduce and were corrected in the epic body rather than fitted to: its \"63 declared `covers:` entries\" is a count of governed docs declaring at least one entry (73 - 10 with `covers: []`), not of entries, of which there are 807; its 227 (doc, uncovered file) pairs are 129 under glob-expanded subtraction (285 with no subtraction, 178 comparing `covers:` entries as plain strings - 227 matches none); and three of its seven derivable-claim classes have no reproducible definition. Baseline seeded at 129 pairs across 40 of 73 governed docs and re-derived at the shipped commit. NOT re-verified: Phase 2's coupling-gate and `satisfied-by` subsections, Phase 3, Phase 4, the front-matter schema, the chain-integrity mechanics, the served-docs section, or any other `covers:` target."
  - "#2657 (amended on re-review): the check-inventory table gains its fifth Blocking row. The pass before this one corrected the sentence under the table from \"four\" to \"five\" and left the table at four — so a count sat one paragraph below a table that visibly did not support it, and my own chain note disclosed the table as \"NOT re-verified\" rather than closing it. Disclosing a gap is not the same as leaving it open on purpose, and this one was cheap to close. Scope: that ONE table row and this note."
  - "#2657: EDITED, scope = three hand-maintained COUNTS of the same set, now that `docs:check` gained a fifth validator (`ui-gate-wording.mjs`). § *Validate locally*'s comment listed four things and lists five; `chain-integrity.mjs` was \"the fourth step\" and is the fourth of five; \"All four blocking scripts\" is five. Folded into the PR that adds the validator rather than left as the follow-up #2666 it was first filed as — the counts would otherwise be wrong on `dev` between the two merges, and this document's own chain shows it corrected the same three numbers for the same reason at #1843 and #2533. That is three times for one defect, which is the argument in #2666 for DERIVING the count from the script definition instead of writing it; that half stays open. Verified by reading the `docs:check` chain in `package.json`: five `&&`-joined validators. Scope: those three sentences and this note. NOT re-verified: the check-inventory table's other rows, the coupling-gate sections, the chain-integrity mechanics, or any other `covers:` target."
  - "#2638: EDITED, scope = TWO additions. (a) § *Phase 2* gains *Only `current` docs are governed* — `archived` and `research` docs now leave the coupling gate in both directions and the staleness audit, via `isGoverned(status)` in `coupling-gate.mjs` with the rule inlined in `audit-staleness.mjs`. States two things measured rather than assumed: the halves are NOT symmetric (no archived doc declares `covers:` at all, so that half is defensive; the work is the nine research docs declaring 30 globs), and a doc with NO status is governed, because the validator requires the field so a missing one is a broken doc, not an exemption. (b) § *Phase 4* records that the weekly audit is now READ at promotion, with the contract-vs-non-contract division of labour that makes it the only sweep for non-contract drift. Scope: those two additions. NOT re-verified: the front-matter schema, Phase 1's deterministic checks, the `last-verified` chain-integrity section, or the agent-served-docs section."
  - "#2533: EDITED — three claims this diff made false, plus one new table row. `docs:check` gained a fourth validator (`scripts/docs/validate-readme-agent-section.mjs`), so: the § *Validate locally* comment listed three things and now lists four; `chain-integrity.mjs` was described as \"the third `docs:check` step\" and is now the fourth; the check-inventory sentence said \"All three blocking checks\" and there are four blocking scripts. The new step is documented where the other three are, including WHY it is duplicated from the SDK suite rather than replacing it: `scripts/ci/change-classifier.mjs` routes a README-only change to NO surface, measured with `classifyChangedFiles(['packages/cli/README.md'])` returning every flag false, so the surface-gated SDK job would not run for the exact edit the guard catches — while this job carries no `paths:` filter, which the paragraph directly under the table already gives as the reason a required check lives here. Found by the coupling gate's advisory list on PR #2577, not by the author. Scope: § *Validate locally*, the ordinal in the paragraph below it, one row and one word in the check-inventory table. NOT re-verified: the front-matter schema, the coupling-gate subsections, `satisfied-by`, the chain-integrity rules, the `packages/**` boundary, or the staleness audit."
  - "#2532: new § *Docs served to agents* — the four served paths and their sources, the generate-not-duplicate rule (gitignored output, generated from `next.config.ts`), the allowlist as the control with `docs/contributing/` and `docs/operations/` deliberately absent and a non-`current` status failing the build, and the link-rewriting deviation: the served copy is NOT byte-identical because every source links to siblings by relative path and most of those targets are not served, so a verbatim copy would publish 404s to an agent — the #2520 defect re-introduced through a copy step. Also records why copy-lint does not scan the generated files (its scan targets must exist in a checkout). Two new `covers:` entries for the generator and its guard test. Review rounds: haven-reviewer reproduced a CI failure this change would have shipped — the suite runs BEFORE the build, so the four served paths did not exist when `discovery-surfaces.test.ts` asserted them, and my own green run was a false green off a directory the generator had filled by hand earlier. The generator now runs from `next.config.ts` (documented above, phase-gated so a server does no filesystem work). A third round CORRECTED that gate's stated reason: I had written that it prevented a standalone server crashing on boot, and it does not — the standalone `server.js` inlines the config as JSON at build time and never re-executes it. The real breakage the round found is at BUILD time: `packages/frontend/Dockerfile` never copied `docs/`, so `docker compose build frontend` failed with ENOENT — reproduced, fixed with a `COPY docs ./docs` in the builder stage, and pinned by a test asserting the COPY set covers every allowlisted source) and from a vitest global setup. haven-doc-reviewer found that this same PR falsified the boundary paragraph two sections below — it said every `packages/**/*.md` must be in exactly one of two sets, which the new `GENERATED_MARKDOWN_PREFIXES` carve-out breaks; that clause now states the exception and its condition, and the identical claim in `package-docs.mjs`'s header comment is corrected too. `scripts/frontend-copy-lint.mjs` added to `covers:` on the same finding, since this section makes a checkable claim about its missing-target behaviour. Scope: the new section, the boundary paragraph and the front matter — the check-layer tables, the coupling-gate sections and the staleness audit were not re-read."
  - "#2523: the `EXEMPT_PACKAGE_DOCS` count is corrected six -> seven and the sentence no longer says every entry is a nested directory note — `packages/frontend/public/402.md` never was one, and `packages/frontend/public/for-agents.md` (added by this PR) is the second served artifact in the set. Re-derived rather than incremented: `node scripts/docs/validate-frontmatter.mjs` prints \"8 governed, 7 exempt (#2088)\" at this commit. Scope: that one bullet and this note ONLY — nothing else in the document was re-verified."
  - "#2562: § `last-verified` chain integrity gains the RETENTION rule, and the check-inventory table gains the advisory band row. Written against `scripts/docs/chain-integrity.mjs` as changed in the same PR: the band is `WARN_CHAIN_BYTES` (40 KiB), reported by `chainSizeWarnings`/`reportChainSizeWarnings` over every governed doc on every run and ahead of the three early returns, blocking nothing; the ceiling is unchanged at 64 KiB and stays diff-scoped. The byte-measure correction is stated with its measured figures (65,448 code units vs 65,719 bytes on `mcp-runtime-compatibility.md`, 2026-09-03) because two earlier write-ups quoted the reported number and were wrong. Scope: that ONE section's new retention subsection and that ONE table row. Post-review addendum (haven-reviewer at 8363d18e): the retention subsection gains the narrow exception for a change that LOWERS the threshold and so trips its own rule on docs already past the new line — separate commits, one per doc, front matter only — because without it this very section read as a rule its own pull request violated. NOT re-verified in this pass: Phases 1-4 otherwise, the front-matter schema, the coupling-gate subsections, the `packages/**` boundary, or the replay account above the new text (read only far enough to place it)."
  - "#2504 (follow-up 3): the entry below called the `scan-ledger.md` and `branch-and-release-flow.md` hits \"pre-`Prior:`-convention notes … from before #1496\". Wrong on both, found by haven-doc-reviewer from the git timestamps: #1496 landed 2026-08-16 08:49 UTC, PR #1502 merged seven hours later and PR #1603 three days after, so both are POST-convention lapses. And `scan-ledger.md` did chain behind `Prior:` — it compressed the entry's text while chaining, a non-verbatim chain, not a replace; I had that fact in my own measurement and mischaracterised it anyway. What survives is the narrower mechanism claim: the check is not retroactive because it compares a PR's edit against that PR's own merge base. Net effect on the record: three hits, three real, rather than one real and two excused. Scope: that one list and the paragraph under it."
  - "#2504 (follow-up 2): the entry below said the replay \"now reports ONE hit\". It reports one only at `--merges=400`, a window that draft never stated: `--merges` is a walk DEPTH, not a date filter, so at the script default of 250 the same replay sees 0 and at saturation (600+) it sees 3 — 221 pull requests, 308 changed chain lines at `f9d920fa`. Found by haven-doc-reviewer, which re-ran the command and got a different number, exactly the check step 4 of its role exists for. The subsection now quotes the command with its `--merges`, gives the saturated figures, and accounts for all three hits: one real truncation, and two pre-`Prior:`-convention notes with no `#ref` head (#1496) — the same class this script's own header already records for `checkChain`. The figures also stopped being restated in `chain-integrity.test.mjs`, which had gone stale against the corrected account within one commit; that comment now points here. Scope: that subsection and that comment."
  - "#2504 (follow-up): the replay account in the subsection below CORRECTED after review. It had called the `00-overview.md` hit a deleted entry whose ref survived as a citation; the actual commit lost the structural `# ` that opens the comment, and the parser then read the first entry's own `#` as the marker — a defect in the check, not in that doc. Fixed in `chainNoteBody`, pinned by a regression test, and the replay now reports ONE hit (the real truncation in `agent-key-rotation.md`). The figures are anchored to `f9d920fa`, matching this file's own convention. Scope: that subsection's replay account only."
  - "#2504: § `last-verified` chain integrity gains the base-refresh rule — interleave rather than take a side, stated as three checked properties, and the new `checkEntriesVerbatim` half of `chain-integrity.mjs` that catches an entry surviving by ref while its text changed. The tolerance (whitespace and one terminal period ignored, any word change a finding) is quoted with the replay that set it: 169 PRs, 256 changed chain lines, 3 hits of which 2 were real defects. The check-inventory row for this script now names #2477 and #2504 alongside #1843. Scope: that ONE subsection and that ONE table row; nothing else in Phases 1-4 was re-verified in this pass."
  - "#2499 (follow-up 2): one clause in the entry below, which called this file a `contract: true` doc. It is not: its front matter carries `owner`, `status`, `covers` and `last-verified` and no `contract` key, so `coupling-gate.mjs` treats it as ADVISORY — which is why it only ever appears in the `[doc-to-code]` bucket and never in the blocking list. Verified by reading the front matter at `a770ac26` with a positive control (the same grep finds `contract: true` in `docs/operations/package-dev-channel.md`). The claim entered the chain from a captain instruction, was carried by the builder, and was caught by haven-doc-reviewer at `b5464e10`. Scope: that ONE clause; nothing else re-verified, and the entry below stands as written otherwise."
  - "#2499 (follow-up): two things the entry below did not reach, both found by haven-doc-reviewer at `181f7c1e`. (1) The Phase 3 paragraph's TRAILING sentence still restated the retired trigger (\"when the coupling gate flags implicated docs, run the doc reviewer\") while the rewritten body above it said the flagged docs are the floor — the same self-contradiction, in an advisory doc governed by this same system. (2) That rewrite added a claim about `scripts/ci/review-isolation.mjs`, which was NOT in this doc's `covers:`; added, so a change to the guard re-implicates this doc. That is the #2425 pattern the role's own §3 exists to catch, caught here on the role's own PR. Scope: that ONE sentence and the `covers:` line; nothing else re-verified."
  - "#2499: the Phase 3 paragraph re-read against `.agents/skills/haven-agent-workflow/references/doc-reviewer.md` as rewritten in the same PR and EDITED: the role now derives its scope from the diff's claims (the `covers:`-implicated list is the floor), re-runs every re-runnable figure, derives `covers:` from a contract doc's body, and binds its verdict to a head SHA via `scripts/ci/review-isolation.mjs`. Scope: that ONE paragraph; nothing else in this doc was re-verified in this pass — in particular Phases 1, 2 and 4, the schema, and the `covers:` targets other than the role file."
  - "#2457: Phase 2 coupling-gate behavior was re-read against scripts/docs/coupling-gate.mjs. The gate now reports the reverse advisory edge: a changed governed doc names its declared covers entries so reviewers can re-check the covered code claims; this does not alter strict contract blocking. Scope: the Phase 2 coupling-gate subsection only; nothing else re-verified in this pass."
  - "#2300: the pin-scope sentence in the `covers:` front-matter bullet updated from \"30 of the 46 globs\" to \"31 of the 47\" (33 runtime globs after `packages/mcp-server/src/**` joined the money-path list; the two EXEMPT entries and the 14 controlGlobs are unchanged). Scope: that sentence only; nothing else re-verified in this pass."
  - "#2375: the one sentence in § *`last-verified` chain integrity* that named `product/design-system.md` oldest-first is corrected — it reads newest-first, exactly like `mcp-runtime-compatibility.md` (proven from git history on this branch: each of the last six commits touching `design-system.md` put its own entry FIRST on the line, `#2241` over `#2318` over `#2251` …), and the sentence now tells the reader to take the direction off the `Prior:` markers rather than off this doc, since a hard-coded example is a second copy that drifts. Scope: that sentence only; nothing else in Phases 1-4 re-verified in this pass."
  - "#2323: Phase 2's `satisfied-by` documentation re-read against `scripts/docs/coupling-gate.mjs` on this branch and extended for the shard-clears-the-BLOCKING-half-not-the-doc change: the measured pre-#2323 behaviour as a three-row table (an ADDED shard suppressed the parent in BOTH postures, so the doc was never named, not merely un-blocked), the #2274 reconstruction that reproduces it (15 advisory docs listed and neither shard-cleared contract doc among them), the four things #2323 changed or deliberately did not, and an explicit statement of what an advisory section is worth — the doc-reviewer ROUTING is the mechanical half, naming the doc is the ceiling. Adds the self-satisfying-shape survey (covers:, chain-integrity's containment + chain-reset hatch, EXEMPT_PACKAGE_DOCS, the advisory job) so it is not re-derived. Scope: Phase 2's `satisfied-by` subsection, PLUS one corrected count in Phase 1 — its `EXEMPT_PACKAGE_DOCS` bullet said \"the five nested directory notes\" and the map holds six (counted via `Object.keys`, and `docs:check` prints \"6 exempt\" itself); found by haven-doc-reviewer on this PR, pre-existing and untouched by this diff, fixed here rather than left sitting in a file this pass bumps. Nothing ELSE in Phases 1, 3 or 4 was re-verified, and the Coupling-gate and same-day-suppression subsections above the new text were read only far enough to place it."
  - "#2088: Phase 1 gains the `packages/**` Markdown boundary — the population census (322 Markdown files, 89 enumerated), why the fix is a declared boundary rather than a bigger scan, the two sets in `scripts/docs/package-docs.mjs` and the line between them, the two design choices (manifest instead of front-matter, because five of these files are published npm landing pages; advisory rather than `contract: true`), why `last-verified` is seeded from each file's last commit rather than stamped today, and what the boundary deliberately does not reach. That section written against the new module on this branch; Phase 1's existing subsections re-read only far enough to place it. Nothing in Phases 2-4 re-verified in this pass."
  - "#2200: Phase 2's \"Coupling gate\" subsection gains the fact that the gate, its front-matter parser and the workflow that runs it are now money-path `controlGlobs` — editing either draws the label and the money.md playbook, and this doc describes that code, so a contributor reading it here should not first learn it from a surprise label. States why `chain-integrity.mjs` is excluded, so the omission reads as decided rather than forgotten. Scope: that subsection only; nothing else in Phases 1-4 re-verified in this pass."
  - "#2192: Phase 2's `satisfied-by` documentation re-read against `scripts/docs/coupling-gate.mjs` and updated for the added-file rule — a satisfying file must now be ADDED, not merely changed, because the old any-match test let an edit to an already-merged shard clear the blocking gate for an unrelated money-path PR (measured: exit 1 -> exit 0 on a one-character append). Records the two consequences a reader needs: the parent-doc edit remains the escape hatch, and a bare `--changed=` list keeps the pre-#2192 behaviour because it carries no add/modify status. The front-matter schema example's `satisfied-by` comment corrected in the same pass. Nothing else in Phases 1-4 re-verified."
  - "#2124: Phase 2's queue-framing-census subsection re-read against `scripts/ci/queue-framing-census.test.mjs` and `.github/workflows/ci.yml`; records the census's guarded-files boundary, its every-PR CI home, and why it is neither the coupling gate nor claim-truth verification."
  - "#1993: added the empty-`covers` reason rule to the front-matter schema section, describing the new BLOCKING check in `scripts/docs/validate-frontmatter.mjs` (a `covers: []` must carry an inline `# reason`), why it is enforced rather than encouraged (a doc with `covers: []` looks governed while no coupling gate can implicate it — strictly worse than no front-matter, which is at least visibly outside the system), and its SCOPE (`docs/**` plus the four root gravity files; Markdown under `packages/**` has no front-matter and is outside the system entirely). That section re-read against the validator on this branch. Nothing else in Phases 1-4 re-verified in this pass."
  - "#1885: Phase 1 §\"Finding a break that is already on `dev`\" re-read against `scripts/docs/chain-sweep.mjs` and `chain-integrity.mjs` on `origin/dev` — records that the sweep now classifies a DECLARED RESET separately from an unrestored break (`N unrestored, M declared reset`), why the blanket `nowLine` check was rejected (one declared compaction would excuse every break in the doc, a false negative in the tool built to find silent losses), and the binding actually used (the commit that INTRODUCED the declaration). Also records `--ref=` and the `--follow` rename residual with the measurement that shows it currently empty. Nothing in Phases 2-4 re-verified in this pass."
  - "#1869: Phase 2 §\"Coupling gate\" re-read against `scripts/docs/coupling-gate.mjs` on `origin/dev` (not against #1824's description of itself) — the same-day-suppression paragraph #1854 flagged and left is REPLACED, because `implicatedDocs` no longer compares `last-verified` to today and the `today` parameter is gone from its signature rather than accepted-and-ignored. The replacement states the behaviour and carries only the reasoning a reader needs (the heuristic's entire live domain was somebody else's stamp, since `changedSet.has(doc)` already covers a doc this change verified), and quotes the 22-advisories/15-of-40-merges/0-blocking measurement WITH its window (`0d299034`) because the docstring records the counts as traffic-dependent. The `--strict` carve-out the old paragraph described is genuinely gone; the one that REMAINS is different and now documented where it lives — a `contract: true` doc under `--strict` skips the incidental-path filter (`filterIncidental = !(strict && contract)`). Phase 1 also gains `scripts/docs/chain-sweep.mjs` (#1876) and the reason it is needed: a chain break already on `dev` is invisible to the diff-scoped check permanently, not merely deferred to the next editor. Nothing else in Phases 2-4 re-verified in this pass."
  - "#1854: Phase 2 §\"Scoping covers\" re-read against `scripts/docs/coupling-gate.mjs` — documents the test-content carve-out (`packages/qa-agent/**`, `packages/frontend/e2e/**`) and the `__screenshots__/` carve-out from it, which is checked first; the same-day-suppression paragraph in this section is STALE since #1824 and is NOT fixed here (#1869) — nothing else re-verified in this pass."
  - "#1843: Phase 1 re-read against `scripts/docs/*` and `docs.yml` — gains the `last-verified` chain-integrity check (third `docs:check` step, inside the existing required job, needs `fetch-depth: 0`), the `chain-reset` escape hatch, and why the rule is containment rather than #1843's proposed subsequence; nothing in Phases 2–4 re-verified in this pass."
  - "#1337: strict-gaten släpper en BEVISAT beräknad tom change-set (ren merge/sync-PR); okänd/trasig diff förblir fail-closed (#1076)"
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
verified:                    # REQUIRED once the doc has been re-verified once:
  - "#2637: what this pass   # the chain, one entry per line, NEWEST FIRST.
     checked, and what it    # Add yours at the top. Double-quoted; write it
     did NOT re-verify."     # through quoteEntry, never by hand (#2637).
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
npm run docs:check   # front-matter + covers globs, agent skills, README agent section, last-verified chains, retired UI merge-gate wording
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

`scripts/docs/validate-readme-agent-section.mjs` is the third step
([#2533](https://github.com/d-hinders/Haven-AI/issues/2533)). It checks that the
agent-facing section every published README carries is byte-identical to
`AGENT_README_SECTION_MD` in `packages/sdk/src/agent-guidance.ts`, reading the
constant out of the TypeScript source as text so it needs no build. It lives
here rather than only in the SDK suite for a reason this document's own closing
paragraph explains: `scripts/ci/change-classifier.mjs` routes a README-only
change to NO surface, so the SDK job would not run for the single edit the
guard exists to catch, while this job has no `paths:` filter and always does.

`scripts/docs/chain-integrity.mjs` is the fourth of six `docs:check` steps and is
described under [`last-verified` chain integrity](#last-verified-chain-integrity-1843)
below. Unlike the other two it reads **git history**, so it needs a base
commit: locally `origin/dev`, in CI `BASE_SHA`/`HEAD_SHA` with
`fetch-depth: 0`. Without one it says NOTHING WAS CHECKED and, in CI, fails —
a gate that cannot see the diff must never report a clean bill of health
(the #1076 lesson).

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

**There is still exactly one editable copy, and it is the source.**
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
front matter, `covers:`, the coupling gate and the `last-verified` chain — which
is the stronger instrument for a document anyway.

## Check layers

### Phase 1 — deterministic checks (this PR)

Run by `.github/workflows/docs.yml` on **every** pull request:

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | **Blocking** |
| `packages/**` Markdown boundary ([#2088](https://github.com/d-hinders/Haven-AI/issues/2088)) | `scripts/docs/package-docs.mjs`, run from `validate-frontmatter.mjs` | **Blocking** |
| Agent-skill structure + adapter alignment | `scripts/docs/validate-agent-skills.mjs` | **Blocking** |
| Agent-facing README section, six copies ([#2533](https://github.com/d-hinders/Haven-AI/issues/2533)) | `scripts/docs/validate-readme-agent-section.mjs` | **Blocking** |
| `last-verified` chain integrity ([#1843](https://github.com/d-hinders/Haven-AI/issues/1843), [#2477](https://github.com/d-hinders/Haven-AI/issues/2477), [#2504](https://github.com/d-hinders/Haven-AI/issues/2504)) | `scripts/docs/chain-integrity.mjs` | **Blocking** |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Retired UI merge-gate wording ([#2657](https://github.com/d-hinders/Haven-AI/issues/2657)) | `scripts/docs/ui-gate-wording.mjs` | **Blocking** |
| `covers:` gaps — a doc naming a file its `covers:` cannot reach ([#2679](https://github.com/d-hinders/Haven-AI/issues/2679)) | `scripts/docs/covers-gaps.mjs` | **Blocking** (shrink-only baseline) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**`) | Advisory |

All six blocking scripts need no npm dependencies and finish in seconds, which is why the
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
every `packages/**/*.md` must be in exactly one — with one narrow exception
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

**The shape ([#2637](https://github.com/d-hinders/Haven-AI/issues/2637)).** The
chain is a `verified:` block list, **one entry per line, newest first**:

```yaml
last-verified: "2026-09-08"
verified:
  - "#2637: reshaped the chain; three checks ported to line sets."
  - "#2533: EDITED — three claims this diff made false. Scope: §3."
```

Add yours at the top. Entries are double-quoted YAML scalars because their text
contains `"`, `#`, `:` and backslashes; `quoteEntry`/`unquoteEntry` in
`validate-frontmatter.mjs` are the only writer and reader, so the two cannot
drift apart. The retired form put the whole chain in a `#` comment on the
`last-verified:` scalar, joined by `Prior:` markers — the validator now rejects
that shape and names the one-shot migration (`scripts/docs/migrate-chain-to-list.mjs`).

**The rule is unchanged:** one entry per issue that re-verified the doc (#1496),
and every entry on the base must still be there, byte-for-byte, on the head.

**What the reshape did and did not buy — measured, because the issue that asked
for it predicted otherwise.** #2637 expected git to merge concurrent entries as
ordinary line insertions. It does **not**: two branches each inserting a
different entry at the same anchor conflict in git's line-based merge, and that
was measured both ways round — newest-first and oldest-last conflict alike. The
conflict did not go away.

What went away is the **damage**. The conflict is now the two inserted lines,
with every other entry outside the hunk as untouched context, so the resolution
is *keep both* and no unrelated entry is in reach. In the old shape the same
conflict arrived as one line — 37,561 bytes on
`delegation-rail-security-model.md` — that both sides had rewritten whole, and
hand-merging that line is exactly how [#1843](https://github.com/d-hinders/Haven-AI/issues/1843)
dropped entries and how [#2504](https://github.com/d-hinders/Haven-AI/issues/2504)
rewrote them in place. Both failures required a human editing a chain they could
not read; neither is reachable from a two-line hunk. `chain-integrity.test.mjs`
proves both halves with a real `git merge` rather than asserting them.

**Compacting a chain on purpose** says so in an entry, which passes the check
and prints what was dropped:

```yaml
verified:
  - "chain-reset(#1843): compacted, history in git log."
```

The marker lives in the file rather than in a PR description so the excuse lands
in the diff of the file it excuses.

**Refreshing a base: interleave, never take a side ([#2504](https://github.com/d-hinders/Haven-AI/issues/2504)).**
When a branch merges `dev` in and both sides added an entry, `git` conflicts —
that did not change in #2637, and the measurement is in the section above. What
changed is the size of the thing you resolve: a two-line hunk with every other
entry outside it as context, rather than one rewritten 37 KB line. Two
properties make the result correct, and each is checked rather than trusted:

1. **Newest first, both sides kept.** Your new entries, then the incoming
   side's, then the shared tail exactly once. Taking one side drops history
   (#1843); concatenating the two doubles it (#2477). In the list shape the
   resolution is usually just *keep both lines*.
2. **Every prior entry byte-verbatim.** Refs gained, none dropped, none
   doubled — and none *edited*. An entry that keeps its ref while its prose
   changes still passed both earlier checks, because one asks about refs and
   the other about duplicates; neither asks whether the surviving entry still
   says what it said.

`node scripts/docs/chain-integrity.mjs --base=<ref>` answers both. The second is
`checkChainEntries`'s `altered` list, and its tolerance was set by replaying it over
merged history rather than by argument. The command, in full, because the window
is not the script's default and the numbers do not hold without it:

```bash
node scripts/docs/chain-integrity-backtest.mjs --merges=1200 --since=2026-08-15
# at origin/dev f9d920fa: 221 pull requests, 308 changed chain lines, 3 ALTERED
```

`--merges` is a walk depth, not a date filter, so it has to be deep enough to
reach the `--since` cutoff: at the script's default of 250 this replay sees 0
hits and at 400 it sees 1, purely because it has not walked far enough back.
It saturates at 600 and above. A figure from this script without its `--merges`
is not re-takeable, and an earlier draft of this section quoted one.

All three hits at saturation are genuine losses of chain text — the check found
two more than an earlier draft of this section credited it with:

- `docs/product/agent-key-rotation.md` (PR #1964): entries `#1849` and `#1702`
  truncated mid-entry during a merge resolution — each cut lands after a
  terminating period, so the loss is a whole sentence, not a broken one.
- `docs/quality/scan-ledger.md` (PR #1603): the prior entry **was** chained
  behind `Prior:`, and compressed while chaining — "the outbound-tx-queue
  finding (epic #1554, approved); both prior findings re-checked and excluded
  per their dispositions" became "(epic #1554)". A non-verbatim chain, which is
  precisely the shape `checkChain` and `chainAnomalies` both call healthy.
- `docs/contributing/branch-and-release-flow.md` (PR #1502): the previous note
  replaced outright, with no `Prior:` clause at all.

Both of the last two are reported as `(entry)` rather than by a `#ref`, because
their entries predate the `#NNNN:` heading style — which is what misled an
earlier draft of this section into calling them pre-convention noise from
before #1496. The git timestamps say otherwise: #1496 landed 2026-08-16 08:49
UTC, PR #1502 merged seven hours later that same day, and PR #1603 three days
after. Both are post-convention lapses, not history. The correction matters
because it is the difference between a check with one confirmed find and a
check with three.

The mechanism claim that survives is narrower: the check is not retroactive. It
only ever compares a pull request's own edit against that pull request's own
merge base (`base = merge-base(p1, p2)` in the replay), so an entry already on
`dev` is never re-examined by a later PR that does not touch it. That is why
these three sit in history rather than failing CI today — a timing fact, not a
blind spot. A new entry without a `#ref`, altered by some future PR, would be
caught: `headOfEntry` returns null for it, so it is judged on its text alone.

Two further hits were removed by fixing the check rather than the docs:

- **A deleted full stop** (`docs/operations/mcp-runtime-compatibility.md`). A
  gate that goes red over punctuation teaches people to route around it, so
  whitespace and a single terminal period are normalised away. Any change to a
  word is still a finding.
- **A defect in the check itself** (`docs/architecture/00-overview.md`), found by
  review rather than by the replay. That commit lost the structural `# ` that
  opens the comment, leaving `"2026-08-25"  #1992: …`; the parser then ate the
  first entry's own `#` as if it were the marker and reported an alteration
  against text that was byte-identical. Fixed in `chainNoteBody` and pinned by a
  regression test — a marker is followed by a space, so a `#` before a digit was
  never one.

A declared `chain-reset(#N)` is exempt, since a compaction rewrites entries on purpose.

**Compacting is now optional, and there is no threshold that demands it
([#2637](https://github.com/d-hinders/Haven-AI/issues/2637)).** The 64 KiB
ceiling and the 40 KiB advisory band are gone with the single-line shape that
made them necessary: an unbounded line was a cost every reader of the file paid,
and a list has no such line. Nothing measures chain size any more.

When you *choose* to compact — a chain long enough to be noise in the file is
still worth trimming — do it in a pull request of its own, front matter only,
the shape [#2563](https://github.com/d-hinders/Haven-AI/pull/2563) used:

> keep the newest **~20 entries verbatim** under a declared
> `chain-reset(#<issue>)` naming what was dropped and why; the older entries
> leave the file and stay recoverable in `git log -p` on it.

Twenty is a floor, not a target — keep more while they fit comfortably. Git
history is what makes truncation defensible at all, so a compaction that does
not say where the dropped entries went is not one. Do it in its own diff for the
same reason #2563 was split out of #2557: losing 35 entries of someone else's
provenance is a decision that deserves its own review, not a passenger in an
unrelated change.

The rule is about **unrelated** changes, and it has one narrow exception, stated
here because the pull request that introduced this section is itself the case: a
change that *lowers the threshold* trips it immediately on every doc already
past the new line, and shipping the mechanism without those compactions leaves a
standing warning nobody owns — which is the failure this whole section exists to
prevent. Such a change may carry them, as **separate commits**, one per doc,
front matter only. That preserves what the own-diff rule is actually protecting
(a lossy edit gets its own reviewable diff) without the window where `dev` warns
about something the same author is already fixing. Anything else — a compaction
riding along with a feature, a fix, or another doc's edit — takes its own pull
request.

Two limits worth stating plainly. `chain-reset(#N)` **does not excuse the
ceiling** — the check says so itself, and a reset does not make a doubled line
smaller. And the measure on both sides is **UTF-8 bytes**: `chainAnomalies`
compared `line.length` (UTF-16 code units) while reporting "N bytes" until
#2562, so on a chain dense with em-dashes and arrows the same line could be
under the enforced limit and over the reported one — 65,448 against 65,719 on
`mcp-runtime-compatibility.md` at `f37184b5c0d6` (2026-09-04). Either measure is
defensible; enforcing one while reporting the other is not, and it put wrong
figures into two separate write-ups before it was fixed.

To correct what an entry claimed, **add a new entry saying how it was wrong**.
Overwriting it destroys the evidence of what was believed and when, which is the
only thing a chain is for.

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
  disposition — fix, file, or accept with a reason in the promotion PR. This is
  the counterpart to contract-doc blocking, and the division of labour is the
  point: a `contract: true` doc is stopped on the PR that made it stale and
  never reaches promotion, while **non-contract** docs are deliberately allowed
  to drift on `dev` between promotions, and this is the one place that drift is
  swept.
