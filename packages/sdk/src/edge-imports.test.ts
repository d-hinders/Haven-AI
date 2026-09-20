import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #3173: `@haven_ai/sdk/edge` exists so the local signer stops paying ~1 s of
 * module init for ethers, the x402 package and the HTTP client it never calls.
 * This walks the entry's relative import graph and fails the moment any file
 * in it imports one of the heavy packages — the guard that keeps the subpath
 * light as the barrel grows.
 */
const HEAVY = ['ethers', 'x402', '@modelcontextprotocol/sdk', './client.js', './provider.js', './receipt.js', './signer.js', './haven-api-transport.js', './mcp-merchant-transport.js', './merchant-completion.js', './x402-funding-leg.js']

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const out: string[] = []
  // Runtime graph only: `import type` / `export type` are erased by the
  // compiler and load nothing, so a type-only reference to a heavy package's
  // shapes is not a startup cost.
  for (const match of source.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+'([^']+)'/gms)) {
    if (/^(?:import|export)\s+type\b/.test(match[0])) continue
    out.push(match[1])
  }
  return out
}

function walk(entry: string): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>()
  const externals = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      else externals.add(spec)
    }
  }
  return { files, externals }
}

describe('@haven_ai/sdk/edge import graph (#3173)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const { files, externals } = walk(resolve(here, 'edge.ts'))

  it('reaches no heavy module — ethers, x402, the client or its transports', () => {
    const relative = [...files].map((f) => `./${f.slice(here.length + 1).replace(/\.ts$/, '.js')}`)
    for (const heavy of HEAVY) {
      expect(externals.has(heavy), `edge graph imports ${heavy}`).toBe(false)
      expect(relative.includes(heavy), `edge graph reaches ${heavy}`).toBe(false)
    }
  })

  it('its only runtime dependencies are viem and @noble/curves (and node built-ins)', () => {
    const runtime = [...externals].filter((e) => !e.startsWith('node:'))
    for (const e of runtime) expect(['viem', 'viem/accounts', '@noble/curves/secp256k1']).toContain(e)
  })

  it('positive control: the barrel DOES reach ethers, so the instrument can see it', () => {
    const barrel = walk(resolve(here, 'index.ts'))
    expect(barrel.externals.has('ethers')).toBe(true)
  })
})
