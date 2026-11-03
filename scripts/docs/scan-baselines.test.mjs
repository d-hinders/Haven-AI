// Pins `docs/quality/scan-baselines.json` (#4625), the machine-readable source
// of the quality-scan "Probed clean" figures that `scripts/docs/scan-remeasure.mjs`
// re-runs weekly. The docs job checks out at depth 1, so this reads FILES ONLY:
// it never runs a row's command and never touches git history. Reproducing the
// figures is the runner's job (and the acceptance-time run on the PR), not this
// test's.
//
// Each pin is a function over (manifest, ledger) that returns a list of
// problems, so a negative case can feed the same function an in-memory
// modified manifest or ledger and show the pin rejects it.
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export const KINDS = ['invariant', 'grows', 'head-sample', 'count', 'control']
export const EXPECTS = ['nonzero', 'no-CONTROL-FAILED-line']
export const REQUIRED_BLOCKS = ['sizing', '2', '3', '4', '5', '6', 'comment-archaeology']
const ROW_KEYS = ['id', 'block', 'name', 'kind', 'command', 'figures', 'sha', 'tolerance', 'requires']

// Every pin returns an array of human-readable problems; empty means it holds.

export function checkSchema(manifest) {
  const problems = []
  if (!manifest || !Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    return ['manifest has no rows array']
  }
  const ids = new Set()
  for (const [i, row] of manifest.rows.entries()) {
    const at = `rows[${i}] (${row?.id})`
    for (const k of ROW_KEYS) if (!(k in row)) problems.push(`${at}: missing "${k}"`)
    for (const k of ['id', 'block', 'name', 'command', 'sha']) {
      if (k in row && (typeof row[k] !== 'string' || row[k] === '')) problems.push(`${at}: "${k}" must be a non-empty string`)
    }
    if (ids.has(row.id)) problems.push(`${at}: duplicate id`)
    ids.add(row.id)
    if (!KINDS.includes(row.kind)) problems.push(`${at}: kind "${row.kind}" is not one of ${KINDS.join(', ')}`)
    if (
      !Array.isArray(row.figures) ||
      !row.figures.every((n) => Number.isInteger(n) && n >= 0)
    ) {
      problems.push(`${at}: figures must be an array of non-negative integers`)
    }
    if (typeof row.tolerance !== 'number' || !(row.tolerance >= 0 && row.tolerance < 1)) {
      problems.push(`${at}: tolerance must be a relative fraction in [0, 1)`)
    }
    if (!Array.isArray(row.requires) || !row.requires.every((t) => typeof t === 'string')) {
      problems.push(`${at}: requires must be an array of tool names`)
    }
    if (row.kind !== 'control' && 'expect' in row) problems.push(`${at}: only control rows carry "expect"`)
  }
  return problems
}

export function checkBlocksCovered(manifest) {
  const have = new Set(manifest.rows.map((r) => r.block))
  return REQUIRED_BLOCKS.filter((b) => !have.has(b)).map((b) => `no row for block "${b}"`)
}

// The SHA of the newest ledger entry that carries a `Probed clean` section. An
// entry is a `## <date> ...` heading and everything up to the next one; a
// heading-only entry (2026-09-18) has no such section and does not count.
export function newestProbedCleanSha(ledgerText) {
  const parts = ledgerText.split(/^## (?=\d{4}-\d{2}-\d{2})/m).slice(1)
  let best = null
  for (const [pos, part] of parts.entries()) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(part)[1]
    if (!/Probed clean/.test(part)) continue
    const m = /all at `([0-9a-f]{7,40})`/.exec(part)
    if (!best || date > best.date || (date === best.date && pos > best.pos)) {
      best = { date, pos, sha: m ? m[1] : null }
    }
  }
  return best
}

export function checkShaMatchesLedger(manifest, ledgerText) {
  const newest = newestProbedCleanSha(ledgerText)
  if (!newest) return ['ledger has no entry with a Probed clean section']
  if (!newest.sha) return [`ledger entry ${newest.date} has a Probed clean section but no "all at \`<sha>\`" phrase`]
  return manifest.rows
    .filter((r) => r.sha !== newest.sha)
    .map((r) => `${r.id}: sha "${r.sha}" is not the newest Probed clean entry's "${newest.sha}" (${newest.date})`)
}

