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
  auditCliEnvelopes,
  declaredKeys,
  plausibilityProblems,
  scanCsvHeaders,
  auditCsvHeaders,
  declaredFields,
  DISPOSITIONS,
  OPEN_DISPOSITIONS,
  openCounts,
  validateMap,
  readBlock,
  scanCliEnvelopes,
  stripCommentsAndStrings,
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
    cliConventions: {
      passthrough: {
        'wallets list': { convention: 'snake', keys: 'account_address', reason: 'forwarded from the backend unchanged' },
      },
      envelopes: {
        cmdLogout: { convention: 'snake', keys: 'ok, signed_out', reason: 'pure snake, no camel key at all' },
        cmdAgentRevoke: { convention: 'snake', keys: 'ok, agent_id, status', reason: 'hybrid: bare ok beside a snake id' },
        cmdWrapped: { convention: 'mixed', keys: 'ok, wrapped_key, camelKey', reason: 'a literal wrapped over several lines' },
      },
      onDisk: {},
    },
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

test('a commented-out field on either surface is not reported as live', () => {
  // Commenting a field out rather than deleting it kept it looking live, so the
  // `stale` direction went SILENT — and `stale` is the direction that fires
  // when a pair converges and someone forgets to remove its row. Both
  // surface scanners read a stripped copy now; they were the two the stripper
  // never reached.
  //
  // Both scanners key on INDENTATION (`^ {4}` / `^ {2}`), so the comment
  // markers have to sit on their own lines or the commented field no longer
  // starts at the matched column and the fixture proves nothing — which is how
  // the first version of this test passed against the unstripped code.
  const receipt = `
export function mapPaymentReceipt(raw) {
  return {
    txHash: raw.tx_hash,
    /*
    proofStatus: raw.proof_status,
    */
    amountRaw: raw.amount_raw,
  }
}
`
  assert.deepEqual(Object.keys(scanReceiptSurface(receipt)).sort(), ['amountRaw', 'txHash'])

  const transaction = `
const transactionBaseProperties = {
  hash: { type: 'string' },
  /*
  removedField: { type: 'string' },
  */
} as const
`
  assert.deepEqual(Object.keys(scanTransactionSurface(transaction)), ['hash'])
})

test('a brace inside a comment no longer truncates a surface block', () => {
  // The hole list claimed this one until the stripping reached these two
  // scanners: a `}` at column 0 inside a comment ended the read early, so every
  // field after it was invisible — and an invisible field is one nobody has to
  // declare, the single failure this guard exists to prevent. Only a CODE brace
  // at column 0 can still do it.
  const src = `
const transactionBaseProperties = {
  hash: { type: 'string' },
  /* a stray brace at column 0:
}
  */
  valueFormatted: { type: 'string' },
} as const
`
  assert.deepEqual(Object.keys(scanTransactionSurface(src)), ['hash', 'valueFormatted'])
})

