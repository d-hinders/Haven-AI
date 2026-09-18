#!/usr/bin/env node
// The MCP↔CLI vocabulary guard (#3131, epic #3130).
//
// A settled x402 payment is reported by two surfaces that agree on almost
// nothing. This guard does not fix that — #3132/#3133/#3134 do. It freezes the
// problem at today's size, so that the later breaking slices are provable
// rather than hopeful, and so a NEW field cannot join either surface without
// someone deciding what its counterpart is.
//
// Precedent: #2907 pinned a census and an exact pattern before #2914
// contracted anything, and the census caught a reintroduced wire field
// (`safe_address` back in TRANSACTION_CSV_COLUMNS) that prose review passed.
//
// THE RULE. Every field on either surface must be accounted for in
// `vocabulary-map.json`, as exactly one of:
//   - one side of a `concepts[]` entry (a pair, with a disposition and reason);
//   - an entry in `singleSurface[<surface>]` (no counterpart, with the reason).
// Anything else is an undeclared divergence and fails the run.
//
// It fails the other way too: a map entry naming a field that no longer exists
// on its surface is stale, and a stale map is how a converged pair keeps
// looking like an open one.
//
// WHY A LINE SCANNER. Neither input is worth a TypeScript compiler here:
// `mapPaymentReceipt` is a flat `camelKey: raw.snake_key` list and
// `transactionBaseProperties` is a flat object literal. `scripts/lint-wire-types.mjs`
// set the precedent for reading TS source this way — and its own header
// documents four holes review closed in it, so this scanner inherits that
// fragility and says so:
//   - it reads ONE named block per file and stops at the first line that closes
//     it at column 0, so a stray brace inside a comment inside the block would
//     truncate the scan. The `assertPlausible` floor below is the backstop: a
//     truncated scan reports too few fields and the run fails rather than
//     passing on a short list.
//   - it cannot see a field spread in from elsewhere (`...someProps`), nor a
//     key nested inside another object literal. Neither surface does either
//     today; `assertPlausible` would not catch it if one started, because
//     neither removes anything. Review is the backstop.
//   - the transaction scan matches a bare identifier key, so a quoted or
//     hyphenated one (`'x-foo': {…}`) is invisible. An OpenAPI properties block
//     has no reason to carry one, but nothing here enforces that.
//   - the receipt scan matches ANY key at four spaces inside the function, so a
//     sibling object literal declared there would contribute phantom fields.
//     That one fails CLOSED — a phantom is undeclared, so the run goes red and
//     someone looks — which is why it is a noise risk rather than a blind spot.
//   - `transactionBaseProperties` is spread into TWO closed schemas to keep
//     `expectMatchesSpec` truthful. This scanner reads the base object, which
//     is the shared shape both schemas carry — deliberately, since that is the
//     surface the two vocabularies actually diverge on.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  hasShrunk,
  loadBaseline,
  newViolations,
  runGate,
  updateRefusals,
  writeBaseline,
} from '../lib/ratchet.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAP_PATH = resolve(REPO_ROOT, 'scripts/ci/vocabulary-map.json')
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts/ci/vocabulary-divergence-baseline.json')

/**
 * The lowest field count each surface can plausibly have. A scan that reads
 * fewer has been truncated by a brace it should not have stopped at — the
 * exact failure `lint-wire-types.mjs`'s header records as a closed hole. The
 * floor turns that into a red run instead of a short, quietly-passing list.
 *
 * Deliberately well below today's counts (30 and 29): this catches truncation,
 * it is not a second ratchet, and a floor that tracks the real number would
 * fail every legitimate removal.
 */
const PLAUSIBLE_FLOOR = { receipt: 20, transaction: 20 }

