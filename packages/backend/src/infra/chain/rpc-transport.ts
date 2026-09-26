/**
 * The ONE place a backend viem RPC transport is built (#3255).
 *
 * Every backend public client used to sit on a single `http(<rpcUrl>)`. viem's
 * `http()` retries 429/5xx and JSON-RPC 429/-32005/-32603 three times, but
 * always against the SAME URL, so a dedicated provider that hit its monthly
 * quota failed every prepare, deploy check and enforcer read behind it, even
 * with a public node available. This builds a viem `fallback()` over:
 *
 *   1. the dedicated endpoint (`RPC_URL_BASE` / `RPC_URL_BASE_SEPOLIA`, or the
 *      public node when those are unset — `config.ts` `warnPublicRpc`);
 *   2. the optional second provider (`RPC_URL_BASE_FALLBACK` /
 *      `RPC_URL_BASE_SEPOLIA_FALLBACK`);
 *   3. the public node (`PUBLIC_RPC_BASE` / `PUBLIC_RPC_BASE_SEPOLIA`).
 *
 * De-duplicated in that order, so an unset dedicated variable (which already
 * resolves to the public node) does not list the public node twice. Chains
 * with no public node here (Gnosis, chain 100) get their one endpoint.
 *
 * ## What falls through and what does not
 *
 * A transport failure (HTTP 429/5xx, a JSON-RPC error such as a quota
 * message returned with HTTP 200, a timeout) moves to the next endpoint. An
 * `eth_call` REVERT does not: a revert is the chain's answer, and asking a
 * second node would only repeat it, or worse, get a different answer from a
 * lagging one. viem's default `shouldThrow` already treats a message matching
 * `execution reverted` as terminal; `havenShouldThrow` wraps it and also
 * treats JSON-RPC `code: 3` (EIP-1474 execution error) as terminal, for
 * providers that phrase reverts differently.
 *
 * Inside `fallback()` each leg runs with `retryCount: 0` (viem forces it), so
 * the dedicated URL no longer gets its three same-URL retries: one transient
 * 429 moves straight to the next node. The retries that remain are the
 * fallback's own, over the whole chain (`retryCount`, viem default 3).
 *
 * ## Consistency
 *
 * Endpoints are tried per REQUEST, not per pass. A lagging fallback node
 * answers a fresh deploy's `getCode` with `0x` and a nonce read with the
 * pre-inclusion value rather than failing. Both fail safe, at a cost in
 * relayer gas and never in funds: a stale nonce is refused by the bundler, and
 * `ensureHybridDeployed`'s deploy either reverts or, when the signer set has
 * changed since provisioning (#891), deploys a spurious account at the address
 * the current signers derive, after which activation refuses on the address
 * mismatch.
 *
 * The `disabledDelegations` heal is the exception: a false positive marks a
 * row revoked without an owner signature, so it is not fail-safe against a
 * LYING node. It passes `dedicatedOnly` and keeps its pre-#3255 trust set; a
 * failed heal read already degrades to the full revoke batch. The ethers
 * relayer provider and its log scanners are deliberately NOT routed through
 * this (see `infra/relayer.ts`): the signing wallet's nonce view must stay on
 * one node (#1533).
 *
 * ## Residual risk
 *
 * No circuit breaker or ranking: a quota-dead primary is asked first on every
 * request (one fast refusal), and a SLOW primary costs a full per-leg timeout
 * (viem default 10 s) on every request before failover. With every node
 * hanging, a default caller's worst case is 4 passes × legs × 10 s plus
 * backoff, against 4 × 10 s on one node before. Callers that need a bound pass
 * `timeout` and `retryCount` (the budget reader does).
 *
 * Endpoint URLs can carry provider API keys. This module never logs them, and
 * since #3371 it does not let them leave inside an error either: the transport
 * it returns wraps viem's `request` and scrubs every configured endpoint's
 * key-like segments out of a transport error in place (`scrubTransportErrorSecrets`)
 * — viem's request errors carry the URL in `message`, `metaMessages`, `details`,
 * `shortMessage`, `stack` and a raw enumerable `url`, and viem's own `getUrl`
 * strips only `user:password`, so a key in the path or query survives otherwise.
 */
import { fallback, http, shouldThrow as viemShouldThrow, type Transport } from 'viem'
import {
  config,
  PUBLIC_RPC_BASE,
  PUBLIC_RPC_BASE_SEPOLIA,
} from '../../config.js'
import { getChain } from '../../domain/chains.js'

/**
 * The optional second provider per chain (`RPC_URL_BASE_FALLBACK` /
 * `RPC_URL_BASE_SEPOLIA_FALLBACK`). Empty string = not configured. Also the
 * relayer's broadcast fallback when the primary refuses a raw send (#2769).
 */
export function secondaryRpcUrl(chainId: number): string {
  if (chainId === 8453) return config.rpcUrlBaseFallback
  if (chainId === 84532) return config.rpcUrlBaseSepoliaFallback
  return ''
}

function publicRpcUrl(chainId: number): string {
  if (chainId === 8453) return PUBLIC_RPC_BASE
  if (chainId === 84532) return PUBLIC_RPC_BASE_SEPOLIA
  return ''
}

