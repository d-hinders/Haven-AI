// Tests for rpc-conformance.mjs (#3336): every check is proven able to fail
// against a local fake endpoint, and no output ever carries the endpoint URL.
// Run with: node --test scripts/ci/rpc-conformance.test.mjs

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probe, parseArgs, MAX_BURST, DEFAULT_BATCH } from './rpc-conformance.mjs'

const SCRIPT = fileURLToPath(new URL('./rpc-conformance.mjs', import.meta.url))

const KEY = 'FAKEKEYFAKEKEYFAKEKEY0123456789'
// The signer is injected: the CLI signs with ethers (a zero-balance throwaway
// key), which this CI job does not install. The fake only needs a hex string.
// It accepts a null chain id on purpose, so only the probe's own guard stops a blind sign.
const sign = async (chainId) => `0x02f8${String(chainId)}deadbeef`

/**
 * A fake JSON-RPC endpoint. `mode` switches each misbehaviour on:
 *   maxBatch        refuse batches over N with a per-item code 31 (dRPC's free plan)
 *   refusePending   answer the `pending` tag with dRPC's "No label `flashblocks`"
 *   sendRaw         'validate' (insufficient funds) | 'methodNotFound' | 'accept'
 *   rateLimitOver   answer HTTP 429 once more than N requests are in flight
 *   noChainId       eth_chainId errors
 *   echoUrl         put the request URL into every error (as ethers' requestUrl does)
 *   batchAsObject   answer ANY batch with a single error object (not an array)
 *   rawStatus       the HTTP status for eth_sendRawTransaction replies (a proxy's 400)
 *   sendRawMessage  override the validation message (Nethermind, Besu wording)
 *   bare429         answer 429 with an empty body (only the status says "slow down")
 *   chainStatus     the HTTP status for eth_chainId (with a valid-looking body)
 *   chainResult     the eth_chainId result string
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
    if (mode.rateLimitOver && inFlight > mode.rateLimitOver && mode.rateLimitRpc) {
      const [code, ...words] = mode.rateLimitRpc.split(' ')
      return reply(200, { jsonrpc: '2.0', id: 1, error: { code: Number(code), message: words.join(' ') } })
    }
    if (mode.rateLimitOver && inFlight > mode.rateLimitOver) {
      inFlight -= 1
      res.writeHead(429)
      return res.end(mode.bare429 ? '' : JSON.stringify({ error: 'Too Many Requests' }))
    }
    const echo = mode.echoUrl ? ` (requestUrl: ${url})` : mode.echoProviderUrl ? ` (upstream: https://lb.example-rpc.io/base-sepolia/${KEY})` : ''
    const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message: `${message}${echo}` } })
    const one = (c) => {
      if (c.method === 'eth_chainId') return mode.noChainId ? err(c.id, -32601, 'method not found') : { jsonrpc: '2.0', id: c.id, result: mode.chainResult ?? '0x14a34' }
      if (c.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: c.id, result: '0x10' }
      if (c.method === 'eth_getTransactionCount') {
        return mode.refusePending && c.params[1] === 'pending' ? err(c.id, -32602, 'No label `flashblocks`') : { jsonrpc: '2.0', id: c.id, result: '0x0' }
      }
      if (c.method === 'eth_sendRawTransaction') {
        if (mode.sendRaw === 'methodNotFound') return err(c.id, -32601, 'the method eth_sendRawTransaction does not exist/is not available')
        if (mode.sendRaw === 'accept') return { jsonrpc: '2.0', id: c.id, result: `0x${'ab'.repeat(32)}` }
        return err(c.id, -32000, mode.sendRawMessage ?? 'insufficient funds for gas * price + value: have 0 want 21000000000000')
      }
      return err(c.id, -32601, 'method not found')
    }
    const body = JSON.parse(raw)
    if (Array.isArray(body) && mode.batchAsObject) return reply(200, err(null, -32600, 'batch requests are not supported'))
    if (!Array.isArray(body) && body.method === 'eth_sendRawTransaction' && mode.rawStatus) return reply(mode.rawStatus, one(body))
    if (!Array.isArray(body) && body.method === 'eth_chainId' && mode.chainStatus) return reply(mode.chainStatus, one(body))
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

async function run(mode, opts = {}, path = `/base-sepolia/${KEY}`) {
  const server = fakeEndpoint(mode)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}${path}`
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

  test('chain id: a wrong network, an unreadable id, or a non-200 fails', async () => {
    assert.equal((await run({}, { chain: 84532 })).byName('chain').ok, true)
    const wrong = (await run({}, { chain: 8453 })).byName('chain')
    assert.equal(wrong.ok, false)
    assert.match(wrong.detail, /chain 84532, expected 8453/)
    assert.equal((await run({ chainResult: '0x' })).byName('chain').ok, false)
    assert.equal((await run({ chainStatus: 500 })).byName('chain').ok, false)
  })

  test('batch: a batch answered with ONE error object (not an array) fails', async () => {
    assert.equal((await run({ batchAsObject: true })).byName('batch').ok, false)
  })

  test('send raw tx: Nethermind and Besu wording, and a proxy\'s HTTP 400 around the error, still count as validated', async () => {
    assert.equal((await run({ sendRawMessage: 'InsufficientFunds, Balance is zero' })).byName('send raw').ok, true)
    assert.equal((await run({ sendRawMessage: 'Upfront cost exceeds account balance' })).byName('send raw').ok, true)
    assert.equal((await run({ rawStatus: 400 })).byName('send raw').ok, true)
    assert.equal((await run({ sendRawMessage: 'invalid sender' })).byName('send raw').ok, false)
  })

  test('burst: a 429 with no body fails on the status alone', async () => {
    const bare = (await run({ rateLimitOver: 5, bare429: true })).byName('burst')
    assert.equal(bare.ok, false)
    assert.match(bare.detail, /rate-limited/) // named as throttling, not as a generic failure
    // A JSON-RPC rate-limit error in an HTTP 200 (Base's public node, measured 2026-09-26).
    const rpcLimited = (await run({ rateLimitOver: 5, rateLimitRpc: '-32007 25/second request limit reached' })).byName('burst')
    assert.match(rpcLimited.detail, /rate-limited/)
  })

  test('the verbatim URL redaction carries a URL the scrub cannot parse (a `)` in its path)', async () => {
    const { results } = await run({ echoUrl: true, maxBatch: 3 }, {}, `/base(sepolia)/${KEY}`)
    assert.doesNotMatch(JSON.stringify(results), new RegExp(KEY))
  })

  test('an unreachable endpoint fails every check instead of throwing', async () => {
    // A port that was just closed refuses connections (port 1 is on fetch's blocklist instead).
    const closed = createServer()
    await new Promise((r) => closed.listen(0, '127.0.0.1', r))
    const port = closed.address().port
    await new Promise((r) => closed.close(r))
    const results = await probe({ url: `http://127.0.0.1:${port}/x/${KEY}`, sign })
    assert.equal(results.length, 5)
    assert.ok(results.every((r) => !r.ok))
    assert.match(results[0].detail, /ECONNREFUSED/) // the transport cause, not just "fetch failed"
    assert.doesNotMatch(JSON.stringify(results), new RegExp(KEY))
  })
})

describe('rpc-conformance CLI (#3336)', () => {
  test('arguments are parsed strictly: a typo is exit 2, never a vacuous pass', () => {
    const base = ['--url', 'http://x/y', '--chain', '84532']
    assert.deepEqual(parseArgs(base), { url: 'http://x/y', chain: 84532, batch: 10, burst: 20 })
    for (const bad of [['--burst', 'foo'], ['--burst', '0'], ['--burst', '51'], ['--batch', '1'], ['--batch', '1.5'], ['--batch', '101']]) {
      assert.throws(() => parseArgs([...base, ...bad]), /must be an integer/, bad.join(' '))
    }
    assert.throws(() => parseArgs(['--url', 'http://x/y']), /--chain is required/)
    const r = spawnSync(process.execPath, [SCRIPT, ...base, '--burst', 'foo'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.doesNotMatch(r.stdout + r.stderr, /http:\/\/x\/y/)
  })

  test('started through a symlinked path, the CLI still runs (a skipped CLI would exit 0 silently)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpc-conf-'))
    const link = join(dir, 'probe via link.mjs') // a space too
    symlinkSync(SCRIPT, link)
    const r = spawnSync(process.execPath, [link, '--url', `http://127.0.0.1:1/x/${KEY}`, '--chain', '84532'], { encoding: 'utf8' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /✗ chain id/)
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY))
  })
})