/** Read a named block's body: from `<needle>` to the first line closing it at column 0. */
export function readBlock(source, needle) {
  const start = source.indexOf(needle)
  if (start === -1) return null
  const rest = source.slice(start)
  const end = rest.search(/\n\}/)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Fields `mapPaymentReceipt` puts on a receipt.
 *
 * Three emit shapes, all of which carry the concept→column edge that
 * `sdk/src/types.ts` (camel names, no column link) does not:
 *   `camelKey: raw.snake_key,`           the flat list
 *   `camelKey: mapParties(raw.parties),` a mapped sub-shape
 *   `receipt.camelKey = raw.snake_key`   the conditional tail
 */
export function scanReceiptSurface(source) {
  const body = readBlock(source, 'export function mapPaymentReceipt')
  if (body === null) return {}
  const fields = {}
  // Shape-AGNOSTIC on purpose. An earlier version required the value to be
  // `raw.x` or `fn(raw.x)`, which made any other shape invisible — and the
  // sibling mapper in the same file already emits one
  // (`explorerUrl: buildExplorerUrl(...)`). A field the guard cannot see is a
  // field nobody has to declare, which is the one failure this guard exists to
  // prevent, so the key is what counts and the column is best-effort.
  for (const m of body.matchAll(/^ {4}(\w+):\s*(.*)$/gm)) {
    fields[m[1]] = /raw\.(\w+)/.exec(m[2])?.[1] ?? null
  }
  for (const m of body.matchAll(/^\s*receipt\.(\w+) = (.*)$/gm)) {
    fields[m[1]] = /raw\.(\w+)/.exec(m[2])?.[1] ?? null
  }
  return fields
}

/** Top-level keys of `transactionBaseProperties` (two-space indent, the object's own level). */
export function scanTransactionSurface(source) {
  const body = readBlock(source, 'const transactionBaseProperties = {')
  if (body === null) return {}
  const fields = {}
  for (const m of body.matchAll(/^ {2}(\w+):/gm)) fields[m[1]] = true
  return fields
}

/** Every field the map accounts for, per surface, and how. */
export function declaredFields(map) {
  const declared = { receipt: new Map(), transaction: new Map() }
  for (const entry of map.concepts) {
    for (const surface of ['receipt', 'transaction']) {
      declared[surface].set(entry[surface].field, {
        how: 'concept',
        concept: entry.concept,
        disposition: entry.disposition,
      })
    }
  }
  for (const surface of ['receipt', 'transaction']) {
    for (const field of Object.keys(map.singleSurface[surface])) {
      declared[surface].set(field, { how: 'single-surface' })
    }
  }
  return declared
}

/**
 * Compare the two surfaces against the map.
 *
 * `undeclared` — a field on a surface with no entry: the guard's whole point.
 * `stale`      — an entry naming a field that is no longer on its surface:
 *                the other direction, and the one that matters after #3134
 *                converges a pair and someone forgets to remove its row.
 */
export function audit({ receipt, transaction, map }) {
  const declared = declaredFields(map)
  const undeclared = []
  const stale = []
  const live = { receipt, transaction }

  for (const surface of ['receipt', 'transaction']) {
    for (const field of Object.keys(live[surface])) {
      if (!declared[surface].has(field)) undeclared.push({ surface, field })
    }
    for (const [field, meta] of declared[surface]) {
      if (!(field in live[surface])) stale.push({ surface, field, ...meta })
    }
  }
  return { undeclared, stale }
}

/**
 * The CLOSED set of dispositions: for each, whether it still owes work and why.
 *
 * Closed, not an allowlist of open states. With an open-state allowlist any
 * OTHER string counted as resolved, so a typo (`blocked_on_fallback`) or a
 * novel word silently discharged the debt — "a decision was recorded" degrades
 * to "a word was typed", which is the failure this guard argues against.
 *
 * `open` lives HERE rather than in a second `Set`, because two structures is
 * how the same hole reopens one level up: add a word to one and not the other
 * and the gauge drops without anyone deciding anything. `OPEN_DISPOSITIONS` is
 * derived, and the test asserts every disposition is classified.
 *
 * `converge-pending` is deliberately not spelled `converged`. They are one
 * letter apart and opposite: `converged` means the two surfaces already share
 * a name, `converge-pending` means #3134 still has to make them. Counting the
 * second as done printed "2 still open" while four pairs differed.
 */
