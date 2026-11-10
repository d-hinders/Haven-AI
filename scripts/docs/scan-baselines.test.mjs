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

// The SHA of the newest WHOLE-REPO ledger entry that carries a `Probed clean`
// section. An entry is a `## <date> ...` heading and everything up to the next
// one. A heading-only entry (2026-09-18) has no such section, and a scoped
// entry (2026-09-16 "Analytics page", 2026-09-17 "agent surface") does not
// update the manifest — "a scope is a filter" — so neither moves the pin. The
// scope is read off the heading line: `whole repo` or `full repo`. The SHA is
// read from the "all at `<sha>`" phrase the 2026-11-02 entry uses; an entry
// written another way ("at `<sha>`") fails the pin loudly rather than passing.
export function newestProbedCleanSha(ledgerText) {
  const parts = ledgerText.split(/^## (?=\d{4}-\d{2}-\d{2})/m).slice(1)
  let best = null
  for (const [pos, part] of parts.entries()) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(part)[1]
    const heading = part.split('\n', 1)[0]
    if (!/\b(whole|full) repo\b/i.test(heading)) continue
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

// ---- doc-figure rows (#4631) ---------------------------------------------
//
// A doc figure is a count, ratio or percentage quoted in a `status: current`
// doc. It lives in `docFigures`, never in `rows`: the `rows` pins above are
// about a whole-repo scan's recording and are not narrowed by this array. A
// doc row is exact (no `kind`, no `tolerance`), its `sha` is the commit the
// figures were taken at rather than the ledger's, and its `anchor` is the
// sentence the figures sit in — so a row cannot outlive the prose it pins.

export const DOC_FIGURE_KEYS = ['id', 'doc', 'anchor', 'command', 'figures', 'sha', 'requires']
/** Keys a scan row carries and a doc row must not: a doc figure is exact. */
const DOC_FIGURE_FORBIDDEN = ['block', 'name', 'kind', 'tolerance', 'expect']

const normalise = (s) => s.replace(/\s+/g, ' ').trim()

/** The doc's paragraphs, whitespace-normalised, blank-line delimited. */
export function paragraphsOf(text) {
  return text.split(/\n[ \t]*\n/).map(normalise).filter((p) => p !== '')
}

/** Does `n` occur in `text` as a decimal token (not as part of a longer number)? */
export function hasDecimalToken(text, n) {
  return new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(text)
}

export function checkDocFigureSchema(manifest) {
  const problems = []
  if (!Array.isArray(manifest?.docFigures) || manifest.docFigures.length === 0) {
    return ['manifest has no docFigures array']
  }
  const ids = new Set((manifest.rows ?? []).map((r) => r?.id))
  for (const [i, row] of manifest.docFigures.entries()) {
    const at = `docFigures[${i}] (${row?.id})`
    for (const k of DOC_FIGURE_KEYS) if (!(k in row)) problems.push(`${at}: missing "${k}"`)
    for (const k of ['id', 'doc', 'anchor', 'command', 'sha']) {
      if (k in row && (typeof row[k] !== 'string' || row[k] === '')) problems.push(`${at}: "${k}" must be a non-empty string`)
    }
    for (const k of DOC_FIGURE_FORBIDDEN) if (k in row) problems.push(`${at}: a doc figure carries no "${k}"`)
    if (typeof row.doc === 'string' && !/^docs\/.+\.md$/.test(row.doc)) {
      problems.push(`${at}: doc must be a path under docs/ ending .md`)
    }
    if (typeof row.anchor === 'string' && /\d/.test(row.anchor)) problems.push(`${at}: anchor must contain no digit`)
    if (ids.has(row.id)) problems.push(`${at}: duplicate id`)
    ids.add(row.id)
    if (!Array.isArray(row.figures) || row.figures.length === 0 || !row.figures.every((n) => Number.isInteger(n) && n >= 0)) {
      problems.push(`${at}: figures must be a non-empty array of non-negative integers`)
    }
    if (!Array.isArray(row.requires) || !row.requires.every((t) => typeof t === 'string')) {
      problems.push(`${at}: requires must be an array of tool names`)
    }
  }
  return problems
}

/** The doc exists, is `status: current`, and the anchor occurs exactly once in it. */
export function checkDocFigureAnchors(manifest, readDoc) {
  const problems = []
  for (const row of manifest.docFigures ?? []) {
    let text
    try {
      text = readDoc(row.doc)
    } catch {
      problems.push(`${row.id}: cannot read ${row.doc}`)
      continue
    }
    const status = /^---\r?\n[\s\S]*?^status:[ \t]*(\S+)/m.exec(text)?.[1]
    if (status !== 'current') problems.push(`${row.id}: ${row.doc} is not status: current (read "${status ?? 'none'}")`)
    const anchor = normalise(row.anchor)
    const hits = normalise(text).split(anchor).length - 1
    if (hits !== 1) {
      problems.push(
        `${row.id}: anchor occurs ${hits} time(s) in ${row.doc}, expected exactly once — update or delete the row in docs/quality/scan-baselines.json`,
      )
    }
  }
  return problems
}

/**
 * The row is linked to the doc's number: the anchor's paragraph must state
 * every recorded figure as a decimal token. A row whose doc says 191 while the
 * manifest says 200 fails here, and so does a renamed sentence.
 */
export function checkDocFigureParagraphs(manifest, readDoc) {
  const problems = []
  for (const row of manifest.docFigures ?? []) {
    let text
    try {
      text = readDoc(row.doc)
    } catch {
      problems.push(`${row.id}: cannot read ${row.doc}`)
      continue
    }
    const anchor = normalise(row.anchor)
    const paragraph = paragraphsOf(text).find((p) => p.includes(anchor))
    if (!paragraph) {
      problems.push(
        `${row.id}: no paragraph in ${row.doc} contains the anchor — update or delete the row in docs/quality/scan-baselines.json`,
      )
      continue
    }
    for (const n of row.figures ?? []) {
      if (!hasDecimalToken(paragraph, n)) {
        problems.push(
          `${row.id}: ${row.doc} does not state ${n} in the anchor's paragraph — update or delete the row in docs/quality/scan-baselines.json`,
        )
      }
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
  const newer = `${ledger}\n## 2099-01-01 — whole repo, a later scan\n\n**Probed clean** (block → command → number, all at \`abcdef123\`):\n- sizing → x\n`
  assert.match(checkShaMatchesLedger(manifest, newer).join('\n'), /abcdef123/)
  // A later SCOPED entry with its own Probed clean section does not move the
  // pin: a scoped scan does not update the manifest (review should-fix 1).
  const scoped = `${ledger}\n## 2099-01-01 — Analytics page (owner mandate)\n\n**Probed clean** (all at \`deadbeef1\`):\n- block 3 → x\n`
  assert.deepEqual(checkShaMatchesLedger(manifest, scoped), [])
  // A heading-only later entry does not move the pin.
  const headingOnly = `${ledger}\n## 2099-01-01 — heading only\n\nno probed section here\n`
  assert.deepEqual(checkShaMatchesLedger(manifest, headingOnly), [])
  // A Probed clean section without the phrase is a problem, not a silent pass.
  const noPhrase = `${ledger}\n## 2099-01-01 — whole repo\n\n**Probed clean** (no sha given)\n`
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

// ---- doc-figure rows (#4631) ---------------------------------------------

const readDoc = (rel) => readFileSync(`${repoRoot}${rel}`, 'utf8')

test('every doc figure has the pinned schema', () => {
  assert.deepEqual(checkDocFigureSchema(manifest), [])
})

test('every doc figure names a current doc and an anchor that occurs exactly once', () => {
  assert.deepEqual(checkDocFigureAnchors(manifest, readDoc), [])
})

test('every doc figure is stated in its anchor paragraph as a decimal token', () => {
  assert.deepEqual(checkDocFigureParagraphs(manifest, readDoc), [])
})

test('negative: the doc-figure schema rejects each key and each forbidden scan key', () => {
  const variants = [
    [(r) => delete r.id, /missing "id"/],
    [(r) => delete r.doc, /missing "doc"/],
    [(r) => delete r.anchor, /missing "anchor"/],
    [(r) => delete r.command, /missing "command"/],
    [(r) => delete r.figures, /missing "figures"/],
    [(r) => delete r.sha, /missing "sha"/],
    [(r) => delete r.requires, /missing "requires"/],
    [(r) => (r.doc = 'packages/frontend/README.md'), /path under docs\//],
    [(r) => (r.anchor = 'Ghost dominates: 191'), /anchor must contain no digit/],
    [(r) => (r.figures = []), /non-empty array/],
    [(r) => (r.figures = [1.5]), /non-empty array/],
    [(r) => (r.requires = 'rg'), /array of tool names/],
    [(r) => (r.kind = 'count'), /carries no "kind"/],
    [(r) => (r.tolerance = 0), /carries no "tolerance"/],
    [(r) => (r.id = manifest.rows[0].id), /duplicate id/],
  ]
  for (const [edit, expected] of variants) {
    const m = clone(manifest)
    edit(m.docFigures[0])
    assert.match(checkDocFigureSchema(m).join('\n'), expected)
  }
  const none = clone(manifest)
  delete none.docFigures
  assert.deepEqual(checkDocFigureSchema(none), ['manifest has no docFigures array'])
})

test('negative: the anchor pin rejects a repeated anchor, a missing anchor and a non-current doc', () => {
  const doc = 'docs/product/design-system.md'
  const text = readDoc(doc)
  let m = clone(manifest)
  m.docFigures[0].anchor = 'a sentence that is not in the doc'
  assert.match(checkDocFigureAnchors(m, readDoc).join('\n'), /anchor occurs 0 time/)
  m = clone(manifest)
  m.docFigures[0].anchor = 'Ghost dominates:'
  assert.match(
    checkDocFigureAnchors(m, (rel) => (rel === doc ? `${text}\n\nGhost dominates:\n` : readDoc(rel))).join('\n'),
    /anchor occurs 2 time/,
  )
  m = clone(manifest)
  assert.match(
    checkDocFigureAnchors(m, (rel) => (rel === doc ? text.replace(/^status: current$/m, 'status: record') : readDoc(rel))).join('\n'),
    /not status: current/,
  )
})

test('negative: the paragraph pin rejects a figure the doc does not state, naming the row and the fix', () => {
  const m = clone(manifest)
  m.docFigures[0].figures = [200, 31, 8, 4]
  const problems = checkDocFigureParagraphs(m, readDoc).join('\n')
  assert.match(problems, /ds-button-variant-distribution/)
  assert.match(problems, /does not state 200/)
  assert.match(problems, /update or delete the row in docs\/quality\/scan-baselines\.json/)
  // A renamed sentence fails with the same instruction.
  const renamed = clone(manifest)
  renamed.docFigures[0].anchor = 'a sentence that is not in the doc'
  assert.match(checkDocFigureParagraphs(renamed, readDoc).join('\n'), /no paragraph .* contains the anchor/)
})

test('negative: a doc row dressed as a scan row still fails the ledger-SHA pin', () => {
  // The escape this closes: moving a doc row into `rows` so the ledger-SHA pin
  // skips it. A doc row's `sha` is the commit its figures were taken at, never
  // the newest whole-repo scan's, so the pin rejects it on the sha alone.
  const m = clone(manifest)
  m.rows.push({ ...m.docFigures[0] })
  const problems = checkShaMatchesLedger(m, ledger).join('\n')
  assert.match(problems, /ds-button-variant-distribution/)
  // The doc row's own sha, whatever the doc's editor last recorded it as — a
  // literal here would go red on the very PR that is supposed to move it.
  assert.match(problems, new RegExp(m.docFigures[0].sha))
  // And the schema pin still refuses it as a scan row (no block, no kind).
  assert.match(checkSchema(m).join('\n'), /missing "block"/)
})

