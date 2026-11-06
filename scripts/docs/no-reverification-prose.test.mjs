// Self-test for the re-verification prose guard (#4614, epic #4610).
//
// The guard's refusal lives in `main()`, so this drives the real CLI as a
// process against fixture docs — the seam `scripts/test-support/guard-cli.mjs`
// provides (#2720). Testing the exported predicate would prove the predicate
// and leave the refusal itself unproven.
//
// Every case is named by the SHAPE it pins, because the rule is a census rule
// and not a list: a shape that stops being refused has to redden here by name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runGuard } from '../test-support/guard-cli.mjs'

const GUARD = 'docs/no-reverification-prose.mjs'
const OPTS = { also: ['docs/validate-frontmatter.mjs'] }

const FM = (status) =>
  `---\nowner: "@d-hinders"\nstatus: ${status}\ncovers: []  # narrative — no code mirror by design\nlast-verified: "2026-11-02"\n---\n`

/** The four root docs `listDocFiles()` always adds, so the walker has a population. */
const ROOT_DOCS = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'ABOUT_HAVEN.md']

/** A fixture tree: the root docs plus whatever `docs` the case writes. */
function fixture(docs) {
  const files = {}
  for (const root of ROOT_DOCS) files[root] = `${FM('current')}\n# Root\n`
  return { ...files, ...docs }
}

const doc = (status, body) => `${FM(status)}\n${body}`

/** The 1-based file line of the first line containing `needle`. */
function lineOf(status, body, needle) {
  const i = doc(status, body).split('\n').findIndex((line) => line.includes(needle))
  assert.notEqual(i, -1, `the fixture body contains ${needle}`)
  return i + 1
}

/** Run the guard over one doc and assert it refuses, naming the line. */
function refuses(body, needle, status = 'current') {
  const { status: code, out } = runGuard(GUARD, {
    ...OPTS,
    files: fixture({ 'docs/area/thing.md': doc(status, body) }),
  })
  assert.equal(code, 1, out)
  assert.match(out, new RegExp(`docs/area/thing\\.md:${lineOf(status, body, needle)}\\b`))
  return out
}

/** Run the guard over one doc and assert it accepts. */
function accepts(body, status = 'current', extra = {}) {
  const { status: code, out } = runGuard(GUARD, {
    ...OPTS,
    files: fixture({ 'docs/area/thing.md': doc(status, body), ...extra }),
  })
  assert.equal(code, 0, out)
  return out
}

// ---------------------------------------------------------------------------
// Refused shapes
// ---------------------------------------------------------------------------

test('refuses a bare `Re-verified 2026-11-02 (…)` opener', () => {
  refuses('\nRe-verified 2026-11-02 (fixture).\n', 'Re-verified')
})

test('refuses a `## Re-checked 2026-10-26 …` heading opener', () => {
  refuses('\n## Re-checked 2026-10-26 against the fixture.\n', 'Re-checked')
})

test('refuses a `**Re-verified …**` opener', () => {
  refuses('\n**Re-verified 2026-11-02.**\n', 'Re-verified')
})

test('refuses a `> Re-verified …` opener', () => {
  refuses('\n> Re-verified 2026-11-02.\n', 'Re-verified')
})

test('refuses a `> **Re-verified 2026-11-02 (…)**` opener', () => {
  refuses('\n> **Re-verified 2026-11-02 (fixture).**\n', 'Re-verified')
})

test('refuses a `> **Re-verified #4438 (2026-10-26, …):**` opener', () => {
  refuses('\n> **Re-verified #4438 (2026-10-26, fixture):**\n', 'Re-verified')
})

test('refuses an indented `  > **Re-verified` opener', () => {
  refuses('\n  > **Re-verified 2026-11-02.**\n', 'Re-verified')
})

test('refuses a `Re-verified **2026-10-13**` opener', () => {
  refuses('\nRe-verified **2026-10-13**.\n', 'Re-verified')
})

test('refuses a `**Re-verified against `abc`**` opener', () => {
  refuses('\n**Re-verified against `abc`.**\n', 'Re-verified')
})

test('refuses a `> **Re-verification (#4567, 2026-10-31):**` opener', () => {
  refuses('\n> **Re-verification (#4567, 2026-10-31):**\n', 'Re-verification')
})

test('refuses a `> **Recent re-verification (#4560):**` opener', () => {
  refuses('\n> **Recent re-verification (#4560):**\n', 'Recent re-verification')
})

test('refuses a `#3542 re-verification (2026-10-01):` opener', () => {
  refuses('\n#3542 re-verification (2026-10-01):\n', 're-verification')
})

test('refuses a `> **Re-read, not rubber-stamped:**` opener', () => {
  refuses('\n> **Re-read, not rubber-stamped:**\n', 'Re-read')
})

