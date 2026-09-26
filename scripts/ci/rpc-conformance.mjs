#!/usr/bin/env node
// RPC conformance probe (#3336, epic #3335).
//
// qa-dev's waves in September 2026 came from swapping RPC providers without
// checking that the new endpoint does what Haven's code assumes. dRPC's free
// plan refused JSON-RPC batches over three ("Batch of more than 3 requests are
// not allowed", code 31) while the QA harness's ethers providers batch every
// call made within ~10 ms, up to 100; it answered the `pending` block tag with
// "No label `flashblocks`"; and its rate limits arrived as scenario failures.
// Run this against a candidate endpoint BEFORE it goes into a variable:
//
//   node scripts/ci/rpc-conformance.mjs --url "$CANDIDATE_RPC_URL" --chain <id> [--batch 10] [--burst 20]
//
// One line per capability, pass (✓) or fail (✗); exit 1 on any failure.
//
//   chain id     eth_chainId answers AND equals --chain (84532 Base Sepolia,
//                8453 Base): a Sepolia URL pasted into RPC_URL_BASE fails here
//   batch        a JSON-RPC batch of N eth_blockNumber calls all succeed
//   pending tag  eth_getTransactionCount(<addr>, "pending") answers
//   send raw tx  eth_sendRawTransaction is ACCEPTED as a method: a transaction
//                signed by an in-process throwaway key with a zero balance is
//                refused for funds/nonce/gas — the node validated it — never
//                for the method itself. A zero-balance key cannot pay gas, so
//                nothing can ever be mined, on any chain.
//   burst        K concurrent eth_blockNumber calls: ANY HTTP 429 or JSON-RPC
//                rate-limit error fails. The harness and the backend fire more
//                than that in a single leg, so an endpoint that throttles a
//                burst of K will throttle a run. K is capped at 50. The burst
//                deliberately spends up to K requests of the key's per-second
//                budget: against a key the live relayer already uses (a PROD
//                key), run it off-peak or with a smaller --burst, because a key
//                that fails this check has just throttled everyone else on it.
//
// The endpoint URL is never printed: a provider URL carries its API key in the
// path, and error bodies echo it (`"requestUrl": "…"`). Every message goes
// through the same scrub as the qa-dev summary (qa-retry.mjs), and the URL
// itself is also redacted verbatim — the precedent is `fallbackSendError` in
// packages/backend/src/infra/outbound-queue.ts.

import { scrub } from './qa-retry.mjs'

export const DEFAULT_BATCH = 10
export const DEFAULT_BURST = 20
export const MAX_BURST = 50
const TIMEOUT_MS = 10_000

/**
 * A method the node validated: it read the transaction and refused it on its
 * merits. geth/reth/erigon say "insufficient funds …", Nethermind
 * "InsufficientFunds", Besu "Upfront cost exceeds account balance".
 */
const VALIDATED = /insufficient ?funds|upfront cost|nonce|intrinsic gas|gas too low|underpriced|exceeds block gas limit|max fee per gas/i
/** A JSON-RPC error that means "slow down" rather than "no". */
// Base's public node answers `-32007 25/second request limit reached` (2026-09-26).
const RATE_LIMITED = /rate limit|too many requests|-32005|-32007|-32016|request limit reached|exceeded.*(quota|limit)|limit exceeded/i

/** Scrub a message for printing: the URL verbatim, then every URL-shaped or key-labelled token. */
export function redact(text, url) {
  let s = String(text ?? '')
  if (url) s = s.split(url).join('<url>')
  return scrub(s, 200)
}

/** One JSON-RPC POST. Returns { status, body } or throws on transport failure/timeout. */
async function post(url, payload, fetchImpl) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(t)
  }
}

const call = (id, method, params = []) => ({ jsonrpc: '2.0', id, method, params })
const errText = (e) => (e && typeof e === 'object' ? `${e.code ?? ''} ${e.message ?? ''}`.trim() : String(e))

