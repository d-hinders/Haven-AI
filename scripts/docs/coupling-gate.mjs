#!/usr/bin/env node
// Doc↔code coupling gate (Phase 2 of the docs-quality system, epic #642).
//
// When a PR changes code that a doc describes (via the doc's `covers:`
// front-matter) WITHOUT touching that doc, this emits an advisory comment
// naming the doc and how stale it is, so the author can confirm-or-update it.
//
// Two postures, one script. Without `--strict` it only informs and always exits
// 0. With `--strict` (Phase 4, #646) a doc marked `contract: true` FAILS the
// build — so a local run without the flag does not tell you what CI will say.
//
// Usage:
//   npm run docs:coupling                               # what CI runs (strict)
//   node scripts/docs/coupling-gate.mjs                 # advisory only
//   node scripts/docs/coupling-gate.mjs --changed a,b   # explicit file list
//   BASE_SHA=… HEAD_SHA=… node scripts/docs/coupling-gate.mjs   # CI
//
// With no `--changed` and no BASE_SHA the candidate set is the working tree:
// committed-vs-origin/dev PLUS staged, unstaged and untracked files. Committed
// changes alone would report a clean bill of health for uncommitted work.
//
// Writes the comment body to --out (default coupling-comment.md) only when
// there are findings, and appends `has_findings=true|false` to $GITHUB_OUTPUT.

