// #3817 — the stale-client tool-contract check's logic, pinned. The script
// itself is ADVISORY (it writes the mcp_server_checks job summary and exits
// 0 either way); these tests are what keep its findings honest, including
// both halves of the #3739 break that motivated it: a stale client refusing
// NEW properties (method/headers/body) and a stale client still REQUIRING a
// property the branch no longer emits (payment_required).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkStaleClientCompat, flatSchemaViolations } from './check-stale-client-compat.mjs'

/** The pre-#3739 haven_pay_x402_quote schema a stale client holds. */
const STALE_PAY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    idempotency_key: { type: 'string' },
    url: { type: 'string' },
    payment_required: { type: 'object' },
    max_amount_human: { type: 'string' },
  },
  required: ['idempotency_key', 'url', 'payment_required'],
}

const baseSnapshot = (tools) => ({ comment: 'base', tools })

describe('flatSchemaViolations', () => {
  test('refuses an undeclared property under additionalProperties: false', () => {
    const v = flatSchemaViolations({ idempotency_key: 'k', url: 'https://x', payment_required: {}, extra: 1 }, STALE_PAY_SCHEMA)
    assert.deepEqual(v, ['`extra` is not in the stale client\'s schema (it refuses undeclared input)'])
  })

  test('refuses a missing required property', () => {
    const v = flatSchemaViolations({ idempotency_key: 'k', url: 'https://x' }, STALE_PAY_SCHEMA)
    assert.deepEqual(v, ['required `payment_required` is missing (the stale client still requires it)'])
  })

  test('stays silent when the emission fits the stale schema', () => {
    assert.deepEqual(
      flatSchemaViolations({ idempotency_key: 'k', url: 'https://x', payment_required: {} }, STALE_PAY_SCHEMA),
      [],
    )
  })
})

