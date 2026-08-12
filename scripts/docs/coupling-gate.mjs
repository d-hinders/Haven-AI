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
export function changedFilesWithProvenance() {
  const explicit = arg('changed')
  if (explicit !== undefined) {
    return { files: explicit.split(',').map((s) => s.trim()).filter(Boolean), computed: true }
  }
  const base = process.env.BASE_SHA
  if (base) {
    const head = process.env.HEAD_SHA || 'HEAD'
    // THREE-DOT (merge-base): a two-dot diff against a moving base branch lists
    // files the PR never touched as "changed" (same flaw fixed in the
    // design-system coupling gate, code review 2026-07-13).
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      return { files: out.split('\n').map((s) => s.trim()).filter(Boolean), computed: true }
    } catch {
      // The range itself failed (missing SHA, shallow clone) — NOT a clean bill.
      return { files: [], computed: false }
    }
  }
  // Local run (no BASE_SHA): the candidate change is whatever a reviewer would
  // look at, which includes work not committed yet. A committed-only range
  // reports a clean bill of health for an uncommitted diff — the false green
  // that let #1076's contract-doc failure reach CI, because the skill runs this
  // during review, before the commit. CI is unaffected: it always sets BASE_SHA.
  // Local: an empty union here is ambiguous (pre-commit run, #1076) — never
  // provably computed-and-empty.
  return {
    files: [...new Set([
      ...gitLines(['diff', '--name-only', 'origin/dev...HEAD']),
      ...gitLines(['diff', '--name-only', 'HEAD']), // staged + unstaged tracked
      ...gitLines(['ls-files', '--others', '--exclude-standard']), // untracked
    ])].sort(),
    computed: false,
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
 * Same-day suppression: a doc whose `last-verified` is `today` is skipped — it
 * was already confirmed accurate in this day's work, so re-flagging it on every
 * subsequent edit to a covered file is just noise. This is a heuristic: it
 * trades a small same-day-staleness risk for far less noise. `today` is
 * injectable for testing.
 *
 * It does NOT apply to a contract doc under `strict`. The advisory comment can
 * afford a wall-clock heuristic; a blocking gate cannot — it would be green at
 * 23:59 and red at 00:01 with no code change, and a doc that some *other* PR
 * verified today says nothing about whether this PR made it stale.
 *
 * Note: the default `today` is the UTC calendar date, while `last-verified` is a
 * human-written local date — so for non-UTC contributors the match can be off by
 * at most ±1 calendar day. Harmless for the advisory half (worst case: one extra
 * comment), and the strict half no longer depends on it at all.
 */
export function implicatedDocs(
  changed,
  docs,
  today = new Date().toISOString().slice(0, 10),
  { strict = false } = {},
) {
  const changedSet = new Set(changed)
  const findings = []
  for (const { doc, covers, lastVerified, contract, satisfiedBy } of docs) {
    if (changedSet.has(doc)) continue
    // #1366: a doc may declare `satisfied-by:` globs — touching a matching
    // file counts as touching the doc itself. Built for the CASP changelog
    // shards: every money-path PR must still write its verification entry,
    // but as `docs/regulatory/casp-changelog/<date>-<issue>.md` (a file no
    // parallel PR also edits) instead of appending to one monolithic EOF —
    // the line-collision class that made four PRs conflict in one day.
    if (
      satisfiedBy &&
      satisfiedBy.some((glob) => {
        const re = globToRegExp(glob)
        return changed.some((f) => re.test(f))
      })
    ) {
      continue
    }
    if (!covers || covers.length === 0) continue
    if (lastVerified && lastVerified === today && !(strict && contract)) continue
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
      findings.push({ doc, lastVerified, contract: Boolean(contract), matched: [...matched].sort() })
    }
  }
  return findings
}

async function main() {
  const outPath = arg('out') || 'coupling-comment.md'
  const strict = process.argv.includes('--strict')
  const { files: changed, computed } = changedFilesWithProvenance()

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

  const findings = implicatedDocs(changed, docs, undefined, { strict })
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
    for (const f of contractFindings) console.error(`  - ${f.doc}`)
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
