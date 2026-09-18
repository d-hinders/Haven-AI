// Tests for the MCP↔CLI vocabulary guard (#3131).
//
// Every case drives the real exported functions over fixture SOURCE, not over
// the repository: a test that asserts against today's two surfaces would go red
// on any legitimate field addition and teach people to update the test rather
// than the map. What is pinned here is the guard's BEHAVIOUR.
//
// The scanner cases are written the way `lint-wire-types.test.mjs` learned to
// write them: start from the input that would defeat the scanner.
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  audit,
  declaredFields,
  DISPOSITIONS,
  OPEN_DISPOSITIONS,
  openCounts,
  validateMap,
  readBlock,
  scanReceiptSurface,
  scanTransactionSurface,
} from './vocabulary-divergence.mjs'

const RECEIPT_SRC = `
export function mapPaymentReceipt(raw: RawHavenPaymentReceipt): HavenPaymentReceipt {
  const receipt: HavenPaymentReceipt = {
    id: raw.id,
    proofStatus: raw.proof_status,
    parties: mapParties(raw.parties),
    amount: raw.amount_human,
  }

  if ('payment_intent_id' in raw) {
    receipt.paymentIntentId = raw.payment_intent_id ?? null
  }

  return receipt
}
`

const TRANSACTION_SRC = `
const transactionBaseProperties = {
  hash: { type: 'string' },
  paymentProofStatus: { type: ['string', 'null'] },
  paymentFlowStatus: {
    type: ['string', 'null'],
    enum: ['paid', null],
  },
  valueFormatted: { type: 'string' },
} as const
`

function mapFixture(overrides = {}) {
  return {
    concepts: [
      {
        concept: 'proof state',
        receipt: { field: 'proofStatus', column: 'proof_status', value: 'recorded' },
        transaction: { field: 'paymentProofStatus', column: 'payment_proof_status', value: 'defaulted' },
        disposition: 'blocked-on-fallback',
        blockedBy: 3132,
        reason: 'one column, two values — the fallback case',
      },
      {
        concept: 'display amount',
        receipt: { field: 'amount', column: 'amount_human', value: 'recorded' },
        transaction: { field: 'valueFormatted', column: 'amount_human', value: 'recorded' },
        disposition: 'permanently-divergent',
        reason: 'different concepts that hold equal values by copy',
      },
    ],
    singleSurface: {
      receipt: {
        id: 'the evidence row identifier, no transfer counterpart',
        parties: 'structured party block (#2960), no transfer counterpart',
        paymentIntentId: 'conditional key linking evidence to intent',
      },
      transaction: {
        hash: 'the hash of any history row, not only payments',
        paymentFlowStatus: 'derived lifecycle state, receipts expose the inputs',
      },
    },
    ...overrides,
  }
}

test('receipt scanner reads all three emit shapes', () => {
  const fields = scanReceiptSurface(RECEIPT_SRC)
  // The flat list, a mapped sub-shape, and the conditional tail. A scanner that
  // only matched `camelKey: raw.snake_key` would miss `parties` (wrapped in a
  // call) and `paymentIntentId` (assigned after the literal) — both real.
  assert.equal(fields.id, 'id')
  assert.equal(fields.proofStatus, 'proof_status')
  assert.equal(fields.parties, 'parties')
  assert.equal(fields.amount, 'amount_human')
  assert.equal(fields.paymentIntentId, 'payment_intent_id')
  assert.equal(Object.keys(fields).length, 5)
})

test('transaction scanner reads top-level keys only, not nested ones', () => {
  const fields = scanTransactionSurface(TRANSACTION_SRC)
  // `enum:` and `type:` are nested inside paymentFlowStatus at four spaces.
  // Counting them would invent fields that do not exist on the surface.
  assert.deepEqual(Object.keys(fields).sort(), [
    'hash',
    'paymentFlowStatus',
    'paymentProofStatus',
    'valueFormatted',
  ])
})

test('readBlock returns null when the named block is absent', () => {
  // The truncation case the plausibility floor backstops: a renamed or moved
  // block reads as an empty surface rather than throwing.
  assert.equal(readBlock(TRANSACTION_SRC, 'const somethingElse = {'), null)
  assert.deepEqual(scanTransactionSurface('const other = {\n  a: 1,\n}\n'), {})
})

