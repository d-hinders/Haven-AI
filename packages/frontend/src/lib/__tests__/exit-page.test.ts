/**
 * The independent exit page (#832, #4390): packages/frontend/public/exit/.
 *
 * It runs without Haven, so nothing else in the app exercises it. These tests
 * pin the three things it must get right: the contract it talks to on each
 * chain, the delegation hash the DelegationManager keys revocation on, and a
 * status that is read, never assumed. Plus: no third-party script.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain browser ES module served from public/, no types.
import * as exitCore from '../../../public/exit/exit-core.mjs'

const repo = path.resolve(process.cwd(), '../..')
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8')
const EXIT_DIR = 'packages/frontend/public/exit'

const sample = {
  delegate: '0x1111111111111111111111111111111111111111',
  delegator: '0x2222222222222222222222222222222222222222',
  authority: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  caveats: [
    { enforcer: '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB', terms: '0x1234', args: '0xbeef' },
    { enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069', terms: '0x', args: '0x' },
  ],
  salt: '123456789',
  signature: '0xdead',
}

describe('exit page: pinned contracts', () => {
  it('covers Base and Base Sepolia, defaulting to Base', () => {
    expect(Object.keys(exitCore.CHAINS).map(Number).sort()).toEqual([8453, 84532])
    expect(exitCore.DEFAULT_CHAIN_ID).toBe(8453)
  })

  it("names the backend's pinned DelegationManager on each chain", () => {
    const src = read('packages/backend/src/rails/delegation-contracts.ts')
    for (const id of [8453, 84532]) {
      const block = src.match(new RegExp(`\\n  ${id}: \\{[\\s\\S]*?delegationManager: '(0x[0-9a-fA-F]{40})'`))
      expect(block, `no pin for ${id} in delegation-contracts.ts`).not.toBeNull()
      expect(exitCore.CHAINS[id].manager).toBe(block![1])
    }
  })

  it('lists the same managers in docs/exit/README.md', () => {
    const readme = read('docs/exit/README.md')
    for (const id of [8453, 84532]) {
      expect(readme).toMatch(new RegExp(`\\(${id}\\) \\| \`${exitCore.CHAINS[id].manager}\``))
    }
  })

  it('uses only public, keyless RPC endpoints by default', () => {
    for (const c of Object.values(exitCore.CHAINS) as Array<{ rpc: string }>) {
      expect(c.rpc).toMatch(/^https:\/\/(mainnet|sepolia)\.base\.org$/)
    }
  })
})

describe('exit page: delegation hash', () => {
  it("equals the kit's hashDelegation, which Haven's backend uses", () => {
    const kit = hashDelegation({ ...sample, salt: BigInt(sample.salt) } as never)
    expect(exitCore.delegationHash(sample).toLowerCase()).toBe(kit.toLowerCase())
  })

  it('holds for a delegation with no caveats', () => {
    const del = { ...sample, caveats: [] }
    const kit = hashDelegation({ ...del, salt: BigInt(del.salt) } as never)
    expect(exitCore.delegationHash(del).toLowerCase()).toBe(kit.toLowerCase())
  })

  it('ignores signature and caveat args, as the contract does', () => {
    const other = {
      ...sample,
      signature: '0x01',
      caveats: sample.caveats.map((c) => ({ ...c, args: '0x99' })),
    }
    expect(exitCore.delegationHash(other)).toBe(exitCore.delegationHash(sample))
  })

  it('matches the on-chain getDelegationHash for the sample (read 2026-10-24, Base Sepolia)', () => {
    // DelegationManager.getDelegationHash(sample without the second caveat),
    // eth_call on https://sepolia.base.org against 0xdb9B…7dB3.
    const oneCaveat = { ...sample, caveats: [sample.caveats[0]] }
    expect(exitCore.delegationHash(oneCaveat)).toBe(
      '0x8e19df1c27c5f628bbf7973d48b0624ff4beeba0e178e95aa1c040a0c44d6a2e',
    )
  })
})

describe('exit page: status is read, never assumed', () => {
  const hash = exitCore.delegationHash(sample)
  const managerAnswering = (answer: unknown) => ({
    disabledDelegations: async (h: string) => {
      expect(h).toBe(hash)
      return answer
    },
  })

  it('reads active, then revoked, from disabledDelegations', async () => {
    expect(await exitCore.readStatus(managerAnswering(false), hash)).toBe('active')
    expect(await exitCore.readStatus(managerAnswering(true), hash)).toBe('revoked')
  })

  it('answers unknown when the read fails or is not a boolean', async () => {
    const failing = {
      disabledDelegations: async () => {
        throw new Error('rpc down')
      },
    }
    expect(await exitCore.readStatus(failing, hash)).toBe('unknown')
    expect(await exitCore.readStatus(managerAnswering(undefined), hash)).toBe('unknown')
  })

  it('the page renders status through readStatus, with no hard-coded pill', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    expect(html).toContain('await readStatus(mgr, hash)')
    expect(html).not.toMatch(/textContent = 'redeemed'/)
  })
})

describe('exit page: event scan', () => {
  it('narrows to the range a provider names and covers every block once', async () => {
    const asked: Array<[number, number]> = []
    const queryRange = async (a: number, b: number) => {
      if (b - a + 1 > 200) throw new Error('eth_getLogs is limited to a 200 range')
      asked.push([a, b])
      return [`${a}-${b}`]
    }
    const r = await exitCore.scanEvents({ queryRange, fromBlock: 1000, toBlock: 1999, chunk: 5000 })
    expect(r.complete).toBe(true)
    expect(r.chunk).toBe(200)
    expect(asked[0]).toEqual([1000, 1199])
    expect(asked.at(-1)).toEqual([1800, 1999])
    expect(asked).toHaveLength(5)
  })

  it('stops at the request cap and says how far it got', async () => {
    const queryRange = async () => []
    const r = await exitCore.scanEvents({ queryRange, fromBlock: 0, toBlock: 99_999, chunk: 100, maxRequests: 10 })
    expect(r).toMatchObject({ complete: false, reason: 'request-cap', scannedTo: 999, requests: 10 })
  })

  it('reports an error it cannot narrow, without pretending to be complete', async () => {
    const queryRange = async () => {
      throw new Error('request limit reached')
    }
    const r = await exitCore.scanEvents({ queryRange, fromBlock: 0, toBlock: 10 })
    expect(r).toMatchObject({ complete: false, reason: 'error', scannedTo: -1 })
  })
})

describe('exit page: no third-party script', () => {
  const VENDORED = `${EXIT_DIR}/vendor/ethers-6.16.0.min.js`

  it('imports ethers only from the vendored file, never a URL', () => {
    for (const file of ['index.html', 'exit-core.mjs']) {
      const src = read(`${EXIT_DIR}/${file}`)
      expect(src, file).not.toMatch(/from\s+['"]https?:/)
      expect(src, file).not.toMatch(/<script[^>]+src=["']https?:/)
    }
    expect(read(`${EXIT_DIR}/exit-core.mjs`)).toContain("from './vendor/ethers-6.16.0.min.js'")
    expect(read(`${EXIT_DIR}/index.html`)).toContain("from './vendor/ethers-6.16.0.min.js'")
  })

  it('vendors the npm ethers 6.16.0 build byte for byte below its notice', () => {
    const src = read(VENDORED)
    const end = src.indexOf('\n */\n')
    expect(end).toBeGreaterThan(0)
    expect(src.slice(0, end)).toContain('MIT License')
    const body = src.slice(end + '\n */\n'.length)
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      '2cf48c79d5f9136499527d43e5dc662071d41a000fd822de105533ab7502e950',
    )
    expect(body).toContain('const version="6.16.0"')
  })
})