test('refuses a `> **Re-verified, every host …` opener', () => {
  refuses('\n> **Re-verified, every host in the fixture.**\n', 'Re-verified')
})

test('refuses a `> **#3542 (2026-10-01).** Re-verified unchanged` opener', () => {
  // The word is not at the start of the line; the first 70 characters carry it.
  refuses('\n> **#3542 (2026-10-01).** Re-verified unchanged.\n', 'Re-verified unchanged')
})

test('refuses a lower-case `re-verified` opener', () => {
  refuses('\nre-verified 2026-11-02.\n', 're-verified')
})

test('refuses a `> **Re-verified unchanged (#3267 …):**` opener after a bare `>` line', () => {
  refuses(
    '\n> **Re-verified unchanged (#3267, 2026-10-01):**\n>\n> **Re-verified unchanged (#3267, 2026-10-02):**\n',
    '#3267, 2026-10-02',
  )
})

test('refuses an opener in a doc with no status, which is governed', () => {
  const raw = `---\nowner: "@d-hinders"\ncovers: []  # narrative — no code mirror by design\nlast-verified: "2026-11-02"\n---\n\nRe-verified 2026-11-02 (fixture).\n`
  const { status, out } = runGuard(GUARD, { ...OPTS, files: fixture({ 'docs/area/thing.md': raw }) })
  assert.equal(status, 1, out)
  assert.match(out, /docs\/area\/thing\.md:7\b/)
})

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

test('accepts the same body under `status: record`', () => {
  accepts('\nRe-verified 2026-11-02 (fixture).\n', 'record')
})

test('accepts the same body under `status: archived`', () => {
  accepts('\nRe-verified 2026-11-02 (fixture).\n', 'archived')
})

test('accepts the same body under `status: research`', () => {
  accepts('\nRe-verified 2026-11-02 (fixture).\n', 'research')
})

test('accepts a `current` doc whose only match is inside a fenced code block', () => {
  accepts('\n```markdown\n## Re-verified 2026-11-02 (fixture)\n```\n')
})

test('accepts a `current` doc whose only match is the second line of a paragraph', () => {
  accepts('\nA paragraph that opens here.\nRe-verified 2026-11-02 (fixture).\n')
})

test("accepts a `current` doc whose only match is a wrapped line starting `#3634's … Re-checked …`", () => {
  accepts("\nA paragraph that opens here and wraps onto\n#3634's line, Re-checked 2026-10-01.\n")
})

test('accepts a `current` doc whose only match is inside a blockquote run after its first line', () => {
  accepts('\n> **Fixture note (#1, 2026-10-01):**\n> Re-checked the fixture.\n')
})

test('accepts a `current` doc whose only match is in its front matter', () => {
  const raw = `---\nowner: "@d-hinders"\nstatus: current\ncovers: []  # narrative — no code mirror by design\n\n# Re-verified 2026-11-02 (front matter)\nlast-verified: "2026-11-02"\n---\n\nA clean body.\n`
  const { status, out } = runGuard(GUARD, { ...OPTS, files: fixture({ 'docs/area/thing.md': raw }) })
  assert.equal(status, 0, out)
})

test('accepts an opener in a CASP changelog shard, which the walker excludes', () => {
  const { status, out } = runGuard(GUARD, {
    ...OPTS,
    files: fixture({ 'docs/regulatory/casp-changelog/2026-01-01-1.md': 'Re-verified 2026-11-02 (fixture).\n' }),
  })
  assert.equal(status, 0, out)
})

// ---------------------------------------------------------------------------
// The CLI itself
// ---------------------------------------------------------------------------

test('accepts a clean tree and says how many docs it scanned', () => {
  const { status, out } = runGuard(GUARD, {
    ...OPTS,
    files: fixture({ 'docs/area/thing.md': doc('current', '\n# A Doc\n') }),
  })
  assert.equal(status, 0, out)
  // The COUNT is asserted, not just the tick: a walker pointed at the wrong
  // root prints the same tick over zero files.
  assert.match(out, /✓ no re-verification prose in a governed doc \(5 docs scanned\)/)
})

test('--census reports every status and never refuses', () => {
  const { status, out } = runGuard(GUARD, {
    ...OPTS,
    args: ['--census'],
    files: fixture({
      'docs/area/current.md': doc('current', '\nRe-verified 2026-11-02.\n'),
      'docs/area/record.md': doc('record', '\nRe-verified 2026-11-02.\n'),
    }),
  })
  assert.equal(status, 0, out)
  assert.match(out, /'current': 1/)
  assert.match(out, /'record': 1/)
})

test('an unknown argument exits 2 rather than scanning', () => {
  const { status, out } = runGuard(GUARD, { ...OPTS, args: ['--nope'], files: fixture({}) })
  assert.equal(status, 2, out)
  assert.match(out, /unknown argument\(s\): --nope/)
})