test('a control-flow keyword is not an owner', () => {
  // `if (…) {` matches the same shape a function declaration does, so without
  // the NOT_A_FUNCTION filter an envelope emitted inside a conditional is
  // attributed to `if` — a name no map entry can ever match, and one that moves
  // the real command's keys off it. Pinned here rather than only by the
  // repo-reading census, which holds it just while commands.ts happens to emit
  // inside a block.
  //
  // The owner pattern is anchored to a LINE START with up to four spaces of
  // indent, so the `if` has to open its own line for this to bite — written on
  // one line the fixture proves nothing.
  const src = `
function cmdReal(d, args) {
  if (args.flags.json) {
    emit(d, args.flags.json, { ok: true, real_key: 1 }, () => 'x')
  }
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdReal: ['ok', 'real_key'] })
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
  // a pair converges and someone forgets to remove its row: the map keeps
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

const CLI_SRC = `
function cmdLogout(d: Deps, args: Args) {
  emit(d, args.flags.json, { ok: true, signed_out: true }, () => 'Signed out.')
}

async function cmdAgentRevoke(d: Deps, args: Args) {
  emit(
    d,
    args.flags.json,
    { ok: true, agent_id: id, status: 'revoked' },
    () => 'revoked',
  )
}

const cmdWrapped = async (d: Deps, args: Args) => {
  d.o.data(
    {
      ok: true,
      wrapped_key: one,
      camelKey: two,
    },
    () => 'wrapped',
  )
}

function cmdWalletsList(d: Deps, args: Args) {
  emit(d, args.flags.json, accounts, () => 'list')
}
`

test('the CLI scanner finds self-constructed envelopes, keyed on the enclosing function', () => {
  const found = scanCliEnvelopes(CLI_SRC)
  // cmdWalletsList forwards a backend array — no `{ ok: true`, so no casing
  // choice of its own, so nothing for the ratchet to hold.
  assert.deepEqual(Object.keys(found).sort(), ['cmdAgentRevoke', 'cmdLogout', 'cmdWrapped'])
  assert.deepEqual(found.cmdLogout, ['ok', 'signed_out'])
  // The case the first version could not see at all: the literal is wrapped, so
  // `{` and `ok: true` are never on one line. `deviceLogin`'s device-start
  // envelope is written exactly this way and was invisible.
  assert.deepEqual(found.cmdWrapped, ['ok', 'wrapped_key', 'camelKey'])
  // An arrow const is a function for this purpose: writing the next command in
  // that style must not turn the ratchet off.
  assert.ok('cmdWrapped' in found)
})

test('the CLI scanner survives an edit above the emit — it anchors on the function, not a line', () => {
  // #3133's own line anchors were wrong three times across two correction
  // passes. A guard keyed on them goes red on an unrelated edit above, which
  // trains people to update the anchor rather than read it.
  const shifted = '// a new comment\n'.repeat(40) + CLI_SRC
  assert.deepEqual(scanCliEnvelopes(shifted), scanCliEnvelopes(CLI_SRC))
})

test('a new undeclared envelope is reported, and a declared one that stopped emitting is too', () => {
  const map = mapFixture()
  assert.deepEqual(auditCliEnvelopes(scanCliEnvelopes(CLI_SRC), map), {
    undeclared: [],
    stale: [],
    keyDrift: [],
  })

  const added = { ...scanCliEnvelopes(CLI_SRC), cmdBrandNew: ['ok', 'new_thing'] }
  assert.deepEqual(auditCliEnvelopes(added, map).undeclared, ['cmdBrandNew'])

  const removed = { cmdLogout: ['ok', 'signed_out'] }
  assert.deepEqual(auditCliEnvelopes(removed, map).stale.sort(), ['cmdAgentRevoke', 'cmdWrapped'])
})

test('a key added to an ALREADY-declared envelope is reported', () => {
  // The audit compared function NAMES only, so this passed green while the
  // entry's `reason` went on describing a shape that no longer ships — and
  // `keys`, which validateMap demands "so the reason can be checked", was never
  // compared to anything.
  const map = mapFixture()
  const drifted = { ...scanCliEnvelopes(CLI_SRC), cmdLogout: ['ok', 'signed_out', 'apiBaseUrl'] }
  assert.deepEqual(auditCliEnvelopes(drifted, map).keyDrift, [
    { fn: 'cmdLogout', added: ['apiBaseUrl'], gone: [] },
  ])

  const shrunk = { ...scanCliEnvelopes(CLI_SRC), cmdLogout: ['ok'] }
  assert.deepEqual(auditCliEnvelopes(shrunk, map).keyDrift, [
    { fn: 'cmdLogout', added: [], gone: ['signed_out'] },
  ])
})

test('declaredKeys reads a prose keys string, and refuses one it cannot read', () => {
  // `keys` is prose: `;`-separated groups, each with a parenthetical naming the
  // envelope it belongs to. The parenthetical is commentary, not keys.
  assert.deepEqual(
    [
      ...declaredKeys(
        'ok, verification_url (the device-start envelope); status, retry_after (the pending one)',
      ),
    ],
    ['ok', 'verification_url', 'status', 'retry_after'],
  )
  // An UN-parenthesized aside is refused rather than parsed down to the names
  // it happens to recognise. A silently shrunk set is loud in one direction
  // only: a dropped key still emitted shows up as `added`, but a dropped key
  // that STOPPED being emitted produces the `gone` that never fires.
  assert.equal(declaredKeys('ok, format, content — plus rows on the CSV branch only'), null)

  const map = mapFixture()
  map.cliConventions.envelopes.cmdLogout.keys = 'ok, signed_out — usually'
  assert.deepEqual(auditCliEnvelopes(scanCliEnvelopes(CLI_SRC), map).keyDrift, [
    { fn: 'cmdLogout', added: [], gone: [], unparsed: true },
  ])
})

test('every shipped envelopes entry has a parseable keys string', () => {
  // A refused string fails the run, so this reads the real map: the refusal is
  // a guard against a silent shrink, not a style rule to discover in CI.
  const map = JSON.parse(readFileSync('scripts/ci/vocabulary-map.json', 'utf8'))
  const unparseable = Object.entries(map.cliConventions.envelopes)
    .filter(([name]) => !name.startsWith('$'))
    .filter(([, entry]) => declaredKeys(entry.keys) === null)
    .map(([name]) => name)
  assert.deepEqual(unparseable, [])
})

test('the META argument of d.o.text is censused — it becomes top-level --json keys', () => {
  // The wrapper `{ ok: true, ...meta, content }` is built in output.ts, which
  // the census does not read, so this looked like a structural gap. It is not:
  // `meta` is a literal built in commands.ts, and `format`/`rows` are top-level
  // keys of the emitted object like any other. Today they carry no casing,
  // which is precisely why it could sit there green.
  const src = `
function cmdExport(d, args) {
  d.o.text(toCsv(headers, rows), { format: 'csv', rows: rows.length })
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdExport: ['format', 'rows'] })
})

test('the BODY argument of d.o.text is not mistaken for the literal', () => {
  // `text(content, META)` — the second argument carries the keys. Reading the
  // first would census an object that is the file body, not a --json shape.
  const src = `
function cmdExport(d, args) {
  d.o.text({ not: 'keys' }.toString(), { format: 'sie' })
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdExport: ['format'] })
})

test('the plausibility floors fire on a truncated scan', () => {
  // The backstop against a scanner that silently finds NOTHING — which reports
  // every declared entry as stale and reads as "the map is wrong". Both floors
  // lived inline behind process.exit, where disabling either left the whole
  // suite green: the guard against a silent failure was itself unproven.
  const full = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, true]))
  const cli = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`cmd${i}`, ['ok']]))
  assert.deepEqual(plausibilityProblems(full(30), full(29), cli), [])

  const short = plausibilityProblems(full(30), full(29), { cmdOnly: ['ok'] })
  assert.equal(short.length, 1)
  assert.match(short[0], /the CLI scan found only 1 emitter\(s\)/)

  const both = plausibilityProblems(full(2), full(1), cli)
  assert.deepEqual(
    both.map((p) => p.split(' ')[1]),
    ['receipt', 'transaction'],
  )
})

test('a quoted string inside a COMMENT is not read back as a key', () => {
  // The quoted-key readback re-reads the original at a blanked position — and
  // the stripper blanks comments the same way it blanks strings. A commented-out
  // key therefore read as a key AND consumed the key slot, so the literal's real
  // keys were dropped: wrong in both directions at once, and the obvious remedy
  // (write the phantom into the map) would mis-describe the shape permanently.
  //
  // Documenting an envelope's shape in a comment is what this slice encourages,
  // so this is the failure the stripper's own rationale warns against.
  const line = `
function cmdC(d, args) {
  emit(d, args.flags.json, {
    // was "legacy_key": 1
    ok: true,
    real_key: 2,
  }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(line), { cmdC: ['ok', 'real_key'] })

  const block = `
function cmdD(d, args) {
  emit(d, args.flags.json, { /* "ghost": 1 */ ok: true, d_key: 2 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(block), { cmdD: ['ok', 'd_key'] })

  // No apostrophe fixture here: the readback is ANCHORED (`^['"]…['"]\s*:`), so
  // an unbalanced quote in comment prose never reaches a key position and such
  // a fixture passes against the pre-fix code too. It bites in
  // `scanCsvHeaders`, whose match is unanchored, and it is tested there.
})

test('the CSV export headers are compared to the map, order included', () => {
  // The map declared them from the start and NOTHING compared them to the code,
  // so the page promised enforcement over a list free to drift. The drift with
  // teeth is a retired wire name coming back — the #2907 case — which shipped
  // green.
  const map = JSON.parse(readFileSync('scripts/ci/vocabulary-map.json', 'utf8'))
  const headers = scanCsvHeaders(readFileSync(map.surfaces.cli.file, 'utf8'))
  assert.deepEqual(auditCsvHeaders(headers, map), {})

  const renamed = headers.map((h) => (h === 'account_address' ? 'safe_address' : h))
  assert.deepEqual(auditCsvHeaders(renamed, map).actual, renamed)

  // Order counts: a spreadsheet importer reads columns by position.
  const reordered = [headers[1], headers[0], ...headers.slice(2)]
  assert.ok(auditCsvHeaders(reordered, map).actual !== undefined)

  // A renamed binding is a broken SCAN, and must not read as an agreeing map.
  assert.deepEqual(auditCsvHeaders(null, map), { unscannable: true })
})

test('scanCsvHeaders reads the array and not the rows built beside it', () => {
  //
  // The commented-out header sits INSIDE the brackets deliberately. One outside
  // them proves nothing: the scan reads the original over the array's span, so
  // only a comment within that span can leak. Without the kind check a retired
  // wire name reads as a shipped column, the audit reddens naming it, and the
  // obvious remedy is to add it to the map — which would then assert forever
  // that the export ships it.
  const src = `
function cmdExport(d, args) {
  const headers = [
    'date', 'token_symbol',
    // 'safe_address', retired in #2914
    'chain_id',
  ]
  const rows = visible.map((t) => ['not_a_header', t.hash])
}
`
  assert.deepEqual(scanCsvHeaders(src), ['date', 'token_symbol', 'chain_id'])
  assert.equal(scanCsvHeaders('const other = [1]'), null)

  // An APOSTROPHE in comment prose. The fixture above passes even with a
  // position filter instead of a blanking pass, because its comment happens to
  // have balanced quotes; this one does not. An unbalanced quote opens a match
  // inside the comment that runs into the next real header, so `chain_id` and
  // everything after it vanish and a phantom column appears in their place.
  const apostrophe = `function f() {
  const headers = [
    'date',
    // don't ship safe_address here
    'chain_id',
    'fee',
  ]
}`
  assert.deepEqual(scanCsvHeaders(apostrophe), ['date', 'chain_id', 'fee'])
  assert.deepEqual(
    scanCsvHeaders("const headers = ['date', /* the merchant's column */ 'chain_id']"),
    ['date', 'chain_id'],
  )
})

test('scanCsvHeaders walks to the BALANCED close of the header array', () => {
  // A nested array inside the literal ends the naive scan early, so the columns
  // after it are silently missing and the run reddens on a list that is right
  // in the code.
  const src = "const headers = ['date', ...(flag ? ['fee'] : []), 'chain_id']"
  assert.deepEqual(scanCsvHeaders(src), ['date', 'fee', 'chain_id'])
})

test('a comment between a quoted key and its colon does not lose the key', () => {
  // The readback matched `['\"]…['\"]\s*:` against the original, where a comment
  // is not whitespace, so the key was silently dropped. Blanking comments for
  // the readback serves this and the phantom-key case at once.
  const src = "function cmdA(d, a) { emit(d, a.flags.json, { 'x-k'/* why */: 1, ok: true }, () => 'x') }"
  assert.deepEqual(scanCliEnvelopes(src), { cmdA: ['x-k', 'ok'] })
})

test('auditCsvHeaders reads the map keys grammar, not a raw comma split', () => {
  // `keys` legally carries a parenthetical aside and `;` groups. A raw
  // `split(',')` turned `date, chain_id (the numeric id)` into a column named
  // "chain_id (the numeric id)" and reddened the run for a legal string.
  const map = JSON.parse(readFileSync('scripts/ci/vocabulary-map.json', 'utf8'))
  map.cliConventions.passthrough['activity export --format csv'].keys =
    'date, chain_id (the numeric id)'
  assert.deepEqual(auditCsvHeaders(['date', 'chain_id'], map), {})
})

test('the degenerate CSV audits each fail the run, and say which one it is', () => {
  // All three are reachable, and a guard that cannot find its subject must not
  // read as a guard that agrees with it.
  const map = JSON.parse(readFileSync('scripts/ci/vocabulary-map.json', 'utf8'))
  const headers = scanCsvHeaders(readFileSync(map.surfaces.cli.file, 'utf8'))

  const gone = JSON.parse(JSON.stringify(map))
  delete gone.cliConventions.passthrough['activity export --format csv']
  assert.deepEqual(auditCsvHeaders(headers, gone), { missing: true })

  const prose = JSON.parse(JSON.stringify(map))
  prose.cliConventions.passthrough['activity export --format csv'].keys =
    'date, chain_id — and a few more'
  assert.deepEqual(auditCsvHeaders(headers, prose), { unparsed: true })

  assert.deepEqual(auditCsvHeaders(null, map), { unscannable: true })
})

test('the declaration guard needs the BALANCED close of the argument list', () => {
  // A sink-named member whose parameters contain a `)` inside a callback type
  // closes naively at that `()`, so the text tested as "what follows" is the
  // middle of the declaration — neither a body nor an annotation — and the
  // declaration is processed as a CALL. The sink is an `emit*` helper, so every
  // argument becomes a payload candidate and the parameter annotations land on
  // the PREVIOUS real command as silent key drift on the wrong owner.
  //
  // A round-8 pass claimed no fixture could make a naive `indexOf(')')`
  // misfire. It was wrong; the `cb: () => void` parameter is all that was
  // missing, and it is the shape the header's hole list calls the most
  // ordinary.
  const src = `
function cmdReal(d, args) { emit(d, args.flags.json, { ok: true, real_key: 1 }, () => 'x') }
interface Sink { emitOther(payload: { a_b: string }, cb: () => void): void }
class Out { emitThing(merged: { relay: string }, cb: (c: string) => void): void {} }
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdReal: ['ok', 'real_key'] })
})

test('validateMap holds the CLI section to the same standard as the rest', () => {
  const badConvention = mapFixture()
  badConvention.cliConventions.envelopes.cmdLogout.convention = 'kebab'
  assert.ok(validateMap(badConvention).some((x) => /unknown convention "kebab"/.test(x)))

  const stubReason = mapFixture()
  stubReason.cliConventions.passthrough['wallets list'].reason = 'tbd'
  assert.ok(validateMap(stubReason).some((x) => /needs a written reason/.test(x)))

  const noKeys = mapFixture()
  delete noKeys.cliConventions.envelopes.cmdAgentRevoke.keys
  // The keys are what makes the reason checkable by a reader — "hybrid" is not
  // verifiable without knowing which keys are in the object.
  assert.ok(validateMap(noKeys).some((x) => /needs the keys it emits/.test(x)))

  assert.deepEqual(validateMap(mapFixture()), [])
})

test('the shipped map declares every envelope the shipped CLI emits', () => {
  // The case that goes red when someone adds an envelope and forgets the map,
  // so it reads the real files rather than a fixture.
  const map = JSON.parse(readFileSync('scripts/ci/vocabulary-map.json', 'utf8'))
  const cli = scanCliEnvelopes(readFileSync(map.surfaces.cli.file, 'utf8'))
  assert.deepEqual(auditCliEnvelopes(cli, map), { undeclared: [], stale: [], keyDrift: [] })
  // #3133 censused ten `{ ok: true` SITES; the honest predicate — an object
  // literal the CLI builds itself and hands to `emit()`, an `emit*` helper,
  // `d.o.data()` or `d.o.text()` — finds seventeen emitters. The seven extra
  // all pick a convention and were invisible to the prefix-keyed version:
  // wallets balances (which re-maps chain_id to chainId), whoami, the
  // grant/revoke preparation pair, `agents connect --run` (whose entire result
  // is built into a local const and passed to a helper), and the two export
  // `meta` literals, whose keys the output layer spreads into the wrapper.
  assert.equal(Object.keys(cli).length, 17)
  const withoutOk = Object.entries(cli)
    .filter(([, keys]) => !keys.includes('ok'))
    .map(([fn]) => fn)
  assert.deepEqual(withoutOk.sort(), [
    'cmdActivityExport',
    'cmdAgentsConnect',
    'cmdWalletsBalances',
    'cmdWhoami',
    'emitGrant',
    'emitRevoke',
    'exportSie',
  ])
})

test('a `{ ok: true` inside a comment or a string is not an emit', () => {
  // Documenting an envelope's shape above a command is exactly what this
  // slice's own documentation encourages. A guard that reddens on that teaches
  // people it is noise.
  const src = `
// historically this emitted { ok: true, legacy_key: 1 }
/** @example { ok: true, doc_key: 2 } */
function cmdInnocent(d, args) {
  const help = 'prints { ok: true, sample_key: 3 }'
  emit(d, args.flags.json, accounts, () => help)
}
`
  assert.deepEqual(scanCliEnvelopes(src), {})
})

test('a shorthand key counts, and a value is never mistaken for one', () => {
  // `{ agent_id: id, status }` is one snake key, one shorthand — and `id` is a
  // VALUE. An earlier walk read it as four keys including `id` and `true`.
  const src = `
function cmdShorthand(d, args) {
  emit(d, args.flags.json, { ok: true, agent_id: id, status, ...prepared }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src).cmdShorthand, ['ok', 'agent_id', 'status'])
})

test('a forwarded backend value is correctly absent — there is no casing choice to hold', () => {
  const src = `
function cmdWalletsList(d, args) {
  emit(d, args.flags.json, accounts, () => 'list')
}
`
  assert.deepEqual(scanCliEnvelopes(src), {})
})

test('stripCommentsAndStrings preserves offsets so positions stay meaningful', () => {
  const src = "const a = 1 // xx\nconst b = '22'\n"
  const out = stripCommentsAndStrings(src)
  assert.equal(out.length, src.length)
  assert.equal(out.split('\n').length, src.split('\n').length)
  assert.ok(out.includes('const a = 1'))
  assert.ok(!out.includes('xx'))
  assert.ok(!out.includes('22'))
})

test('an envelope built into a const and emitted through a helper is censused', () => {
  // `agents connect --run` does exactly this, and an inline-only predicate left
  // its entire user-visible result undeclared.
  const src = `
async function cmdViaVar(args: Args, d: Deps) {
  const merged = {
    setup_id: setup.id,
    connector_exit_code: run.exitCode,
    relay,
  }
  emitConnectResult(d, args.flags.json, merged, relay)
}
`
  assert.deepEqual(scanCliEnvelopes(src).cmdViaVar, [
    'setup_id',
    'connector_exit_code',
    'relay',
  ])
})

test('the deps object is not mistaken for a payload', () => {
  // `const d = { sessionStore, makeApi, … }` is built once and passed to every
  // command. Following an identifier without requiring a SAME-FUNCTION binding
  // resolves it as a payload, putting the deps keys on real emitters.
  //
  // It has to emit through an `emit*` HELPER. For the bare `emit` sink only
  // argument 2 is a candidate, so the deps identifier at argument 0 is never
  // looked at and the constraint is never exercised — this fixture used the
  // bare sink and passed against the unconstrained code, proving nothing.
  const src = `
function resolveDeps(over) {
  const d = { sessionStore: s, makeApi: m, out: o }
  return d
}

function cmdReal(args, d) {
  emitConnectResult(d, args.flags.json, { ok: true, real_key: 1 })
}
`
  const found = scanCliEnvelopes(src)
  assert.deepEqual(found.cmdReal, ['ok', 'real_key'])
  // Not merely absent from the list: without the constraint the deps keys
  // REPLACE the envelope's own, because the bound const is found first and the
  // scan stops there — so the real shape disappears from the census entirely.
  assert.ok(!found.cmdReal.includes('sessionStore'))
  assert.deepEqual(Object.keys(found), ['cmdReal'])
})

test('a multi-line arrow signature is still an owner, and a callback arrow is not', () => {
  // Both halves were wrong at once: a wrapped signature was not an owner (its
  // envelope merged into the previous function), and `const run = await f(x, (c) => …)`
  // WAS one, so an envelope after it was attributed to `run`.
  const src = `
const cmdMultiline = async (
  args: ParsedArgs,
  d: ResolvedDeps,
): Promise<number> => {
  emit(d, args.flags.json, { ok: true, multi_id: 1, multiCamel: 2 }, () => 'x')
}

async function cmdAfter(args, d) {
  const run = await runConnector(cmd, d.spawner, (chunk) => d.err(chunk))
  emit(d, args.flags.json, { ok: true, after_key: 1 }, () => 'y')
}
`
  const found = scanCliEnvelopes(src)
  assert.deepEqual(found.cmdMultiline, ['ok', 'multi_id', 'multiCamel'])
  assert.deepEqual(found.cmdAfter, ['ok', 'after_key'])
  assert.ok(!('run' in found), 'a callback arrow inside an initializer is not an owner')
})

test('a quoted key is read back from the original source', () => {
  // The stripper blanks strings, so a quoted key vanished — and an emit whose
  // keys all vanish was dropped from the census entirely.
  const src = `
function cmdQuoted(d, args) {
  emit(d, args.flags.json, { 'x-amount': 1, '2fa_enabled': true }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src).cmdQuoted, ['x-amount', '2fa_enabled'])
})

test('a regex literal containing a quote does not swallow the rest of the file', () => {
  // Without regex state, `/["']/g` opens a fake string that runs to the next
  // quote — silently, because what it swallows is usually code appended AFTER
  // the last declared emitter.
  const src = `
function cmdWithRegex(d, args) {
  const cleaned = args.positionals[0].replace(/["']/g, '')
  emit(d, args.flags.json, { ok: true, cleaned_key: cleaned }, () => 'x')
}

function cmdAfterRegex(d, args) {
  emit(d, args.flags.json, { ok: true, later_key: 1 }, () => 'y')
}
`
  const found = scanCliEnvelopes(src)
  assert.deepEqual(found.cmdWithRegex, ['ok', 'cleaned_key'])
  assert.deepEqual(found.cmdAfterRegex, ['ok', 'later_key'])
})

test('every arrow-const form is an owner — a missed one merges into its neighbour silently', () => {
  // This is the worst failure available to this scanner: the audit compares
  // function NAMES and never keys, so an envelope that lands on the previous
  // (already-declared) function keeps the run green. Two forms regressed when
  // the owner pattern was tightened, and both are ordinary TypeScript.
  const generic = `
export const cmdGen = async <T>(args: T, d: Deps) => {
  emit(d, args.flags.json, { ok: true, gen_key: 1, genCamel: 2 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(generic).cmdGen, ['ok', 'gen_key', 'genCamel'])

  // An annotation that itself contains `=>` defeated a regex that tried to
  // describe the annotation and the arrow in one pattern.
  const annotated = `
const cmdTyped: (a: A, d: D) => Promise<number> = async (args, d) => {
  emit(d, args.flags.json, { ok: true, typed_key: 1 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(annotated).cmdTyped, ['ok', 'typed_key'])
})

test('a ternary payload contributes both branches, not zero', () => {
  // A leading-literal-only test made a ternary argument name NO owner at all,
  // while the header claimed the ratchet still fired on it.
  const src = `
function cmdTern(d, args) {
  emit(d, args.flags.json, cond ? { x_1: 1 } : { yCamel: 2 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src).cmdTern, ['x_1', 'yCamel'])
})

test("a function DECLARATION is not a call, so a parameter's type annotation is not a payload", () => {
  // `function emitConnectResult(…, merged: { relay: string | null }, …)` matches
  // the sink pattern, and its annotation read as the emitted shape — inventing
  // a one-key envelope on a function that emits its parameter.
  const src = `
function emitConnectResult(
  d: Deps,
  json: boolean,
  merged: { relay: string | null; setup_id: string },
  relay: string | null,
): void {
  emit(d, json, merged, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src), {})
})

test('a nested type-parameter list is still an owner', () => {
  // `<T extends Record<string, string>>` stopped an unbalanced `<[^>]*>` eat at
  // the first `>`, so the const was not an owner and its envelope merged into
  // the previous function — silently, because the audit compares names only.
  const src = `
function anchor(d, args) { emit(d, args.flags.json, { anchor_key: 1 }, () => 'a') }
const cmdG = async <T extends Record<string, string>>(args: T, d) => {
  emit(d, args.flags.json, { ok: true, k_1: 1 }, () => 'x')
}
`
  const found = scanCliEnvelopes(src)
  assert.deepEqual(found.cmdG, ['ok', 'k_1'])
  assert.deepEqual(found.anchor, ['anchor_key'], 'the anchor keeps its own keys')
})

test('an annotated declaration with no initializer does not become a phantom owner', () => {
  // `let pending: string;` has no arrow. A dead `;` test let the walk run on to
  // a later statement's arrow, making an owner named after a local variable,
  // positioned INSIDE the real command, which then stole its envelope.
  //
  // The trailing `handler = (x) => x` is what makes this bite: without a
  // depth-0 arrow AFTER the declaration there is nothing for the walk to run
  // on to, so the earlier version of this test passed against the broken code
  // as well and proved nothing.
  const src = `
function cmdReal(d, args) {
  let pending: string;
  handler = (x) => x
  emit(d, args.flags.json, { ok: true, real_key: 1 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdReal: ['ok', 'real_key'] })
})

test('a renderer arrow with a return annotation does not hide the call', () => {
  // The declaration guard once tested `\([^)]*:[^)]*\)\s*:`, whose `[^)]*`
  // stops at the first `)` in the CALL text — here the renderer's own `()` —
  // so the whole real call was skipped and the command vanished from the
  // census silently. `(): T =>` is idiomatic, so this was a trap for the next
  // edit rather than a one-off.
  const src = `
function cmdTyped(d, args) {
  emit(d, args.flags.json, { ok: true, typed_key: 1 }, (): string => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdTyped: ['ok', 'typed_key'] })
})

test('a multi-line call whose argument list closes at a line end is still a call', () => {
  // The guard is keyed on what FOLLOWS the balanced close: a body means a
  // declaration. Treating "nothing else on this line" as a declaration too
  // matched almost every multi-line call, and the census went to zero.
  const src = `
function cmdMulti(d, args) {
  emit(
    d,
    args.flags.json,
    { ok: true, multi_key: 1 },
    () => 'x'
  )
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdMulti: ['ok', 'multi_key'] })
})

test('a semicolon ends a declaration even with no line break after it', () => {
  // The `;` break and the newline break are separate. Written on ONE line there
  // is no newline for the second to catch, so this fixture bites on the `;`
  // break alone — the multi-line one is caught by either and proves only the
  // pair.
  const src =
    'function cmdReal(d, args) { let pending: string; handler = (x) => x; ' +
    "emit(d, args.flags.json, { ok: true, real_key: 1 }, () => 'x') }"
  assert.deepEqual(scanCliEnvelopes(src), { cmdReal: ['ok', 'real_key'] })
})

test('a declaration ended by ASI, not by a semicolon, is still not an owner', () => {
  // `let pending: string` with no `;` walked past the line end, adopted the
  // NEXT statement's arrow and became a phantom owner positioned inside the
  // real command. The `;` break cannot see this, and the blank-line test that
  // preceded it could not either: the following line is not blank.
  const src = `
function cmdReal(d, args) {
  let pending: string
  handler = (x) => x
  emit(d, args.flags.json, { ok: true, real_key: 1 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdReal: ['ok', 'real_key'] })
})

test('a genuinely multi-line type annotation is still skipped whole', () => {
  // The newline break must not fire on a union continued across lines, or the
  // walk stops early, misses the `=`, and the arrow const is not an owner —
  // which merges its envelope into the previous function's entry silently.
  //
  // The `|` has to be the LAST thing on the line and the depth has to be 0
  // there, or the break never fires and the test proves nothing.
  const src = `
const cmdUnion: Handler<Args> |
  LegacyHandler =
  async (args, d) => { emit(d, args.flags.json, { ok: true, u_k: 1 }, () => 'x') }
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdUnion: ['ok', 'u_k'] })
})

test('a class or interface member named emit*() is a declaration, not a call', () => {
  // Its parameter annotations are not payloads. The `function` guard alone did
  // not cover this, and the phantom keys landed on a REAL command silently.
  const src = `
function cmdReal(d, args) { emit(d, args.flags.json, { ok: true, real_key: 1 }, () => 'x') }
class Out { emitThing(merged: { relay: string, setup_id: string }): void {} }
class Bare { emitBare(merged: { other: string, bare_id: string }) {} }
interface Sink { emitOther(payload: { a_b: string }): void }
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdReal: ['ok', 'real_key'] })
})

test('an identifier inside an inline literal is not collected as the payload', () => {
  // `{ ok: true, a_b: limits.max_n }` names the local `limits`, and following
  // every identifier one hop resolved it and spliced ITS keys into the
  // envelope. Only a whole argument that IS an identifier (or a ternary
  // branch that is) may be followed.
  const src = `
function cmdOver(d, args) {
  const limits = { max_n: 5, other_n: 6 }
  emit(d, args.flags.json, { ok: true, a_b: limits.max_n }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src), { cmdOver: ['ok', 'a_b'] })
})

test('a ternary mixing a literal and a bound identifier keeps both branches', () => {
  const src = `
function cmdMix(d, args) {
  const v = { bound_key: 1 }
  emit(d, args.flags.json, cond ? v : { yCamel: 2 }, () => 'x')
}
`
  assert.deepEqual(scanCliEnvelopes(src).cmdMix.sort(), ['bound_key', 'yCamel'])
})
