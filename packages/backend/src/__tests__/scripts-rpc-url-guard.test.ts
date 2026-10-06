// `packages/backend/scripts/**` is outside the backend tsconfig (`include:
// ["src"]`), so the compiler cannot see a script reading a field the chain
// shape no longer has. #3671 removed `rpcUrl` from the known `ChainConfig`, and
// `scripts/check-delegation-contracts.ts` — the mainnet canary's pinned-bytecode
// check — kept `const { rpcUrl } = getChain(chainId)` and would have exited 1 on
// every run (review finding on PR #3671). Scripts resolve RPC through
// `rpcUrlForChain`, which answers only for supported chains.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPTS = fileURLToPath(new URL('../../scripts', import.meta.url))

function scriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return scriptFiles(path)
    return /\.(ts|mts|js|mjs)$/.test(name) ? [path] : []
  })
}

// `getChain(x).rpcUrl` and `const { rpcUrl } = getChain(x)`, the two shapes a
// script would use to read an RPC URL off the chain config.
export const CHAIN_RPC_READ = /getChain\([^)]*\)\s*\.\s*rpcUrl|\{[^}]*\brpcUrl\b[^}]*\}\s*=\s*getChain\(/

describe('backend scripts never read an RPC URL off the chain config (#3671)', () => {
  it('the pattern catches both read shapes and passes the supported accessor', () => {
    expect(CHAIN_RPC_READ.test('const { rpcUrl } = getChain(chainId)')).toBe(true)
    expect(CHAIN_RPC_READ.test('fetch(getChain(8453).rpcUrl)')).toBe(true)
    expect(CHAIN_RPC_READ.test('const rpcUrl = rpcUrlForChain(chainId)')).toBe(false)
  })

  it('no file under packages/backend/scripts matches', () => {
    const files = scriptFiles(SCRIPTS)
    expect(files.some((f) => f.endsWith('check-delegation-contracts.ts'))).toBe(true)
    const offenders = files.filter((f) => CHAIN_RPC_READ.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
