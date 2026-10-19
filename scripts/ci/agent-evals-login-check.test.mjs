// Run with: node --test scripts/ci/agent-evals-login-check.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeLoginCheck } from './agent-evals-login-check.mjs'

test('a successful one-turn result passes and quotes the reply', () => {
  const r = judgeLoginCheck(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.001 }))
  assert.equal(r.ok, true)
  assert.match(r.message, /passed .*OK.*cost=\$0\.001/)
})

test('an error result fails and carries claude’s own reason', () => {
  const r = judgeLoginCheck(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }))
  assert.equal(r.ok, false)
  assert.match(r.message, /failed .*Invalid API key/)
})

test('no result line fails and quotes stderr', () => {
  const r = judgeLoginCheck('', 'Error: something broke')
  assert.equal(r.ok, false)
  assert.match(r.message, /no result line.*something broke/)
})

test('non-JSON noise before the result line is ignored', () => {
  const r = judgeLoginCheck(`warning: x\n${JSON.stringify({ type: 'result', is_error: false, result: 'OK' })}\n`)
  assert.equal(r.ok, true)
})