import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  REPO_ROOT,
  ROOT_DOCS,
  walk,
  parseFrontMatter,
  globToRegExp,
} from './validate-frontmatter.mjs'

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function gitLines(args) {
  try {
    const out = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * #1337: distinguish "the diff was COMPUTED and is empty" from "the diff could
 * not be computed". Only the former may pass in strict mode — a pure merge/
 * sync PR (e.g. #1336, zero content delta) has nothing to couple, while a
 * failed computation must stay fail-closed (the #1076 lesson).
 */
/**
 * Parse `git diff --name-status` output into paths plus the set of ADDED ones.
 *
 * The path is the LAST tab-separated field, which keeps renames (`R100\told\tnew`)
 * pointing at the new path exactly as `--name-only` reports them. Only `A`
 * counts as added: a rename is an old record under a new name, not a new one —
 * see `implicatedDocs` for why that distinction is the whole point (#2192).
 *
 * DO NOT "fix" this with `--no-renames`, which review proposed and measurement
 * rejected. The concern is real: git pairs a deleted file with a similar added
 * one, so a PR that deletes an old shard while adding its own could see its new
 * shard reported `R` and be wrongly blocked. But `--no-renames` reports every
 * rename as `D` + `A`, which makes RENAMING a merged shard satisfy the gate —
 * trading a loud false block for exactly the silent bypass this change exists
 * to close, and the silent direction is the one that ships.
 *
 * Measured 2026-08-29 on git 2.43, both shapes:
 *   - delete a byte-identical duplicate + add an UNRELATED new shard (the case-3
 *     fold-in this repo endorses) -> `D` + `A`. Counted. No false block.
 *   - delete a shard + add one ~97% identical to it -> `R097`. Blocked.
 * The second is the only case that fires, and blocking it is right: a shard 97%
 * identical to another shard is a copy-paste, not a verification record for a
 * different change. `C` (copy) cannot occur — git emits it only under an
 * explicit `-C`/`--find-copies`, which this file never passes.
 *
 * The worry this leaves is a MIDDLE band — two genuinely distinct shards paired
 * on shared boilerplate. Review measured the real corpus for it and found none:
 *   - 6 pairs of same-day, same-domain shards (the erc7710/x402 cluster, chosen
 *     to maximise shared vocabulary): 0% similarity, even at `-M1%`.
 *   - the two most boilerplate-heavy files in the directory — consecutive
 *     RELEASE shards sharing a verbatim ~100-word opening: `R003`, 3%.
 *   - an old shard copied and edited only in its issue number: `R095`.
 * So the gap is 3% against a 50% default threshold, with copy-paste at 95%+.
 * There is no band in between, because shards are issue-specific narrative
 * prose rather than a filled-in template. That is a property of how shards are
 * WRITTEN, not a proof — if the convention ever becomes templated, re-measure
 * this rather than reaching for `--no-renames`.
 */
export function parseNameStatus(out) {
  const files = []
  const added = new Set()
  for (const line of out.split('\n')) {
    const parts = line.split('\t').map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const path = parts[parts.length - 1]
    files.push(path)
    if (parts[0][0] === 'A') added.add(path)
  }
  return { files, added }
}

function gitNameStatus(args) {
  try {
    return parseNameStatus(execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }))
  } catch {
    return null
  }
}

export function changedFilesWithProvenance() {
  const explicit = arg('changed')
  if (explicit !== undefined) {
    const explicitAdded = arg('added')
    return {
      files: explicit.split(',').map((s) => s.trim()).filter(Boolean),
      computed: true,
      // #2192: a bare `--changed=` list carries no add/modify status, so the
      // added-shard rule cannot be applied to it. `added: null` means "status
      // unknown" and restores the pre-#2192 behaviour for this path ONLY.
      // Deliberately permissive rather than fail-closed: `--changed` is a
      // local/debugging affordance, while the job that actually gates a PR
      // (docs-coupling.yml `contract`) sets BASE_SHA and gets real status.
      // Pass `--added=` alongside `--changed=` to exercise the rule by hand.
      added: explicitAdded === undefined
        ? null
        : new Set(explicitAdded.split(',').map((s) => s.trim()).filter(Boolean)),
    }
  }
  const base = process.env.BASE_SHA
  if (base) {
    const head = process.env.HEAD_SHA || 'HEAD'
    // THREE-DOT (merge-base): a two-dot diff against a moving base branch lists
    // files the PR never touched as "changed" (same flaw fixed in the
    // design-system coupling gate, code review 2026-07-13).
    const range = gitNameStatus(['diff', '--name-status', `${base}...${head}`])
    if (range) return { files: range.files, computed: true, added: range.added }
    // The range itself failed (missing SHA, shallow clone) — NOT a clean bill.
    return { files: [], computed: false, added: null }
  }
  // Local run (no BASE_SHA): the candidate change is whatever a reviewer would
  // look at, which includes work not committed yet. A committed-only range
  // reports a clean bill of health for an uncommitted diff — the false green
  // that let #1076's contract-doc failure reach CI, because the skill runs this
  // during review, before the commit. CI is unaffected: it always sets BASE_SHA.
  // Local: an empty union here is ambiguous (pre-commit run, #1076) — never
  // provably computed-and-empty.
  const branch = gitNameStatus(['diff', '--name-status', 'origin/dev...HEAD'])
  const worktree = gitNameStatus(['diff', '--name-status', 'HEAD']) // staged + unstaged tracked
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'])
  const added = new Set([
    ...(branch?.added ?? []),
    ...(worktree?.added ?? []),
    ...untracked, // an untracked file is added by definition
  ])
  return {
    files: [...new Set([
      ...(branch?.files ?? []),
      ...(worktree?.files ?? []),
      ...untracked,
    ])].sort(),
    computed: false,
    added,
  }
}

export function ageDays(lastVerified, now = Date.now()) {
  const then = Date.parse(lastVerified)
  if (Number.isNaN(then)) return null
  return Math.floor((now - then) / 86_400_000)
}

/**
 * A changed file that cannot, on its own, make prose stale: a test describes
 * behaviour rather than defining it, and a generated file mirrors a source the
 * doc already covers. These implicate a doc only when its `covers` names the
 * path EXACTLY — `07-edge-signer.md` deliberately pins
 * `hosted-signer-integration.test.ts`, and that intent must survive. Swept up by
 * a wildcard (`packages/frontend/src/components/**` matching a `__tests__` file)
 * they are pure noise, and noise is why the one ⚠️ finding that mattered on
 * #1076 was skimmed past in a list of eleven.
 */
export function isIncidentalPath(file) {
  // Playwright's snapshot directory — the committed visual-regression
  // baselines. The name is not a convention someone might rename: it is
  // `snapshotPathTemplate` in `packages/frontend/playwright.config.ts`, and the
  // *Update visual baselines* workflow commits exactly this directory. The PNGs
  // are generated, never hand-edited, and described by no runbook — the
  // docstring's "generated file mirrors a source the doc already covers" case.
  //
  // This is checked BEFORE the test-package carve-out below, and that ordering
  // is the whole fix (#1854): the baselines live INSIDE
  // `packages/frontend/e2e/`, so the carve-out was protecting them too, and
  // `docs/bug-reports/_run-report-template.md` (`covers: packages/frontend/e2e/**`)
  // was implicated by every baseline regeneration. Nothing about a run-report
  // template goes stale because a PNG's bytes changed.
  //
  // Falling through to the checks below would NOT have been enough: a path like
  // `…/__screenshots__/design-system.visual.spec.ts/design-system-desktop.png`
  // matches neither `__tests__/` nor the `$`-anchored `.spec.ts` extension test.
  // The rule has to say `true` itself.
  //
  // Scope, stated mechanically rather than asserted (the #1824 style): this line
  // can only change an outcome for a changed file under a `__screenshots__/`
  // directory that is matched by a NON-EXACT `covers` glob. Enumerated across
  // all docs with the front-matter parser and glob engine above, exactly one
  // such glob exists — the run-report template's. The two docs that genuinely
  // describe e2e specs reach only `live/**`, `fixtures/live-session.ts` and
  // three exact spec paths, so neither can be un-covered by this. Backtested
  // over 126 first-parent merges into `dev`: 4 advisories stop firing, all four
  // the run-report template on a baseline regeneration, and 0 change to
  // blocking findings.
  //
  // Be precise about what that backtest proves. "No doc is NEWLY implicated" is
  // not a measurement — it is true by construction, because this rule only ever
  // moves a path from not-incidental to incidental, and a narrower "is
  // incidental" predicate can only remove findings. The informative half is the
  // other direction: WHICH advisories stopped, and whether any of them was
  // asked for a good reason. All four were the same doc, via the same glob,
  // matched only by PNGs.
  //
  // That enumeration is a snapshot, NOT a standing invariant, and the rule below
  // is repo-wide rather than scoped to `packages/frontend/e2e/` (matching the
  // unscoped style of the `__tests__/` and `.spec.` rules). So if a second
  // package ever grows its own `__screenshots__/` — a Storybook/Chromatic
  // snapshot dir, a second Playwright project — it becomes incidental here too,
  // silently, for any doc covering it by wildcard. That is the intended
  // reading (generated snapshots are generated snapshots wherever they live),
  // but it is a decision, not an accident: re-run the enumeration before
  // assuming the blast radius is still one glob.
  //
  // The exact-name escape still works and is the intended way to opt back in: a
  // doc whose `covers` names a baseline PNG by its full path is implicated by a
  // change to it, because `implicatedDocs` skips this filter for exact globs.
  if (/(^|\/)__screenshots__\//.test(file)) {
    return true
  }
  // Packages whose CONTENT is tests: the QA scenarios and live e2e specs are
  // what their runbooks document, not a test of some other source. Calling them
  // incidental would silently un-cover the docs that describe them.
  if (file.startsWith('packages/qa-agent/') || file.startsWith('packages/frontend/e2e/')) {
    return false
  }
  return (
    /(^|\/)__tests__\//.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    file === 'packages/core/src/api-types.ts' // generated by scripts/generate-api-types.mjs
  )
}

/**
 * Pure core: given changed files and the docs (each with its `covers` globs),
 * return the docs implicated by the change. A doc is implicated when a changed
 * file matches one of its globs AND the doc itself was not changed.
 *
 * SAME-DAY SUPPRESSION IS GONE (#1824). It used to skip any doc whose
 * `last-verified` was today. #1077 had already ruled that reasoning out for the
 * blocking half — "a doc that some OTHER PR verified today says nothing about
 * whether THIS PR made it stale" — and carved contract docs out of it under
 * `strict`. #1824 is that same argument finished: it applies just as well to
 * the advisory half, and the carve-out was the wrong shape.
 *
 * The mechanical reason it could never be right: a doc THIS change verified is
 * a doc THIS change edited, and `changedSet.has(doc)` skips it four lines down.
 * So the only situation in which same-day suppression could ever fire was a
 * stamp written by somebody else's work — precisely the situation #1077 named
 * as unacceptable. The heuristic was not mostly-right with an edge case; its
 * entire domain was the edge case.
 *
 * `last-verified` notes say so themselves. `docs/product/design-system.md`
 * carried EIGHT chained notes stamped 2026-08-22, each ending "nothing else
 * re-verified in this pass" — the document stating, in prose, that one section
 * was re-read — while the gate read the date and concluded the whole file was
 * current against every diff that day.
 *
 * Measured before removing rather than argued: over 40 merges into `dev`
 * (window ending 0d299034), the heuristic hid 22 advisories across 15 merges —
 * about 0.55 per merge — including `design-system.md` on a change to
 * `TransactionMovement.tsx`, a file it `covers:` by exact path. So removal buys
 * back 22 real coupling checks for roughly one extra advisory line every other
 * PR. That is not a noise problem.
 *
 * It hid ZERO blocking findings, which is the same claim the code makes
 * structurally (contract docs already bypassed the suppression under `strict`)
 * arrived at by measurement instead. Both should agree; that they do is the
 * point of checking.
 *
 * The exact counts move as `dev` moves — they are a description of this
 * repository's traffic, not a constant. Re-derive rather than cite if the
 * number ever has to carry an argument again; an earlier run of a buggier
 * script reported 13/8, low because it skipped ROOT_DOCS entirely and merged
 * `satisfied-by:` globs into `covers:`.
 *
 * The `today` parameter is REMOVED rather than left accepted-and-ignored. It
 * had no other reader in this function, and an unused knob that used to change
 * behaviour is how a future caller reintroduces the bug believing it still
 * works. Staleness AGE reporting is `ageDays`, which owns its own `now`.
 *
 * Historical note on the carve-out this replaces: a blocking gate could not
 * afford a wall-clock heuristic — it would be green at 23:59 and red at 00:01
 * with no code change, and a doc that some *other* PR
 * verified today says nothing about whether this PR made it stale.
 *
 * The UTC-vs-local ±1-day skew that note used to carry no longer affects any
 * suppression decision, because there is none. It still applies to `ageDays`
 * staleness reporting, where being a day out never changes an outcome.
 */
export function implicatedDocs(changed, docs, { strict = false, added = null } = {}) {
  const changedSet = new Set(changed)
  const findings = []
  for (const { doc, covers, lastVerified, contract, satisfiedBy } of docs) {
    if (changedSet.has(doc)) continue
    // Per-iteration: a `var` here would leak the previous doc's near-miss into
    // this one's finding.
    let editedOnlySatisfyMatches = []
    // #1366: a doc may declare `satisfied-by:` globs — touching a matching
    // file counts as touching the doc itself. Built for the CASP changelog
    // shards: every money-path PR must still write its verification entry,
    // but as `docs/regulatory/casp-changelog/<date>-<issue>.md` (a file no
    // parallel PR also edits) instead of appending to one monolithic EOF —
    // the line-collision class that made four PRs conflict in one day.
    //
    // #2192: the match must be an ADDED file. This asked only whether SOME
    // changed file matched the glob, so a one-character edit to a shard that
    // merged months ago cleared the blocking gate for an unrelated money-path
    // PR — silently, on green CI, with the verification record it exists to
    // force never written. Measured: money-path edit alone → exit 1; the same
    // edit plus a one-character append to an already-merged shard → exit 0.
    //
    // The rule is "at least one ADDED match", never "no modified matches": a
    // PR that writes its own shard AND tidies an old one still passes, which
    // is what keeps ordinary release flows and duplicate cleanups working.
    // Renames do not count (see `parseNameStatus`) — an old record under a new
    // name is not a new record.
    //
    // `added === null` means the caller could not determine add/modify status
    // (a bare `--changed=` list), and restores the pre-#2192 behaviour. The
    // gating CI job always supplies it.
    const satisfiedMatches = satisfiedBy
      ? changed.filter((f) => satisfiedBy.some((glob) => globToRegExp(glob).test(f)))
      : []
    if (satisfiedMatches.length > 0) {
      const qualifying = added === null
        ? satisfiedMatches
        : satisfiedMatches.filter((f) => added.has(f))
      if (qualifying.length > 0) continue
      // Matched the glob, but every match was an EDIT to a pre-existing file.
      // Fall through and report the doc, carrying the near-miss so the error
      // message can say WHY an apparently-satisfying edit did not satisfy.
      editedOnlySatisfyMatches = satisfiedMatches
    }
    if (!covers || covers.length === 0) continue
    // (#1824) No same-day suppression. See the header: a doc this change
    // verified is a doc this change edited, and that was already handled by
    // `changedSet.has(doc)` above — so every suppression this line could still
    // perform was on somebody else's stamp.
    // Noise-reduction never weakens the BLOCKING half. Under strict, a contract
    // doc sees every changed file its globs match — the same carve-out the
    // same-day heuristic gets above, for the same reason: a green --strict run
    // that should have been red is the whole defect this gate exists to prevent.
    // Without it, a test-only PR against a wildcard-covered money-path package
    // (`packages/sdk/src/**`, `packages/signer/**`) passes strict silently.
    const filterIncidental = !(strict && contract)
    const matched = new Set()
    for (const glob of covers) {
      const exact = !/[*?]/.test(glob)
      const re = globToRegExp(glob)
      for (const f of changed) {
        if (!re.test(f)) continue
        if (!exact && filterIncidental && isIncidentalPath(f)) continue
        matched.add(f)
      }
    }
    if (matched.size > 0) {
      findings.push({
        doc,
        lastVerified,
        contract: Boolean(contract),
        matched: [...matched].sort(),
        editedOnlySatisfyMatches: [...editedOnlySatisfyMatches].sort(),
      })
    }
  }
  return findings
}

async function main() {
  const outPath = arg('out') || 'coupling-comment.md'
  const strict = process.argv.includes('--strict')
  const { files: changed, computed, added } = changedFilesWithProvenance()

  // An empty candidate set means the diff could not be computed — not that the
  // docs are fine. Reporting it as a pass is indistinguishable from a real
  // clean bill of health, which is precisely how #1076 shipped: run before the
  // commit, the old committed-only range was empty and printed "no covered docs
  // implicated", and that sentence went into the PR body as evidence.
  if (changed.length === 0) {
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, 'has_findings=false\n')
    }
    // #1337: a PROVABLY computed empty diff (CI three-dot range succeeded, or
    // an explicit --changed=) has nothing to couple — a pure merge/sync PR
    // passes. An empty set whose computation is uncertain stays fail-closed
    // in strict mode (#1076: a pre-commit run's empty range once shipped as
    // "no covered docs implicated" in a PR body).
    if (computed) {
      console.log('Coupling gate: change-set computed and empty — nothing to couple (pure merge/sync).')
      return
    }
    console.log('Coupling gate: no changed files detected — nothing was checked.')
    if (strict) {
      console.error(
        '\nBLOCKING: nothing was verified. Commit or stage your work, or pass ' +
        '--changed=<files>, then run again.',
      )
      process.exit(1)
    }
    return
  }

  const docFiles = (await walk(join(REPO_ROOT, 'docs'))).filter((p) => p.endsWith('.md'))
  for (const r of ROOT_DOCS) docFiles.push(r)

  const docs = []
  for (const docRel of docFiles.sort()) {
    const raw = await readFile(join(REPO_ROOT, docRel), 'utf8')
    const parsed = parseFrontMatter(raw)
    if (!parsed.ok) continue
    docs.push({
      doc: docRel,
      covers: parsed.data.covers || [],
      lastVerified: parsed.data['last-verified'],
      // Phase 4 (#646): `contract: true` front-matter promotes a doc from
      // advisory to BLOCKING in --strict mode.
      contract: parsed.data.contract === 'true',
      // #1366: alternative satisfaction paths (changelog shards).
      satisfiedBy: parsed.data['satisfied-by'] || [],
    })
  }

  const docsByPath = new Map(docs.map((d) => [d.doc, d]))
  const findings = implicatedDocs(changed, docs, { strict, added })
  const hasFindings = findings.length > 0
  const contractFindings = findings.filter((f) => f.contract)

  if (hasFindings) {
    let body = '<!-- docs-coupling-gate -->\n'
    body += '### 📝 Docs that may need updating\n\n'
    body +=
      'This PR changes code that the docs below describe (via their `covers:` ' +
      'front-matter), but those docs were not touched. Please confirm each is ' +
      'still accurate — or update it and bump `last-verified`. ' +
      'Docs marked ⚠️ are **contract docs** — the blocking check fails until ' +
      'they are touched in this PR; the rest are advisory.\n\n'
    for (const f of findings) {
      const age = ageDays(f.lastVerified)
      const ageStr = age === null ? 'unknown' : `${age}d ago`
      const mark = f.contract ? '⚠️ ' : ''
      body += `- ${mark}\`${f.doc}\` (last verified ${f.lastVerified}, ${ageStr})\n`
      for (const m of f.matched) body += `  - matched \`${m}\`\n`
    }
    await writeFile(outPath, body, 'utf8')
    console.log(`Coupling gate: ${findings.length} doc(s) may need updating.`)
    for (const f of findings) console.log(`  - ${f.contract ? '[contract] ' : ''}${f.doc}`)
  } else {
    console.log('Coupling gate: no covered docs implicated by the changed files.')
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `has_findings=${hasFindings}\n`)
  }

  // Phase 4 (#646): in --strict mode, a contract doc left untouched FAILS the
  // check. The fix is always the same: update the doc (or genuinely re-verify
  // it and bump `last-verified`) in this PR.
  if (strict && contractFindings.length > 0) {
    console.error(
      `\nBLOCKING: ${contractFindings.length} contract doc(s) cover changed code ` +
      'but were not touched in this PR:',
    )
    // #1496: name the satisfied-by path when the doc declares one. The old
    // message said only "update each doc", so every PR dutifully edited the
    // same last-verified line — three merge conflicts in one day between PRs
    // that had ALREADY written the shard that would have satisfied the gate.
    // A gate whose error message hides the intended remedy trains people into
    // the failure mode it was built to prevent.
    for (const f of contractFindings) {
      const viaShard = docsByPath?.get(f.doc)?.satisfiedBy?.length
        ? ` — or add a verification shard matching \`satisfied-by\` (${docsByPath.get(f.doc).satisfiedBy.join(', ')}); the doc itself then needs NO edit`
        : ''
      console.error(`  - ${f.doc}${viaShard}`)
      // #2192: the near-miss deserves its own sentence. Without it this reads
      // as "add a shard" to someone who is looking straight at a shard they
      // just edited, and the remedy looks already done.
      if (f.editedOnlySatisfyMatches?.length) {
        console.error(
          `      NOTE: ${f.editedOnlySatisfyMatches.map((m) => `\`${m}\``).join(', ')} ` +
          'matched that glob but was EDITED, not added. Editing an existing ' +
          'entry does not satisfy the gate — the point is a NEW record for ' +
          'this change. Add your own dated shard; you may keep the edit.',
        )
      }
    }
    console.error('Update each doc (or re-verify it and bump `last-verified`) and push again.')
    process.exit(1)
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Advisory posture: log and exit 0 so it can never block a PR. In
    // --strict mode the gate IS blocking, so a crash must fail closed — a
    // broken gate silently passing is how contract docs rot.
    console.error('coupling-gate error:', err)
    process.exit(process.argv.includes('--strict') ? 1 : 0)
  })
}