export const DISPOSITIONS = {
  'converged': { open: false, why: 'already one name on both surfaces' },
  'permanently-divergent': { open: false, why: 'different concepts; must never converge' },
  'converge-pending': { open: true, why: 'same concept, two names — #3134 still owes the rename' },
  'blocked-on-fallback': { open: true, why: 'cannot converge until the value defect is fixed' },
  'undecided': { open: true, why: 'nobody has decided yet' },
}

export const OPEN_DISPOSITIONS = new Set(
  Object.entries(DISPOSITIONS)
    .filter(([, d]) => d.open)
    .map(([name]) => name),
)

/**
 * Structural validation of the map itself (#3131 AC3/AC4).
 *
 * Without this the guard read only `disposition` and `field`: an entry with no
 * `reason`, or with no `recorded`/`defaulted` flag, passed silently. Both are
 * acceptance criteria, and a criterion nothing checks is satisfied only by the
 * author having been careful once.
 */
export function validateMap(map) {
  const problems = []
  const seen = { receipt: new Set(), transaction: new Set() }

  for (const entry of map.concepts) {
    const where = `concept "${entry.concept}"`
    if (!(entry.disposition in DISPOSITIONS)) {
      problems.push(
        `${where}: unknown disposition "${entry.disposition}" — one of: ` +
          Object.keys(DISPOSITIONS).join(', '),
      )
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      problems.push(`${where}: needs a written reason of at least 20 characters`)
    }
    // `blocked-on-fallback` means "cannot converge until the value defect is
    // fixed" — a claim that is unanchored without the issue that owns the fix.
    if (entry.disposition === 'blocked-on-fallback' && !Number.isInteger(entry.blockedBy)) {
      problems.push(`${where}: blocked-on-fallback needs a numeric blockedBy issue`)
    }
    for (const surface of ['receipt', 'transaction']) {
      const side = entry[surface]
      if (!side || typeof side.field !== 'string') {
        problems.push(`${where}: missing ${surface}.field`)
        continue
      }
      if (side.value !== 'recorded' && side.value !== 'defaulted') {
        problems.push(
          `${where}: ${surface}.value must be "recorded" or "defaulted" (AC4), got ${JSON.stringify(side.value)}`,
        )
      }
      if (typeof side.column !== 'string' || side.column.trim() === '') {
        problems.push(`${where}: missing ${surface}.column`)
      }
      if (seen[surface].has(side.field)) {
        problems.push(`${where}: ${surface}.field "${side.field}" is declared more than once`)
      }
      seen[surface].add(side.field)
    }
  }

  for (const surface of ['receipt', 'transaction']) {
    for (const [field, reason] of Object.entries(map.singleSurface[surface])) {
      if (typeof reason !== 'string' || reason.trim().length < 20) {
        problems.push(`singleSurface.${surface}.${field}: needs a written reason`)
      }
      if (seen[surface].has(field)) {
        problems.push(`singleSurface.${surface}.${field}: also declared as part of a concept pair`)
      }
      seen[surface].add(field)
    }
  }

  return problems
}

/**
 * The shrink-only number: pairs whose divergence is recorded but NOT yet
 * resolved. "Different on purpose" (`permanently-divergent`) and "already one
 * name" (`converged`) are decisions and do not count; `blocked-on-fallback`
 * and anything explicitly `undecided` do, so #3132/#3134 burn them down and
 * nobody can add a new one.
 *
 * Counted globally rather than per-file: both surfaces contribute to one
 * concept list, so a per-file split would just be this number written twice.
 */
export function openCounts(map) {
  const open = map.concepts.filter((c) => OPEN_DISPOSITIONS.has(c.disposition))
  return open.length === 0 ? {} : { 'scripts/ci/vocabulary-map.json': { open: open.length } }
}