/** The five checks, in order. Each returns { name, ok, detail }. `sign` builds a signed raw tx. */
export async function probe({ url, chain, batch = DEFAULT_BATCH, burst = DEFAULT_BURST, fetchImpl = fetch, sign }) {
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok, detail: redact(detail, url) })
  const guard = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      // undici says only "fetch failed" for DNS, TLS and refused connections
      // alike; the cause's code (ENOTFOUND, CERT_HAS_EXPIRED, …) carries no URL.
      const why = err?.cause?.code ?? err?.cause?.message
      const cause = why ? ` (${why})` : ''
      record(name, false, err?.name === 'AbortError' ? `no answer within ${TIMEOUT_MS / 1000}s` : `${err?.message ?? err}${cause}`)
    }
  }

  let chainId = null
  await guard('chain id', async () => {
    const r = await post(url, call(1, 'eth_chainId'), fetchImpl)
    if (r.status !== 200 || typeof r.body?.result !== 'string') return record('chain id', false, `HTTP ${r.status}: ${errText(r.body?.error ?? r.body)}`)
    const answered = Number.parseInt(r.body.result, 16)
    if (!Number.isSafeInteger(answered)) return record('chain id', false, `unreadable chain id ${JSON.stringify(r.body.result)}`)
    if (chain !== undefined && answered !== chain) return record('chain id', false, `chain ${answered}, expected ${chain} — wrong network for this variable`)
    chainId = answered
    record('chain id', true, `chain ${chainId}`)
  })

  await guard(`batch of ${batch}`, async () => {
    const r = await post(url, Array.from({ length: batch }, (_, i) => call(i + 1, 'eth_blockNumber')), fetchImpl)
    const items = Array.isArray(r.body) ? r.body : []
    const bad = items.find((x) => x?.error || typeof x?.result !== 'string')
    if (r.status !== 200 || items.length !== batch || bad) {
      return record(`batch of ${batch}`, false, `HTTP ${r.status}, ${items.length}/${batch} answered: ${errText(bad?.error ?? (Array.isArray(r.body) ? '' : r.body?.error ?? r.body))}`)
    }
    record(`batch of ${batch}`, true, `${batch}/${batch} answered`)
  })

  await guard('pending tag', async () => {
    const r = await post(url, call(1, 'eth_getTransactionCount', ['0x0000000000000000000000000000000000000001', 'pending']), fetchImpl)
    if (r.status !== 200 || typeof r.body?.result !== 'string') return record('pending tag', false, `HTTP ${r.status}: ${errText(r.body?.error ?? r.body)}`)
    record('pending tag', true, `nonce ${Number.parseInt(r.body.result, 16)}`)
  })

  await guard('send raw tx', async () => {
    if (chainId === null) return record('send raw tx', false, 'skipped: no chain id to sign for')
    const raw = await sign(chainId)
    const r = await post(url, call(1, 'eth_sendRawTransaction', [raw]), fetchImpl)
    const message = errText(r.body?.error ?? r.body)
    // Any status: a proxy may wrap the node's JSON-RPC error in an HTTP 400.
    if (r.body?.error && VALIDATED.test(message)) return record('send raw tx', true, `accepted and validated (${message})`)
    if (r.status === 200 && typeof r.body?.result === 'string') {
      return record('send raw tx', false, 'a zero-balance transaction was answered with a hash — no funds are at risk (the key is fresh, the tx a 0-value self-transfer), but a node that skips the balance check is not one to route writes through')
    }
    record('send raw tx', false, `HTTP ${r.status}: ${message}`)
  })

  const k = Math.min(Math.max(1, burst), MAX_BURST)
  await guard(`burst of ${k}`, async () => {
    const replies = await Promise.all(Array.from({ length: k }, (_, i) => post(url, call(i + 1, 'eth_blockNumber'), fetchImpl).catch((e) => ({ status: 0, body: { error: { message: e?.message ?? String(e) } } }))))
    const limited = replies.filter((r) => r.status === 429 || RATE_LIMITED.test(errText(r.body?.error)))
    const failed = replies.filter((r) => r.status !== 200 || typeof r.body?.result !== 'string')
    if (limited.length) return record(`burst of ${k}`, false, `${limited.length}/${k} rate-limited — a run fires more than this`)
    if (failed.length) return record(`burst of ${k}`, false, `${failed.length}/${k} failed: ${errText(failed[0].body?.error ?? failed[0].body)}`)
    record(`burst of ${k}`, true, `${k}/${k} answered`)
  })

  return results
}

/** Sign a zero-value self-transfer with a fresh random key: zero balance, so it can never be mined. */
export async function throwawaySign(chainId) {
  const { Wallet } = await import('ethers')
  const w = Wallet.createRandom()
  return w.signTransaction({ to: w.address, value: 0n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n, chainId, type: 2 })
}

/** Parse --batch/--burst/--chain strictly: a typo must not become a vacuous pass (NaN sends nothing). */
export function parseArgs(args) {
  const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const int = (flag, fallback, min, max) => {
    const raw = arg(flag)
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer from ${min} to ${max}, got '${raw}'`)
    return n
  }
  const url = arg('--url')
  if (!url) throw new Error('--url is required')
  const chainRaw = arg('--chain')
  if (chainRaw === undefined) throw new Error('--chain is required (84532 for Base Sepolia, 8453 for Base)')
  return {
    url,
    chain: int('--chain', undefined, 1, Number.MAX_SAFE_INTEGER),
    batch: int('--batch', DEFAULT_BATCH, 2, 100),
    burst: int('--burst', DEFAULT_BURST, 1, MAX_BURST),
  }
}

// Real paths on both sides: a symlinked path (macOS /tmp → /private/tmp) or a
// space in it must not skip the CLI and exit 0 — a silent pass for a required step.
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`rpc-conformance: ${err.message}`)
    console.error('usage: rpc-conformance.mjs --url <endpoint> --chain <id> [--batch 2..100] [--burst 1..50]  (the URL is never printed)')
    process.exit(2)
  }
  const results = await probe({ ...opts, sign: throwawaySign })
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(12)} ${r.detail}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `✗ ${failed} of ${results.length} check(s) failed — do not put this endpoint in a variable` : `✓ all ${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
