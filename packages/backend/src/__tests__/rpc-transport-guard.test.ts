/**
 * One helper builds every backend viem RPC transport (#3255).
 *
 * `infra/chain/rpc-transport.ts` is the failover transport. A client built
 * on a bare `http(<rpcUrl>)` somewhere else has no failover, and nothing at
 * runtime would notice until a provider's quota ran out. This reads source
 * text, as `chain-default-guard.test.ts` does, because the property is about
 * what every FUTURE writer does.
 *
 * What it checks, over every non-test `.ts` file under `src/`:
 *
 *   - a viem `http(` call appears only in the helper, or with a `bundlerUrl`
 *     argument (the Pimlico bundler, out of scope for #3255);
 *   - `http` is imported from `viem` only by the helper and the files that
 *     build bundler transports. This is what catches an ALIASED import
 *     (`import { http as t } from 'viem'`), which the call pattern cannot see;
 *   - `JsonRpcProvider(` is constructed only in `infra/relayer.ts`. #3255
 *     took option (b): the ethers relayer provider stays a single node,
 *     because the signing wallet's nonce view must never span two nodes
 *     (#1533);
 *   - no `webSocket(` transport exists.
 *
 * Accepted gaps: a call split as `http\n(` (whitespace before the paren); a
 * namespace import (`import * as viem from 'viem'` then `viem.http(url)`),
 * which neither the call pattern (it skips `.http(`) nor the named-import
 * check sees; a transport built with `custom(` or a local `fallback(`; and a
 * transport from `viem/_esm` or a re-export under another name.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const HELPER = 'infra/chain/rpc-transport.ts'
const RELAYER = 'infra/relayer.ts'
/** Files that may import viem's `http`: the helper, and the bundler builders. */
const HTTP_IMPORTERS = new Set([HELPER, 'rails/delegation-rail.ts'])

const HTTP_CALL = /(^|[^\w.])http\(/
const BUNDLER_ARG = /(^|[^\w.])http\([^)]*bundlerUrl/
const JSON_RPC_PROVIDER = /JsonRpcProvider\(/
const WEBSOCKET = /(^|[^\w.])webSocket\(/
/** A named import from 'viem' whose braces name `http`, aliased or not. */
const VIEM_HTTP_IMPORT = /import\s*\{[^}]*\bhttp\b[^}]*\}\s*from\s*['"]viem['"]/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const files = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join('/'),
  text: readFileSync(full, 'utf8'),
}))

function matchingLines(pattern: RegExp): Array<{ rel: string; line: string }> {
  return files.flatMap(({ rel, text }) =>
    text
      .split('\n')
      .filter((line) => pattern.test(line) && !/^\s*(\*|\/\/)/.test(line))
      .map((line) => ({ rel, line: line.trim() })),
  )
}

describe('every backend viem RPC transport goes through rpcTransport (#3255)', () => {
  it('the scan sees the files it must (positive controls)', () => {
    const rels = files.map((f) => f.rel)
    expect(rels).toContain(HELPER)
    expect(rels).toContain(RELAYER)
    // The pattern must find the bundler transports it permits, or a broken
    // pattern would pass vacuously.
    const bundler = matchingLines(BUNDLER_ARG)
    expect(bundler.length).toBeGreaterThan(0)
    // …and the helper's own http( call.
    expect(matchingLines(HTTP_CALL).some((m) => m.rel === HELPER)).toBe(true)
    expect(matchingLines(JSON_RPC_PROVIDER).some((m) => m.rel === RELAYER)).toBe(true)
  })

  it('no viem http( call outside the helper except a bundlerUrl transport', () => {
    const offenders = matchingLines(HTTP_CALL).filter(
      (m) => m.rel !== HELPER && !BUNDLER_ARG.test(m.line),
    )
    expect(offenders).toEqual([])
  })

  it('no file imports viem http except the helper and the bundler builders (catches aliasing)', () => {
    const importers = files.filter(({ text }) => VIEM_HTTP_IMPORT.test(text)).map((f) => f.rel)
    expect(importers.filter((rel) => !HTTP_IMPORTERS.has(rel))).toEqual([])
  })

  it('JsonRpcProvider is constructed only by the relayer (option b: single-node signing view)', () => {
    const offenders = matchingLines(JSON_RPC_PROVIDER).filter((m) => m.rel !== RELAYER)
    expect(offenders).toEqual([])
    expect(matchingLines(JSON_RPC_PROVIDER).filter((m) => m.rel === RELAYER)).toHaveLength(1)
  })

  it('the relayer wallet binds only to the primary; the broadcast fallback has one consumer (#2769)', () => {
    // relayer.ts holds two providers since #2769: the primary (the single
    // signing/nonce view) and the fallback that only re-sends signed bytes.
    // The wallet must never bind to the fallback, and only the outbound queue
    // may reach it.
    // A provider-bound wallet (two arguments); `new Wallet(key)` only signs.
    const wallets = matchingLines(/new Wallet\([^)]*,/)
    expect(wallets.map((m) => [m.rel, m.line.trim()])).toEqual([
      [RELAYER, 'relayer = new Wallet(key, getProvider(chainId))'],
    ])
    const consumers = files
      .filter(({ rel, text }) => rel !== RELAYER && /getFallbackBroadcastProvider/.test(text))
      .map((f) => f.rel)
    expect(consumers).toEqual(['infra/outbound-queue.ts'])
  })

  it('the disabledDelegations heal reader stays on the dedicated endpoint only', () => {
    // A false heal marks a row revoked without an owner signature (the kill
    // switch), so no failover node may answer it. Literal pin on the one call.
    const rail = files.find((f) => f.rel === 'rails/delegation-rail.ts')?.text ?? ''
    const reader = rail.slice(rail.indexOf('function makeDisabledDelegationReader'))
    expect(reader.length).toBeGreaterThan(0)
    const firstTransport = reader.match(/transport: rpcTransport\([^)]*\)/)?.[0]
    expect(firstTransport).toBe('transport: rpcTransport(chainId, { dedicatedOnly: true })')
  })

  it('no webSocket transport', () => {
    expect(matchingLines(WEBSOCKET)).toEqual([])
  })

  it('the patterns flag the shapes they exist to flag (self-test)', () => {
    expect(HTTP_CALL.test("transport: http(getChain(chainId).rpcUrl),")).toBe(true)
    expect(HTTP_CALL.test('  http(rpcUrl, { timeout })')).toBe(true)
    expect(HTTP_CALL.test('fetchhttp(x)')).toBe(false)
    expect(HTTP_CALL.test('client.http(x)')).toBe(false)
    expect(BUNDLER_ARG.test('bundlerTransport: http(cfg.bundlerUrl),')).toBe(true)
    expect(BUNDLER_ARG.test('transport: http(cfg.rpcUrl),')).toBe(false)
    expect(VIEM_HTTP_IMPORT.test("import { http as t, createPublicClient } from 'viem'")).toBe(true)
    expect(VIEM_HTTP_IMPORT.test("import {\n  createPublicClient,\n  http,\n} from 'viem'")).toBe(true)
    expect(VIEM_HTTP_IMPORT.test("import { httpish } from 'viem'")).toBe(false)
    expect(VIEM_HTTP_IMPORT.test("import { http } from 'wagmi'")).toBe(false)
  })
})
