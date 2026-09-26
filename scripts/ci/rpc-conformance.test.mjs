// Tests for rpc-conformance.mjs (#3336): every check is proven able to fail
// against a local fake endpoint, and no output ever carries the endpoint URL.
// Run with: node --test scripts/ci/rpc-conformance.test.mjs

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probe, MAX_BURST, DEFAULT_BATCH } from './rpc-conformance.mjs'

const KEY = 'FAKEKEYFAKEKEYFAKEKEY0123456789'
// The signer is injected: the CLI signs with ethers (a zero-balance throwaway
// key), which this CI job does not install. The fake only needs a hex string.
const sign = async (chainId) => `0x02f8${chainId.toString(16)}deadbeef`

/**
 * A fake JSON-RPC endpoint. `mode` switches each misbehaviour on:
 *   maxBatch        refuse batches over N with a per-item code 31 (dRPC's free plan)
 *   refusePending   answer the `pending` tag with dRPC's "No label `flashblocks`"
 *   sendRaw         'validate' (insufficient funds) | 'methodNotFound' | 'accept'
 *   rateLimitOver   answer HTTP 429 once more than N requests are in flight
 *   noChainId       eth_chainId errors
 *   echoUrl         put the request URL into every error (as ethers' requestUrl does)
 *   echoProviderUrl put a DIFFERENT, provider-style URL with the key into errors
 *                   (a load balancer naming its upstream): only the scrub, not the
 *                   verbatim URL redaction, can catch that
 */
function fakeEndpoint(mode = {}) {
  let inFlight = 0
  const server = createServer(async (req, res) => {
    inFlight += 1
    let raw = ''
    for await (const chunk of req) raw += chunk
    await new Promise((r) => setTimeout(r, 5)) // keep concurrent requests overlapping
    const url = `http://${req.headers.host}${req.url}`
    const reply = (status, body) => {
      inFlight -= 1
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (mode.rateLimitOver && inFlight > mode.rateLimitOver) return reply(429, { error: 'Too Many Requests' })
    const echo = mode.echoUrl ? ` (requestUrl: ${url})` : mode.echoProviderUrl ? ` (upstream: https://lb.example-rpc.io/base-sepolia/${KEY})` : ''
    const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message: `${message}${echo}` } })
    const one = (c) => {
      if (c.method === 'eth_chainId') return mode.noChainId ? err(c.id, -32601, 'method not found') : { jsonrpc: '2.0', id: c.id, result: '0x14a34' }
      if (c.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: c.id, result: '0x10' }
      if (c.method === 'eth_getTransactionCount') {
        return mode.refusePending && c.params[1] === 'pending' ? err(c.id, -32602, 'No label `flashblocks`') : { jsonrpc: '2.0', id: c.id, result: '0x0' }
      }
      if (c.method === 'eth_sendRawTransaction') {
        if (mode.sendRaw === 'methodNotFound') return err(c.id, -32601, 'the method eth_sendRawTransaction does not exist/is not available')
        if (mode.sendRaw === 'accept') return { jsonrpc: '2.0', id: c.id, result: `0x${'ab'.repeat(32)}` }
        return err(c.id, -32000, 'insufficient funds for gas * price + value: have 0 want 21000000000000')
      }
      return err(c.id, -32601, 'method not found')
    }
    const body = JSON.parse(raw)
    if (Array.isArray(body)) {
      if (mode.maxBatch && body.length > mode.maxBatch) {
        return reply(200, body.map((c) => err(c.id, 31, `Batch of more than ${mode.maxBatch} requests are not allowed on free plan`)))
      }
      return reply(200, body.map(one))
    }
    return reply(200, one(body))
  })
  return server
}

async function run(mode, opts = {}) {
  const server = fakeEndpoint(mode)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/base-sepolia/${KEY}`
  try {
    const results = await probe({ url, sign, ...opts })
    return { url, results, byName: (prefix) => results.find((r) => r.name.startsWith(prefix)) }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

describe('rpc-conformance (#3336)', () => {
  test('a conformant endpoint passes every check (so each failure below means something)', async () => {
    const { results } = await run({})
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ['chain id', true], [`batch of ${DEFAULT_BATCH}`, true], ['pending tag', true], ['send raw tx', true], ['burst of 20', true],
    ])
    assert.match(results[0].detail, /chain 84532/)
  })

  test('batch: an endpoint that refuses batches over 3 fails, with the provider\'s reason', async () => {
    const { byName } = await run({ maxBatch: 3 })
    assert.equal(byName('batch').ok, false)
    assert.match(byName('batch').detail, /Batch of more than 3/)
    // …and a batch within the limit passes: the check measures the limit, not batching as such.
    assert.equal((await run({ maxBatch: 3 }, { batch: 3 })).byName('batch').ok, true)
  })

  test('pending tag: dRPC\'s "No label flashblocks" fails', async () => {
    const { byName } = await run({ refusePending: true })
    assert.equal(byName('pending').ok, false)
    assert.match(byName('pending').detail, /flashblocks/)
  })

  test('send raw tx: validated (insufficient funds) passes; a refused method or an ACCEPTED zero-balance tx fails', async () => {
    assert.equal((await run({ sendRaw: 'validate' })).byName('send raw').ok, true)
    const refused = (await run({ sendRaw: 'methodNotFound' })).byName('send raw')
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /-32601/)
    assert.equal((await run({ sendRaw: 'accept' })).byName('send raw').ok, false)
    // Without a chain id there is nothing to sign for: fail, never sign blind.
    assert.equal((await run({ noChainId: true })).byName('send raw').ok, false)
  })

  test('burst: any 429 fails, and the burst is capped at 50 whatever is asked', async () => {
    const { byName } = await run({ rateLimitOver: 5 })
    assert.equal(byName('burst').ok, false)
    assert.match(byName('burst').detail, /rate-limited/)
    const capped = await run({}, { burst: 500 })
    assert.equal(capped.byName('burst').name, `burst of ${MAX_BURST}`)
    assert.equal(MAX_BURST, 50)
  })

  test('the endpoint URL (and its key) is never in any result, even when every error echoes it', async () => {
    for (const mode of [
      { echoUrl: true, maxBatch: 3, refusePending: true, sendRaw: 'methodNotFound' },
      { echoUrl: true, noChainId: true },
      { echoProviderUrl: true, maxBatch: 3, refusePending: true, sendRaw: 'methodNotFound' },
    ]) {
      const { results } = await run(mode)
      const text = JSON.stringify(results)
      assert.doesNotMatch(text, new RegExp(KEY))
      assert.doesNotMatch(text, /127\.0\.0\.1/)
    }
  })

  test('an unreachable endpoint fails every check instead of throwing', async () => {
    const results = await probe({ url: `http://127.0.0.1:1/x/${KEY}`, sign })
    assert.equal(results.length, 5)
    assert.ok(results.every((r) => !r.ok))
    assert.doesNotMatch(JSON.stringify(results), new RegExp(KEY))
  })
})