export function checkCommands(manifest) {
  const problems = []
  for (const r of manifest.rows) {
    if (typeof r.command !== 'string') continue
    if (!r.command.includes('$SHA')) problems.push(`${r.id}: command does not contain the literal $SHA`)
    if (r.command.includes('origin/dev')) problems.push(`${r.id}: command reads origin/dev`)
    if (/(^|[^\w$])HEAD\b/.test(r.command)) problems.push(`${r.id}: command reads HEAD`)
    if (/(^|[\s'"])rg\s/.test(r.command)) problems.push(`${r.id}: command calls bare rg, use "$RG"`)
  }
  return problems
}

export function checkControls(manifest) {
  const problems = []
  for (const r of manifest.rows) {
    if (r.kind !== 'control') continue
    if (!EXPECTS.includes(r.expect)) {
      problems.push(`${r.id}: control expect "${r.expect}" is not one of ${EXPECTS.join(', ')}`)
      continue
    }
    const n = Array.isArray(r.figures) ? r.figures.length : -1
    if (r.expect === 'nonzero' && n === 0) problems.push(`${r.id}: a nonzero control needs non-empty figures`)
    if (r.expect === 'no-CONTROL-FAILED-line' && n !== 0) problems.push(`${r.id}: a no-CONTROL-FAILED-line control needs figures []`)
    if (r.expect === 'no-CONTROL-FAILED-line' && !r.command.includes('CONTROL FAILED')) {
      problems.push(`${r.id}: a no-CONTROL-FAILED-line control must be able to print a CONTROL FAILED line`)
    }
  }
  return problems
}

const manifest = JSON.parse(readFileSync(`${repoRoot}docs/quality/scan-baselines.json`, 'utf8'))
const ledger = readFileSync(`${repoRoot}docs/quality/scan-ledger.md`, 'utf8')
const clone = (o) => JSON.parse(JSON.stringify(o))

test('every row has the pinned schema', () => {
  assert.deepEqual(checkSchema(manifest), [])
})

test('a row exists for sizing, blocks 2-6 and comment archaeology', () => {
  assert.deepEqual(checkBlocksCovered(manifest), [])
})

test('the ledger parser finds the newest Probed clean entry (positive control)', () => {
  const newest = newestProbedCleanSha(ledger)
  assert.ok(newest, 'a Probed clean entry is found')
  assert.match(newest.sha, /^[0-9a-f]{7,40}$/)
  // A heading-only entry carries no Probed clean section and must not count.
  assert.match(ledger, /^## 2026-09-18 /m, 'the heading-only 2026-09-18 entry still exists to be skipped')
  assert.notEqual(newest.date, '2026-09-18')
  // Anchored at the figures' first scan; a later scan moves this together with the manifest.
  assert.ok(newest.date >= '2026-11-02', `newest Probed clean entry is ${newest.date}`)
})

test('every row sha equals the newest Probed clean ledger entry sha', () => {
  assert.deepEqual(checkShaMatchesLedger(manifest, ledger), [])
})

test('every command contains $SHA and reads no branch, origin/dev or bare rg', () => {
  assert.deepEqual(checkCommands(manifest), [])
})

test('every control row has a valid expect and matching figures', () => {
  assert.ok(manifest.rows.some((r) => r.kind === 'control'), 'the manifest has controls')
  assert.deepEqual(checkControls(manifest), [])
})

// ---- negative cases: each pin rejects an in-memory modification ----------

test('negative: schema rejects a bad kind, a missing key, non-integer figures and a bad tolerance', () => {
  let m = clone(manifest)
  m.rows[0].kind = 'sometimes'
  assert.match(checkSchema(m).join('\n'), /kind "sometimes"/)
  m = clone(manifest)
  delete m.rows[0].command
  assert.match(checkSchema(m).join('\n'), /missing "command"/)
  m = clone(manifest)
  m.rows[0].figures = [1.5]
  assert.match(checkSchema(m).join('\n'), /figures must be an array/)
  m = clone(manifest)
  m.rows[0].tolerance = 5
  assert.match(checkSchema(m).join('\n'), /tolerance/)
  m = clone(manifest)
  m.rows[1].id = m.rows[0].id
  assert.match(checkSchema(m).join('\n'), /duplicate id/)
})

test('negative: block coverage rejects a manifest missing any required block', () => {
  for (const block of REQUIRED_BLOCKS) {
    const m = clone(manifest)
    m.rows = m.rows.filter((r) => r.block !== block)
    assert.deepEqual(checkBlocksCovered(m), [`no row for block "${block}"`])
  }
})

test('negative: the sha pin rejects a stale row sha and a ledger that moved on', () => {
  let m = clone(manifest)
  m.rows[0].sha = '99ef8d063'
  assert.match(checkShaMatchesLedger(m, ledger).join('\n'), /99ef8d063/)
  const newer = `${ledger}\n## 2099-01-01 — a later scan\n\n**Probed clean** (block → command → number, all at \`abcdef123\`):\n- sizing → x\n`
  assert.match(checkShaMatchesLedger(manifest, newer).join('\n'), /abcdef123/)
  // A heading-only later entry does not move the pin.
  const headingOnly = `${ledger}\n## 2099-01-01 — heading only\n\nno probed section here\n`
  assert.deepEqual(checkShaMatchesLedger(manifest, headingOnly), [])
  // A Probed clean section without the phrase is a problem, not a silent pass.
  const noPhrase = `${ledger}\n## 2099-01-01 — x\n\n**Probed clean** (no sha given)\n`
  assert.match(checkShaMatchesLedger(manifest, noPhrase).join('\n'), /no "all at/)
})

test('negative: the command pin rejects a missing $SHA, origin/dev, HEAD and bare rg', () => {
  const variants = [
    [(c) => c.replaceAll('$SHA', 'e0617aa9f'), /\$SHA/],
    [(c) => `${c}\ngit log origin/dev | wc -l`, /origin\/dev/],
    [(c) => `${c}\ngit log HEAD | wc -l`, /HEAD/],
    [(c) => `${c}\nrg -l foo . | wc -l`, /bare rg/],
  ]
  for (const [edit, expected] of variants) {
    const m = clone(manifest)
    m.rows[0].command = edit(m.rows[0].command)
    assert.match(checkCommands(m).join('\n'), expected)
  }
})

test('negative: the control pin rejects a missing expect and mismatched figures', () => {
  const ctl = (kind) => manifest.rows.findIndex((r) => r.kind === 'control' && r.expect === kind)
  let m = clone(manifest)
  delete m.rows[ctl('nonzero')].expect
  assert.match(checkControls(m).join('\n'), /is not one of/)
  m = clone(manifest)
  m.rows[ctl('nonzero')].figures = []
  assert.match(checkControls(m).join('\n'), /non-empty figures/)
  m = clone(manifest)
  m.rows[ctl('no-CONTROL-FAILED-line')].figures = [3]
  assert.match(checkControls(m).join('\n'), /figures \[\]/)
  m = clone(manifest)
  m.rows[ctl('no-CONTROL-FAILED-line')].command = 'echo ok'
  assert.match(checkControls(m).join('\n'), /CONTROL FAILED/)
})
