// Guards for the wire-type ratchet (#1447, epic #1442).
//
// A lint gate is only worth its CI minutes if it can fail, and only worth
// trusting if it does not fail on the wrong things. Both halves are tested
// here: what it must catch, and what it must leave alone.
// Run with: node --test scripts/lint-wire-types.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { newViolations } from './lib/ratchet.mjs'
import { scanSource, readBlock, updateRefusals, BASELINE_PATH } from './lint-wire-types.mjs'

// — scanSource — what counts as a wire shape —
test('counts an interface with a snake_case property', () => {
  assert.deepEqual(scanSource(`export interface Agent {\n  api_key_prefix: string\n}`), { Agent: 1 })
})

test('counts a type alias too, not just an interface', () => {
  assert.deepEqual(scanSource(`type Row = {\n  token_symbol: string\n}`), { Row: 1 })
})

test('counts an optional and a quoted snake_case key', () => {
  assert.deepEqual(scanSource(`interface A {\n  reset_period_min?: number\n}`), { A: 1 })
  assert.deepEqual(scanSource(`interface B {\n  'safe_chain_id': number\n}`), { B: 1 })
})

test('sees a snake_case key nested inside the shape', () => {
  // The whole reason readBlock exists: stopping at the first `}` would miss
  // the wire fields of every nested object.
  const source = `interface Setup {\n  agent: { name: string }\n  wallet: {\n    chain_id: number\n  }\n}`
  assert.deepEqual(scanSource(source), { Setup: 1 })
})

test('ignores a camelCase-only UI type', () => {
  assert.deepEqual(scanSource(`interface Props {\n  onClose: () => void\n  isOpen: boolean\n}`), {})
})

test('ignores an ApiSchema-derived alias — that IS the generated type', () => {
  assert.deepEqual(scanSource(`export type Agent = ApiSchema<'Agent'>`), {})
})

test('honours a ui-local exemption with a reason', () => {
  const source = `// ui-local: local form state that mirrors the wire field names\ninterface Draft {\n  token_symbol: string\n}`
  assert.deepEqual(scanSource(source), {})
})

test('does NOT honour a bare marker or a too-short reason', () => {
  assert.deepEqual(scanSource(`// ui-local:\ninterface D {\n  token_symbol: string\n}`), { D: 1 })
  assert.deepEqual(scanSource(`// ui-local: because\ninterface E {\n  token_symbol: string\n}`), { E: 1 })
})

test('does not let one file\'s exemption leak to the next declaration', () => {
  // The marker applies to the declaration it precedes, not to the whole file.
  const source =
    `// ui-local: this one really is local UI state, not a response\n` +
    `interface Exempt {\n  token_symbol: string\n}\n\n` +
    `interface NotExempt {\n  token_symbol: string\n}\n`
  assert.deepEqual(scanSource(source), { NotExempt: 1 })
})

test('does not count a snake_case word that is not a property key', () => {
  assert.deepEqual(scanSource(`interface F {\n  label: 'reset_period_min shown to the user'\n}`), {})
})

// — readBlock —
test('returns the balanced block, not the first closing brace', () => {
  const source = `{ a: { b: 1 }, c: 2 }`
  assert.equal(readBlock(source, 0), source)
})

test('ignores braces inside strings', () => {
  const source = `{ a: '}' , b: 1 }`
  assert.equal(readBlock(source, 0), source)
})

// — baseline —
test('is committed and non-empty — an empty baseline would pass everything', () => {
  return readFile(BASELINE_PATH, 'utf8').then((raw) => {
    const baseline = JSON.parse(raw)
    assert.ok((Object.keys(baseline).length) > 0)
})
})

// — the case that matters most: a violation actually fails —
test('a new wire shape in a baselined file is a violation', () => {
  const baseline = { 'packages/frontend/src/hooks/useContacts.ts': { Contact: 1 } }
  const grown = { 'packages/frontend/src/hooks/useContacts.ts': { Contact: 1, ContactPage: 1 } }
  assert.deepEqual(newViolations(baseline, baseline), [])
  const violations = newViolations(grown, baseline)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].key, 'ContactPage')
})