describe('checkStaleClientCompat', () => {
  const BASE = baseSnapshot({
    haven_pay_x402_quote: { description: 'pay the quote', inputSchema: STALE_PAY_SCHEMA },
    haven_old_tool: { description: 'd', inputSchema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string', pattern: '^0x[0-9a-f]*$' }, keep: { type: 'string', enum: ['x', 'y'] } } } },
  })

  test('#3739 half A — the branch emitting method/headers/body reports reconnect required', () => {
    const corpus = {
      entries: [
        {
          site: 'plain-http-x402.ts haven_quote_x402 → haven_pay_x402_quote',
          tool: 'haven_pay_x402_quote',
          arguments: { idempotency_key: '<x402q-uuid>', url: 'https://m.test/paid', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        },
      ],
    }
    const { reports, notice } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: BASE, corpus })
    assert.equal(notice, null)
    assert.equal(reports.length, 1)
    assert.match(reports[0], /reconnect required/)
    assert.match(reports[0], /`method` is not in the stale client's schema/)
    assert.match(reports[0], /haven_pay_x402_quote/)
  })

  test('#3739 half B — the branch omitting payment_required reports reconnect required', () => {
    const corpus = {
      entries: [{ site: 'refusal fixture', tool: 'haven_pay_x402_quote', arguments: { idempotency_key: 'k', url: 'https://m.test/paid' } }],
    }
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: BASE, corpus })
    assert.equal(reports.length, 1)
    assert.match(reports[0], /required `payment_required` is missing/)
  })

  test('a purely additive optional field no emission carries reports nothing', () => {
    const branch = baseSnapshot({
      ...BASE.tools,
      haven_pay_x402_quote: {
        description: 'pay the quote',
        inputSchema: { ...STALE_PAY_SCHEMA, properties: { ...STALE_PAY_SCHEMA.properties, new_thing: { type: 'string' } } },
      },
    })
    const corpus = {
      entries: [{ site: 'refusal fixture', tool: 'haven_pay_x402_quote', arguments: { idempotency_key: 'k', url: 'u', payment_required: {} } }],
    }
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: branch, corpus })
    assert.deepEqual(reports, [])
  })

  test('a description-only change reports nothing', () => {
    const branch = baseSnapshot({
      ...BASE.tools,
      haven_old_tool: { description: 'a NEW description', inputSchema: BASE.tools.haven_old_tool.inputSchema },
    })
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: branch, corpus: { entries: [] } })
    assert.deepEqual(reports, [])
  })

  test('a removed or renamed tool reports', () => {
    const branch = baseSnapshot({ haven_pay_x402_quote: BASE.tools.haven_pay_x402_quote })
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: branch, corpus: { entries: [] } })
    assert.equal(reports.length, 1)
    assert.match(reports[0], /`haven_old_tool` was removed or renamed/)
  })

  test('a removed or renamed property reports', () => {
    const branch = baseSnapshot({
      ...BASE.tools,
      haven_old_tool: { description: 'd', inputSchema: { type: 'object', properties: { keep: { type: 'string', enum: ['x', 'y'] } } } },
    })
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: branch, corpus: { entries: [] } })
    assert.equal(reports.length, 1)
    assert.match(reports[0], /property `a` of `haven_old_tool` was removed or renamed/)
  })

  test('a narrowed enum reports; a widened one does not', () => {
    const narrowed = baseSnapshot({
      ...BASE.tools,
      haven_old_tool: { description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' }, keep: { type: 'string', enum: ['x'] } } } },
    })
    assert.match(checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: narrowed, corpus: { entries: [] } }).reports[0], /enum narrowed/)

    const widened = baseSnapshot({
      ...BASE.tools,
      haven_old_tool: { description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' }, keep: { type: 'string', enum: ['x', 'y', 'z'] } } } },
    })
    assert.deepEqual(checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: widened, corpus: { entries: [] } }).reports, [])
  })

  test('a changed pattern reports (the #3172 precedent)', () => {
    const branch = baseSnapshot({
      ...BASE.tools,
      haven_old_tool: { description: 'd', inputSchema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string', pattern: '^0x[0-9a-f]+$' }, keep: { type: 'string', enum: ['x', 'y'] } } } },
    })
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: branch, corpus: { entries: [] } })
    assert.equal(reports.length, 1)
    assert.match(reports[0], /pattern changed/)
  })

  test('a corpus emission outside the stale enum reports', () => {
    const branch = baseSnapshot({
      ...BASE.tools,
      haven_old_tool: { description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' }, keep: { type: 'string', enum: ['x', 'y', 'z'] } } } },
    })
    const corpus = { entries: [{ site: 's', tool: 'haven_old_tool', arguments: { keep: 'z' } }] }
    const { reports } = checkStaleClientCompat({ baseSnapshot: BASE, branchSnapshot: branch, corpus })
    assert.equal(reports.length, 1)
    assert.match(reports[0], /outside the stale client's enum/)
  })

  test('no base snapshot skips with a notice and no reports', () => {
    const { reports, notice } = checkStaleClientCompat({ baseSnapshot: null, branchSnapshot: BASE, corpus: { entries: [] } })
    assert.deepEqual(reports, [])
    assert.match(notice, /no tools\/list snapshot yet/)
  })
})

describe('check-stale-client-compat CLI', () => {
  test('runs and exits 0 with a summary (full compare once HEAD carries the goldens, notice before)', () => {
    const script = fileURLToPath(new URL('./check-stale-client-compat.mjs', import.meta.url))
    const res = spawnSync('node', [script, '--base', 'HEAD'], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /### Stale-client tool-contract check/)
    assert.match(res.stdout, /(Compared \d+ committed next_arguments emissions|\[NOTICE\])/)
  })

  test('a base without the snapshot file skips with a notice and exits 0', () => {
    const script = fileURLToPath(new URL('./check-stale-client-compat.mjs', import.meta.url))
    // Any ref that cannot carry the file exercises the skip path; the full
    // committed-goldens compare runs in CI's mcp_server_checks against
    // origin/main.
    const res = spawnSync('node', [script, '--base', 'HEAD~500'], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /\[NOTICE\]/)
  })
})
