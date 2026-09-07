// Unit tests for the retired UI merge-gate wording guard (#2657).
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  RULES,
  blankFrontMatter,
  blankFences,
  sentences,
  flatten,
  lineOf,
  flattenWithMap,
  stripMarkupWithMap,
  scanText,
  countByFile,
  newViolations,
  hasShrunk,
} from './ui-gate-wording.mjs'

const SCRIPT = fileURLToPath(new URL('./ui-gate-wording.mjs', import.meta.url))

const FM = '---\nowner: "@d-hinders"\nstatus: current\ncovers: []\nlast-verified: "2026-09-07"\n---\n\n'

// ── The cases five sweeps missed ───────────────────────────────────────────
//
// Both fixtures below are the REAL text, copied verbatim out of `f43bfcc8~1`
// (the commit before #2636 landed) — the two canonical sites, hard-wrapped as
// the repo hard-wraps everything. Each `LINE_BOUND_*` regex beside them is the
// natural phrase-level `grep` a sweep would reach for, and each is asserted to
// find NOTHING here. If these are the only tests that ever fail, the check has
// regressed into exactly the tool that failed five times.

// `.agents/skills/ship-next/SKILL.md` § Merge Gate at f43bfcc8~1:614-615 —
// the site that survived longest, in the doc every other doc calls canonical.
const HARD_WRAPPED_PAUSE = `${FM}## Merge Gate

- **Frontend UI:** a UX, copy, or design-system finding from either review pass pauses
  auto-merge. Clearing it does **not** need a second human ack (#1968).
`
const LINE_BOUND_PAUSE = /pauses auto-merge/

// `docs/product/design-review.md` § Final Verification at f43bfcc8~1:126-127.
const HARD_WRAPPED_TRIGGER = `${FM}- Capture rendered-screen evidence for any diff touching a rendered route or a
  shared primitive: \`npm run screenshot -w packages/frontend -- <routes>\`.
`
const LINE_BOUND_TRIGGER = /rendered route or a shared primitive/

const SINGLE_LINE = `${FM}A finding from either pass pauses auto-merge.\n`

test('the hard-wrapped blanket pause — the site five line-bound sweeps missed — is caught', () => {
  // Negative control first: the wrap really does defeat the line-scoped form,
  // so "caught" below means something.
  assert.equal(HARD_WRAPPED_PAUSE.split('\n').some((l) => LINE_BOUND_PAUSE.test(l)), false)
  // Positive control for the same regex: it CAN say yes, on the flat text.
  assert.equal(LINE_BOUND_PAUSE.test(flatten(HARD_WRAPPED_PAUSE)), true)

  const hits = scanText('doc.md', HARD_WRAPPED_PAUSE)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].rule, 'blanket-merge-pause')
  assert.match(hits[0].sentence, /finding from either review pass pauses auto-merge/)
  // Reported at the line the phrase starts on, not the top of the file.
  assert.equal(hits[0].line, 10)
  assert.match(HARD_WRAPPED_PAUSE.split('\n')[hits[0].line - 1], /Frontend UI/)
})

test('the hard-wrapped rendered-evidence trigger is caught', () => {
  assert.equal(HARD_WRAPPED_TRIGGER.split('\n').some((l) => LINE_BOUND_TRIGGER.test(l)), false)
  assert.equal(LINE_BOUND_TRIGGER.test(flatten(HARD_WRAPPED_TRIGGER)), true)

  const hits = scanText('doc.md', HARD_WRAPPED_TRIGGER)
  assert.deepEqual(hits.map((h) => h.rule), ['retired-rendered-evidence-trigger'])
})

test('the same rule on one line is caught too', () => {
  const hits = scanText('doc.md', SINGLE_LINE)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].rule, 'blanket-merge-pause')
})

// ── The corrected form must NOT be flagged ─────────────────────────────────

test('the corrected `blocking`/`should-fix` wording is not a violation', () => {
  const corrected = `${FM}- **Frontend UI:** a **\`blocking\`** or **\`should-fix\`** UX, copy, or design-system
  finding from either review pass pauses auto-merge; a **\`nit\`** does not (#2636).
`
  assert.deepEqual(scanText('doc.md', corrected), [])
})

test('the corrected form is still caught once its severity qualifier is removed', () => {
  // The exclusion is what keeps the check quiet on `dev`; this asserts the
  // exclusion is doing that job and not silently swallowing everything.
  const corrected = `${FM}A \`blocking\` or \`should-fix\` finding from either pass pauses auto-merge.\n`
  assert.deepEqual(scanText('doc.md', corrected), [])
  const stripped = corrected.replace('A `blocking` or `should-fix` finding', 'A finding')
  assert.equal(scanText('doc.md', stripped).length, 1)
})