test('the same shape appearing in a NEW file is not grandfathered', () => {
  const baseline = { 'packages/frontend/src/hooks/useContacts.ts': { Contact: 1 } }
  const elsewhere = { 'packages/frontend/src/hooks/useOther.ts': { Contact: 1 } }
  assert.equal(newViolations(elsewhere, baseline).length, 1)
})

// — holes found in review (#1447), each now a regression test —
test('a stray } inside a comment does not end the block early', () => {
  // Before the fix this returned {} — the comment closed the block and
  // chain_id vanished, turning the gate off for that declaration.
  const source = `interface T {\n  // closes here } oops\n  chain_id: number\n}`
  assert.deepEqual(scanSource(source), { T: 1 })
})

test('a block comment containing braces does not end the block early', () => {
  const source = `interface U {\n  /* shape: { a } */\n  tx_hash: string\n}`
  assert.deepEqual(scanSource(source), { U: 1 })
})

test('a generic parameter does not hide a declaration', () => {
  assert.deepEqual(scanSource(`export type Paginated<T> = {\n  items: T[]\n  next_cursor: string\n}`), { Paginated: 1 })
  assert.deepEqual(scanSource(`export interface Box<T> extends Base<T> {\n  chain_id: number\n}`), { Box: 1 })
})

test('an indented declaration is still counted', () => {
  const source = `function useThing() {\n  interface Local {\n    chain_id: number\n  }\n}`
  assert.deepEqual(scanSource(source), { Local: 1 })
})

test('an exemption does NOT ride onto the adjacent declaration below it', () => {
  // The lookback used to span 3 lines, so a shape written directly under
  // someone else's marker got a free pass with no marker of its own.
  const source =
    `// ui-local: reason of at least twenty chars here\n` +
    `interface A { token_symbol: string }\n` +
    `interface B { token_symbol: string }`
  assert.deepEqual(scanSource(source), { B: 1 })
})

// — --update may tighten the baseline, never raise it —
test('--update refuses to raise the baseline', () => {
  const baseline = { 'packages/frontend/src/hooks/useContacts.ts': { Contact: 1 } }
  const grown = { 'packages/frontend/src/hooks/useContacts.ts': { Contact: 1, Extra: 1 } }
  assert.equal(updateRefusals(grown, baseline).length, 1)
})

test('--update allows a shrink, while a non-empty first write needs acceptance', () => {
  const baseline = { 'packages/frontend/src/hooks/useContacts.ts': { Contact: 1 } }
  assert.deepEqual(updateRefusals({}, baseline), [])
  // The first-write allowance is keyed on `firstRun`, NOT on the baseline being
  // empty (#2728). Those are different states: `{}` is what an absent file
  // reads as AND what this gate writes once its debt reaches zero, so keying on
  // emptiness switched the refusal off on the first successful cleanup. The
  // second assertion below is the one that used to say `[]`.
  assert.equal(updateRefusals({ 'a.ts': { Any: 9 } }, {}, { firstRun: true }).length, 1)
  assert.deepEqual(
    updateRefusals({ 'a.ts': { Any: 9 } }, {}, { firstRun: true, acceptNew: true }),
    [],
  )
  assert.deepEqual(updateRefusals({}, {}, { firstRun: true }), [])
  assert.equal(updateRefusals({ 'a.ts': { Any: 9 } }, {}).length, 1)
})

// --- The CLI path (#2721, epic #2720)
//
// The cases above test the detection. The refusals — growth past the baseline,
// and `--update` declining to RAISE it — live in `main()` and no exported
// function reaches them. That is the shape that survived mutation with a green
// suite elsewhere in this repo (#2690).

import { runGuard } from './test-support/guard-cli.mjs'