const REMEDY =
  'Add the field to scripts/ci/vocabulary-map.json — either as one side of a\n' +
  'concepts[] pair with a disposition and a written reason, or under\n' +
  'singleSurface.<surface> with the reason it will never have a counterpart.\n' +
  '"Different on purpose" is a legitimate entry; "nobody decided" is not.'

function readSurfaces() {
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'))
  const receipt = scanReceiptSurface(
    readFileSync(resolve(REPO_ROOT, map.surfaces.receipt.file), 'utf8'),
  )
  const transaction = scanTransactionSurface(
    readFileSync(resolve(REPO_ROOT, map.surfaces.transaction.file), 'utf8'),
  )
  return { map, receipt, transaction }
}

/** Fail loudly on a truncated scan rather than passing on a short list. */
function assertPlausible(receipt, transaction) {
  const sizes = { receipt: Object.keys(receipt).length, transaction: Object.keys(transaction).length }
  for (const [surface, floor] of Object.entries(PLAUSIBLE_FLOOR)) {
    if (sizes[surface] < floor) {
      console.error(
        `\n✗ the ${surface} scan found only ${sizes[surface]} field(s), below the ` +
          `plausibility floor of ${floor}.\n` +
          '  The scanner reads one named block and stops at the first line closing it at\n' +
          '  column 0, so this usually means the block moved, was renamed, or a brace\n' +
          '  inside it ended the read early. Fix the scanner, not the floor.',
      )
      process.exit(1)
    }
  }
  return sizes
}

async function main() {
  const { map, receipt, transaction } = readSurfaces()
  const malformed = validateMap(map)
  if (malformed.length > 0) {
    console.error('\n✗ the vocabulary map is malformed:\n')
    for (const m of malformed) console.error(`  ${m}`)
    process.exit(1)
  }
  const sizes = assertPlausible(receipt, transaction)
  const { undeclared, stale } = audit({ receipt, transaction, map })
  const counts = openCounts(map)
  const openTotal = Object.values(counts)[0]?.open ?? 0

  console.log(
    `vocabulary gauge: ${sizes.receipt} receipt field(s), ${sizes.transaction} transaction ` +
      `field(s), ${map.concepts.length} declared concept(s), ${openTotal} still open.`,
  )

  if (process.argv.includes('--update')) {
    const { baseline, firstRun } = loadBaseline(BASELINE_PATH)
    const acceptNew = process.argv.includes(ACCEPT_NEW_BASELINE_FLAG)
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  let failed = false

  if (undeclared.length > 0) {
    failed = true
    console.error('\n✗ field(s) on a surface with no entry in the vocabulary map:\n')
    for (const u of undeclared) console.error(`  [${u.surface}] ${u.field}`)
    console.error(`\n${REMEDY}`)
  }

  if (stale.length > 0) {
    failed = true
    console.error('\n✗ vocabulary-map entries naming a field that is no longer on its surface:\n')
    for (const s of stale) {
      const which = s.how === 'concept' ? `concept "${s.concept}"` : `singleSurface.${s.surface}`
      console.error(`  [${s.surface}] ${s.field} — declared by ${which}`)
    }
    console.error(
      '\nThe field moved, was renamed, or the pair converged. Update the map so it\n' +
        'describes what ships: a converged pair leaves the list and cannot come back\n' +
        'silently, which is the whole point of the ratchet.',
    )
  }

  const { baseline } = loadBaseline(BASELINE_PATH)
  const grew = newViolations(counts, baseline)
  if (grew.length > 0) {
    failed = true
    console.error('\n✗ undecided divergences grew (shrink-only, #3131):\n')
    for (const v of grew) console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    console.error(
      '\nA new pair may be declared, but not left open. Resolve it, or record why it is\n' +
        'blocked and on what — an open entry is a debt #3134 has to burn down.',
    )
  }

  if (failed) process.exit(1)

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (open divergences are below the baseline — lock it in: node scripts/ci/vocabulary-divergence.mjs --update)',
    )
  }
  console.log('✓ every field on both surfaces is accounted for, and nothing undecided grew.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGate('vocabulary-divergence', main)
}