test('a fully declared pair of surfaces audits clean', () => {
  const { undeclared, stale } = audit({
    receipt: scanReceiptSurface(RECEIPT_SRC),
    transaction: scanTransactionSurface(TRANSACTION_SRC),
    map: mapFixture(),
  })
  assert.deepEqual(undeclared, [])
  assert.deepEqual(stale, [])
})

test('a new undeclared field on either surface is reported, with its surface', () => {
  const receipt = { ...scanReceiptSurface(RECEIPT_SRC), settlementScheme: 'settlement_scheme' }
  const { undeclared } = audit({
    receipt,
    transaction: scanTransactionSurface(TRANSACTION_SRC),
    map: mapFixture(),
  })
  assert.deepEqual(undeclared, [{ surface: 'receipt', field: 'settlementScheme' }])
})

test('a map entry whose field left its surface is reported as stale', () => {
  // #3134 converges a pair and forgets to remove its row: the map keeps
  // describing a divergence that no longer exists.
  const transaction = scanTransactionSurface(TRANSACTION_SRC)
  delete transaction.valueFormatted
  const { stale } = audit({ receipt: scanReceiptSurface(RECEIPT_SRC), transaction, map: mapFixture() })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].field, 'valueFormatted')
  assert.equal(stale[0].concept, 'display amount')
  assert.equal(stale[0].how, 'concept')
})

test('declaredFields records how each field was accounted for', () => {
  const declared = declaredFields(mapFixture())
  assert.equal(declared.receipt.get('proofStatus').how, 'concept')
  assert.equal(declared.receipt.get('proofStatus').disposition, 'blocked-on-fallback')
  assert.equal(declared.receipt.get('id').how, 'single-surface')
})

test('only unresolved dispositions count toward the shrink-only number', () => {
  // `permanently-divergent` and `converged` are DECISIONS. Counting them would
  // make the ratchet impossible to ever satisfy, since three pairs must never
  // converge (#3130).
  assert.deepEqual(openCounts(mapFixture()), {
    'scripts/ci/vocabulary-map.json': { open: 1 },
  })

  const allDecided = mapFixture()
  allDecided.concepts[0].disposition = 'converged'
  assert.deepEqual(openCounts(allDecided), {})

  const undecided = mapFixture()
  undecided.concepts[1].disposition = 'undecided'
  assert.equal(openCounts(undecided)['scripts/ci/vocabulary-map.json'].open, 2)

  // `converge-pending` is OPEN. It was spelled `converge` once, one letter from
  // `converged`, and the two pairs carrying it were silently counted as done —
  // the gauge said 2 while four pairs still differed by name.
  const pending = mapFixture()
  pending.concepts[1].disposition = 'converge-pending'
  assert.equal(openCounts(pending)['scripts/ci/vocabulary-map.json'].open, 2)
})

test('validateMap rejects an unknown disposition rather than treating it as resolved', () => {
  // The set is CLOSED. With an allowlist of open states, any other string —
  // a typo, a novel word — silently discharged the debt.
  for (const bad of ['converge', 'todo', 'blocked_on_fallback', 'permanently-divergant', '']) {
    const m = mapFixture()
    m.concepts[0].disposition = bad
    const problems = validateMap(m)
    assert.ok(
      problems.some((x) => /unknown disposition/.test(x)),
      `${JSON.stringify(bad)} should be rejected: ${problems.join('; ')}`,
    )
  }
  assert.deepEqual(validateMap(mapFixture()), [])
})

test('validateMap requires a written reason on every entry (AC3)', () => {
  const noReason = mapFixture()
  delete noReason.concepts[0].reason
  assert.ok(validateMap(noReason).some((x) => /needs a written reason/.test(x)))

  const stub = mapFixture()
  stub.concepts[0].reason = 'tbd'
  assert.ok(validateMap(stub).some((x) => /needs a written reason/.test(x)))

  const shortSingle = mapFixture()
  shortSingle.singleSurface.receipt.id = 'x'
  assert.ok(validateMap(shortSingle).some((x) => /singleSurface\.receipt\.id/.test(x)))
})

test('validateMap requires the recorded/defaulted flag on both sides (AC4)', () => {
  // The flag is how the map expresses "same column, different value" — the
  // whole of the proofStatus and settled-at defects. Nothing checked it.
  const noFlag = mapFixture()
  delete noFlag.concepts[0].transaction.value
  assert.ok(validateMap(noFlag).some((x) => /must be "recorded" or "defaulted"/.test(x)))

  const wrongFlag = mapFixture()
  wrongFlag.concepts[0].receipt.value = 'sometimes'
  assert.ok(validateMap(wrongFlag).some((x) => /must be "recorded" or "defaulted"/.test(x)))

  const noColumn = mapFixture()
  delete noColumn.concepts[1].receipt.column
  assert.ok(validateMap(noColumn).some((x) => /missing receipt.column/.test(x)))
})