const HOOK = 'packages/frontend/src/hooks/useThing.ts'
const snake = (n) =>
  `export type T = {\n` + Array.from({ length: n }, (_, i) => `  api_key_${i}: string`).join('\n') + `\n}\n`

test('CLI: growth past the baseline exits non-zero and names the file', () => {
  const { status, out } = runGuard('lint-wire-types.mjs', {
    also: ['lib/ratchet.mjs'],
    files: { [HOOK]: snake(3), 'packages/frontend/wire-type-baseline.json': '{}' },
  })
  assert.equal(status, 1)
  assert.match(out, /hand-written wire shapes grew/)
  assert.match(out, /useThing\.ts/)
})

test('CLI: a tree with no hand-written shapes exits 0', () => {
  // The control. A refusal test alone passes against a guard that refuses
  // everything.
  const { status } = runGuard('lint-wire-types.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      'packages/frontend/src/hooks/useThing.ts': 'export type T = { camelCase: string }\n',
      'packages/frontend/wire-type-baseline.json': '{}',
    },
  })
  assert.equal(status, 0)
})

test('CLI: `--update` REFUSES to raise a baselined file\'s count', () => {
  const { status, out } = runGuard('lint-wire-types.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: {
      [HOOK]: snake(3),
      'packages/frontend/wire-type-baseline.json': JSON.stringify({ [HOOK]: { PrepareResponse: 1 } }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
})

test('CLI: `--update` refuses a brand-new file when the baseline is not empty', () => {
  // Corrected on review. An earlier version of this case asserted the OPPOSITE
  // and called it a hole, on a fixture with an EMPTY baseline. An existing
  // `{}` is not a first run and refuses debt; only a missing baseline paired
  // with an empty scan is frictionless, as pinned above. With any real baseline
  // a new file compares against 0, so its first occurrence IS growth and IS refused.
  // Measured both ways before rewriting this.
  const { status, out } = runGuard('lint-wire-types.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: {
      [HOOK]: snake(1),
      'packages/frontend/wire-type-baseline.json': JSON.stringify({
        'packages/frontend/src/hooks/other.ts': { PrepareResponse: 1 },
      }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
})

test('CLI: a MISSING baseline refuses debt unless --accept-new is explicit', () => {
  const base = 'packages/frontend/wire-type-baseline.json'
  const shared = { also: ['lib/ratchet.mjs'], files: { [HOOK]: snake(2) }, readBack: [base] }
  const refused = runGuard('lint-wire-types.mjs', { ...shared, args: ['--update'] })
  assert.equal(refused.status, 1)
  assert.match(refused.out, /--update --accept-new/)
  assert.equal(refused.wrote[base], null)

  const accepted = runGuard('lint-wire-types.mjs', { ...shared, args: ['--update', '--accept-new'] })
  assert.equal(accepted.status, 0)
  assert.match(accepted.wrote[base], /"T": 1/)
})

test('CLI: a MISSING baseline still writes an empty first scan without --accept-new', () => {
  const base = 'packages/frontend/wire-type-baseline.json'
  const { status, wrote } = runGuard('lint-wire-types.mjs', {
    also: ['lib/ratchet.mjs'], files: { [HOOK]: 'export type T = { camelCase: string }\n' },
    args: ['--update'], readBack: [base],
  })
  assert.equal(status, 0)
  assert.deepEqual(JSON.parse(wrote[base]), {})
})

test('CLI: a malformed baseline prints one line, not a node:internal banner', () => {
  // #2761 — the last of the six. This gate's entrypoint was a bare `await
  // main()`, so an operator with a hand-edited baseline got Node's
  // uncaught-exception banner wrapped around the one line that mattered.
  const { status, out } = runGuard('lint-wire-types.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [HOOK]: snake(1),
      'packages/frontend/wire-type-baseline.json': JSON.stringify({ [HOOK]: { T: 'x' } }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /✗ lint-wire-types: /)
  assert.match(out, /\[T\] is "x", not a number/)
  assert.doesNotMatch(out, /node:internal/)
})