// ── Front-matter is not scanned ────────────────────────────────────────────

test('a `last-verified` chain entry quoting the retired wording is not a violation', () => {
  // Real shape: #2636's own chain entries describe the wording they retired,
  // and will keep doing so forever.
  const raw =
    '---\nowner: "@d-hinders"\nstatus: current\ncovers: []\n' +
    'last-verified: "2026-09-07" # #2636: EDITED — "a finding from either pauses ' +
    'auto-merge" was the blanket rule this retires. Prior: #1968: a design finding ' +
    'still pauses auto-merge, but CLEARING it no longer needs a human ack.\n---\n\n# Doc\n'
  assert.deepEqual(scanText('doc.md', raw), [])
})

test('front-matter is blanked newline-for-newline, so body line numbers stay true', () => {
  const raw = `${FM}line\n\nA finding from either pass pauses auto-merge.\n`
  const blanked = blankFrontMatter(raw)
  assert.equal(blanked.length, raw.length)
  assert.equal(blanked.split('\n').length, raw.split('\n').length)
  assert.equal(blanked.trim(), raw.slice(FM.length).trim())
  const hits = scanText('doc.md', raw)
  assert.equal(hits.length, 1)
  assert.equal(raw.split('\n')[hits[0].line - 1], 'A finding from either pass pauses auto-merge.')
})

test('flattenWithMap maps each flattened index back to its source index', () => {
  const src = 'a rendered\n  route.'
  const { flat, map } = flattenWithMap(src)
  assert.equal(flat, 'a rendered route.')
  assert.equal(flat.length, map.length)
  assert.equal(src.slice(map[flat.indexOf('route')], map[flat.indexOf('route')] + 5), 'route')
})

test('a body that quotes a chain entry is filtered by substring', () => {
  const raw = `${FM}For example: \`last-verified: "2026-09-07" # #2636: a finding from either pass pauses auto-merge\` is chain text.\n`
  assert.deepEqual(scanText('doc.md', raw), [])
})

// ── Segmentation and helpers ───────────────────────────────────────────────

test('sentences span newlines and never split on one', () => {
  const segs = sentences('one\ntwo. three\nfour.')
  assert.deepEqual(segs.map((s) => flatten(s.text)), ['one two.', 'three four.'])
})

test('sentences terminate on trailing text with no final period', () => {
  assert.deepEqual(sentences('a. b').map((s) => flatten(s.text)), ['a.', 'b'])
})

test('sentences terminates on consecutive periods — no loop, no zero-length segments', () => {
  // Historical shape: the old regex splitter needed a lastIndex guard to
  // survive zero-length matches. The index-walking scanner (#2671) cannot loop
  // by construction; an ellipsis is ONE fragment, never three empty ones.
  const segs = sentences('...')
  assert.ok(segs.length >= 1 && segs.length <= 3)
  for (const s of segs) assert.ok(s.text.trim().length > 0)
})

test('a URL dot does not end a sentence (#2671 defect 1)', () => {
  // example.com's dot used to split the sentence, stranding the two required
  // terms in different fragments — the retired phrase sailed through.
  const segs = sentences('See https://example.com/docs for details. Next sentence.')
  assert.deepEqual(segs.map((s) => flatten(s.text)), [
    'See https://example.com/docs for details.',
    'Next sentence.',
  ])
  const hits = scanText(
    'doc.md',
    'See [a rendered route](https://example.com/docs) for a shared primitive.',
  )
  assert.deepEqual(hits.map((h) => h.rule), ['retired-rendered-evidence-trigger'])
})

test('comparison prose in angle brackets is prose, not a tag (#2671 defect 2)', () => {
  // `< shared primitive >` has no tag name; the old `<[^>]*>` blanked it whole
  // and deleted the very word the guard looks for.
  const { plain } = stripMarkupWithMap('a < shared primitive > b')
  assert.equal(plain, 'a < shared primitive > b')
  const hits = scanText('doc.md', 'a rendered route depends on < shared primitive > wiring today.')
  assert.deepEqual(hits.map((h) => h.rule), ['retired-rendered-evidence-trigger'])
})

test('a real tag is still stripped, with its position mapped (#2671 defect 3)', () => {
  const { plain, idx } = stripMarkupWithMap('a rendered <!-- x --> route or a shared primitive')
  assert.equal(plain, 'a rendered route or a shared primitive')
  // idx maps each surviving character back to its input index.
  const at = plain.indexOf('route')
  assert.equal('a rendered <!-- x --> route'.slice(idx[at], idx[at] + 5), 'route')
})