test('validateMap catches a field declared twice', () => {
  // Last-wins would otherwise hide one declaration silently.
  const dup = mapFixture()
  dup.singleSurface.receipt.proofStatus = 'a duplicate of the concept entry above'
  assert.ok(validateMap(dup).some((x) => /declared more than once|also declared as part of a concept pair/.test(x)))
})

test('the receipt scanner is shape-agnostic — a value that never mentions raw is still a field', () => {
  // The earlier regex required `raw.x` or `fn(raw.x)`. The sibling mapper in
  // the same file already emits `explorerUrl: buildExplorerUrl(...)`, so that
  // shape is real — and a field the guard cannot see is one nobody must declare.
  const src = `
export function mapPaymentReceipt(raw: RawHavenPaymentReceipt): HavenPaymentReceipt {
  const receipt: HavenPaymentReceipt = {
    explorerUrl: buildExplorerUrl(chain, hash),
    proofStatus: raw.proof_status,
  }
  return receipt
}
`
  const fields = scanReceiptSurface(src)
  assert.deepEqual(Object.keys(fields).sort(), ['explorerUrl', 'proofStatus'])
  assert.equal(fields.explorerUrl, null, 'no column to attribute')
  assert.equal(fields.proofStatus, 'proof_status')
})

test('the shipped map accounts for both shipped surfaces', () => {
  // The one case that DOES read the repository — not to pin today's field list,
  // but to assert the map and the surfaces agree at this commit. This is the
  // assertion that goes red when someone adds a field and forgets the map, so
  // it must read real files rather than a fixture.
  const map = JSON.parse(readFileSync('scripts/ci/vocabulary-map.json', 'utf8'))
  const result = audit({
    receipt: scanReceiptSurface(readFileSync(map.surfaces.receipt.file, 'utf8')),
    transaction: scanTransactionSurface(readFileSync(map.surfaces.transaction.file, 'utf8')),
    map,
  })
  assert.deepEqual(result.undeclared, [])
  assert.deepEqual(result.stale, [])
})

test('DISPOSITIONS is the single source: every one is classified, and the open set derives from it', () => {
  // The open/closed bit used to live in a second Set. Two structures is how the
  // "a typed word discharges the debt" hole reopens one level up: add a word to
  // one and not the other and the gauge drops without a decision.
  for (const [name, meta] of Object.entries(DISPOSITIONS)) {
    assert.equal(typeof meta.open, 'boolean', `${name} must say whether it owes work`)
    assert.ok(meta.why && meta.why.length > 10, `${name} must say why`)
    assert.equal(OPEN_DISPOSITIONS.has(name), meta.open)
  }
  for (const name of OPEN_DISPOSITIONS) assert.ok(name in DISPOSITIONS)

  // The FULL key set is pinned, not just the open half. Asserting only the open
  // names leaves the live escape: add a CLOSED word (`deferred`), flip the two
  // `converge-pending` entries to it, and the gauge drops 5 → 3 with every test
  // still green — measured, before this assertion existed. Adding a disposition
  // must be a deliberate edit here, reviewed as such, because a new
  // resolved-looking word is how the debt gets discharged without a decision.
  assert.deepEqual(Object.keys(DISPOSITIONS).sort(), [
    'blocked-on-fallback',
    'converge-pending',
    'converged',
    'permanently-divergent',
    'undecided',
  ])
  assert.deepEqual(
    [...OPEN_DISPOSITIONS].sort(),
    ['blocked-on-fallback', 'converge-pending', 'undecided'],
  )
})

test('validateMap requires blockedBy on a blocked-on-fallback entry', () => {
  // "cannot converge until the value defect is fixed" is unanchored without the
  // issue that owns the fix.
  const m = mapFixture()
  delete m.concepts[0].blockedBy
  assert.ok(validateMap(m).some((x) => /blocked-on-fallback needs a numeric blockedBy/.test(x)))

  const empty = mapFixture()
  empty.concepts[1].receipt.column = '   '
  assert.ok(validateMap(empty).some((x) => /missing receipt.column/.test(x)))
})