/** The endpoints `rpcTransport` tries, in order, de-duplicated. */
export function rpcEndpoints(chainId: number): string[] {
  const ordered = [getChain(chainId).rpcUrl, secondaryRpcUrl(chainId), publicRpcUrl(chainId)]
  return [...new Set(ordered.filter((url) => url !== ''))]
}

/**
 * The key-like pieces of an endpoint URL — path segments and query values of
 * 12+ characters (#3371). The shared helper behind this module's transport
 * scrub and `infra/relayer.ts`'s `keySegments` / `infra/outbound-queue.ts`'s
 * `secretSegments` (#2769, #3365): a provider that echoes its key WITHOUT the
 * URL (say `dkey=<key>` in a JSON-RPC message) is still scrubbed. It lives
 * here because `relayer.ts` already imports this file (`secondaryRpcUrl`) and
 * this file must stay below both in the provider graph — a third private copy
 * was one more place for the 12+ heuristic to drift.
 */
export function secretSegments(url: string): string[] {
  return url.split(/[/?&=#]/).filter((part) => part.length >= 12 && !part.includes(':'))
}

const REDACTED = '<redacted>'

/**
 * Scrub every configured endpoint's key-like segments out of a viem RPC
 * transport error IN PLACE (`err: E`, returns the same instance): `message`,
 * `stack`, `metaMessages`, `details`, `shortMessage`, the raw enumerable
 * `url`, and every string inside nested plain-object/array own properties
 * (`data`, a JSON-RPC `error` body), walked down the `.cause` chain (#3371).
 *
 * Class identity, `status`, `headers`, `code` and non-scrubbed `data` shapes
 * are preserved — this is load-bearing: viem's retry logic branches on
 * `instanceof HttpRequestError` and turns any non-`BaseError` into a
 * retryable `UnknownRpcError`, so REBUILDING the error (the ethers-side
 * `scrubRpcUrlError` approach, #3365) would turn a terminal 401 into four
 * attempts and a terminal `eth_call` revert into a retried one.
 */
export function scrubTransportErrorSecrets<E extends Error>(err: E, urls: string[]): E {
  const secrets = urls.flatMap(secretSegments)
  const scrub = (text: string): string =>
    secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), text)

  const scrubValue = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value)
    if (Array.isArray(value)) return value.map(scrubValue)
    if (value !== null && typeof value === 'object') {
      for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
        ;(value as Record<string, unknown>)[key] = scrubValue(member)
      }
    }
    return value
  }

  let current: unknown = err
  const causes = new Set<unknown>()
  while (current instanceof Error && !causes.has(current)) {
    causes.add(current)
    const target = current as unknown as Record<string, unknown>
    for (const prop of ['message', 'stack', 'shortMessage', 'details'] as const) {
      if (typeof target[prop] === 'string') target[prop] = scrub(target[prop] as string)
    }
    for (const [key, value] of Object.entries(target)) {
      if (key === 'cause' || key === 'request' || key === 'response') continue
      target[key] = scrubValue(value)
    }
    current = target.cause
  }
  return err
}

/** JSON-RPC `code: 3` is the EIP-1474 execution error: an `eth_call` revert. */
export function havenShouldThrow(error: Error): boolean {
  if (viemShouldThrow(error)) return true
  return 'code' in error && error.code === 3
}

export interface RpcTransportOptions {
  /**
   * Use ONLY the dedicated endpoint, with no failover. For a read that is not
   * fail-safe when a node lies: the `disabledDelegations` heal marks a row
   * revoked without an owner signature, so widening the set of nodes that can
   * answer it would widen the set that can defeat the kill switch.
   */
  dedicatedOnly?: boolean
  /** Per-LEG timeout in ms (viem `http` default 10_000). */
  timeout?: number
  /** Retries of the WHOLE chain after every leg failed (viem default 3). */
  retryCount?: number
}

export function rpcTransport(chainId: number, opts: RpcTransportOptions = {}): Transport {
  const urls = opts.dedicatedOnly ? rpcEndpoints(chainId).slice(0, 1) : rpcEndpoints(chainId)
  const legs = urls.map((url) =>
    http(url, opts.timeout === undefined ? {} : { timeout: opts.timeout }),
  )
  // #3371: the scrub wraps the transport's `request` — OUTSIDE `fallback()`, so
  // the error is cleaned only after viem's failover/retry logic has classified
  // it, and never via viem `custom()`, which would add its own retryCount:3
  // layer and multiply retries. viem's own error instances are mutated in place
  // and rethrown unchanged, so every `instanceof` classification downstream is
  // untouched; only the key-bearing strings are replaced.
  return (args) => {
    const inner = fallback(legs, {
      shouldThrow: havenShouldThrow,
      ...(opts.retryCount === undefined ? {} : { retryCount: opts.retryCount }),
    })(args)
    const request: typeof inner.request = async (...requestArgs) => {
      try {
        return await inner.request(...requestArgs)
      } catch (err) {
        throw scrubTransportErrorSecrets(err as Error, urls)
      }
    }
    return { ...inner, request }
  }
}