test('a violation is reported at the phrase, not at an earlier lookalike (#2671 defect 3)', () => {
  // Markup between the terms defeats any adjacency match on the unstripped
  // text; an unrelated earlier "rendered" used to steal the reported line.
  const raw = `${FM}A rendered diagram was here.\n\nany diff touching a rendered <!-- x -->\nroute or a shared primitive needs evidence.\n`
  const hits = scanText('doc.md', raw)
  assert.equal(hits.length, 1)
  const lineText = raw.split('\n')[hits[0].line - 1]
  assert.match(lineText, /rendered <!-- x -->|route or a shared/)
})

test('fenced code blocks are citations, not prose (#2671 defect 4)', () => {
  assert.deepEqual(scanText('doc.md', '```\na rendered route\n```\nfor a shared primitive.'), [])
  // Line numbers stay true after blanking: a live violation AFTER a fence
  // still reports its real line.
  const raw = `${FM}\`\`\`\na rendered route\n\`\`\`\n\nThe retired form: any diff touching a rendered\nroute or a shared primitive.\n`
  const hits = scanText('doc.md', raw)
  assert.equal(hits.length, 1)
  assert.match(raw.split('\n')[hits[0].line - 1], /rendered$/)
})

test('blankFences preserves byte offsets and newline counts', () => {
  const raw = 'prose\n```js\nconst a = 1\n```\ntail\n'
  const blanked = blankFences(raw)
  assert.equal(blanked.length, raw.length)
  assert.equal(blanked.split('\n').length, raw.split('\n').length)
  assert.equal(blanked.split('\n')[2].trim(), '')
  assert.equal(blanked.split('\n')[0], 'prose')
  assert.equal(blanked.split('\n')[4], 'tail')
})

test('lineOf is 1-based', () => {
  assert.equal(lineOf('a\nb\nc', 0), 1)
  assert.equal(lineOf('a\nb\nc', 4), 3)
})

test('a sentence needs every required term, not just one', () => {
  assert.deepEqual(scanText('doc.md', `${FM}The reviewer records a finding.\n`), [])
  assert.deepEqual(scanText('doc.md', `${FM}Auto-merge pauses on red CI.\n`), [])
  assert.deepEqual(scanText('doc.md', `${FM}A shared primitive changed.\n`), [])
})

test('terms in either order are caught — the check is not order-bound', () => {
  const raw = `${FM}A shared primitive under a rendered route requires screenshots.\n`
  assert.deepEqual(scanText('doc.md', raw).map((h) => h.rule), ['retired-rendered-evidence-trigger'])
})

test('every rule declares an id, a description and a fix', () => {
  for (const r of RULES) {
    assert.ok(r.id && r.what && r.fix, `rule ${r.id} is incomplete`)
    assert.ok(r.requires.length > 0, `rule ${r.id} has no required terms`)
  }
})

// ── Baseline ratchet ───────────────────────────────────────────────────────

test('countByFile groups per file and per rule', () => {
  const counts = countByFile([
    { file: 'a.md', rule: 'blanket-merge-pause' },
    { file: 'a.md', rule: 'blanket-merge-pause' },
    { file: 'b.md', rule: 'retired-rendered-evidence-trigger' },
  ])
  assert.deepEqual(counts, {
    'a.md': { 'blanket-merge-pause': 2 },
    'b.md': { 'retired-rendered-evidence-trigger': 1 },
  })
})

test('a count at the baseline passes; one over it fails', () => {
  const baseline = { 'a.md': { 'blanket-merge-pause': 1 } }
  assert.deepEqual(newViolations({ 'a.md': { 'blanket-merge-pause': 1 } }, baseline), [])
  assert.deepEqual(newViolations({ 'a.md': { 'blanket-merge-pause': 2 } }, baseline), [
    { file: 'a.md', rule: 'blanket-merge-pause', count: 2, allowed: 1 },
  ])
})

test('a violation in an unbaselined file fails', () => {
  assert.equal(newViolations({ 'new.md': { 'blanket-merge-pause': 1 } }, {}).length, 1)
})

test('the baseline is per rule, not per file — one rule cannot cover the other', () => {
  const baseline = { 'a.md': { 'retired-rendered-evidence-trigger': 1 } }
  assert.equal(newViolations({ 'a.md': { 'blanket-merge-pause': 1 } }, baseline).length, 1)
})

test('hasShrunk reports residue that fell below the ratchet', () => {
  const baseline = { 'a.md': { 'blanket-merge-pause': 2 } }
  assert.equal(hasShrunk({ 'a.md': { 'blanket-merge-pause': 2 } }, baseline), false)
  assert.equal(hasShrunk({ 'a.md': { 'blanket-merge-pause': 1 } }, baseline), true)
  assert.equal(hasShrunk({}, baseline), true)
})

// ── The CLI, over the real repository ──────────────────────────────────────

test('the check is green on the repository as it stands', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /✓ No retired UI merge-gate wording/)
})
