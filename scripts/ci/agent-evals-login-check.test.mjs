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
  assert.match(r.message, /printed no result.*something broke/)
})

test('non-JSON noise before the result line is ignored', () => {
  const r = judgeLoginCheck(`warning: x\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })}\n`)
  assert.equal(r.ok, true)
})

test('a non-success subtype fails even when is_error is false', () => {
  const r = judgeLoginCheck(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: '' }))
  assert.equal(r.ok, false)
  assert.match(r.message, /error_max_turns/)
})

test('a success result with a non-zero exit code fails', () => {
  const r = judgeLoginCheck(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }), '', 1)
  assert.equal(r.ok, false)
  assert.match(r.message, /exit 1/)
})

test('pretty-printed or array output is read, not misreported as missing', () => {
  const pretty = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }, null, 2)
  assert.equal(judgeLoginCheck(pretty).ok, true)
  const arr = JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'success', is_error: false, result: 'OK' }])
  assert.equal(judgeLoginCheck(arr).ok, true)
})
