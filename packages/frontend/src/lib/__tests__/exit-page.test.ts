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
// A plain browser ES module served from public/; its types are inferred.
import * as exitCore from '../../../public/exit/exit-core.mjs'

const repo = path.resolve(process.cwd(), '../..')
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8')
const EXIT_DIR = 'packages/frontend/public/exit'
const CHAINS: Record<number, { manager: string; rpc: string; explorer: string }> = exitCore.CHAINS

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
    expect(Object.keys(CHAINS).map(Number).sort()).toEqual([8453, 84532])
    expect(exitCore.DEFAULT_CHAIN_ID).toBe(8453)
  })

  it("names the backend's pinned DelegationManager on each chain", () => {
    const src = read('packages/backend/src/rails/delegation-contracts.ts')
    for (const id of [8453, 84532]) {
      const block = src.match(new RegExp(`\\n  ${id}: \\{[\\s\\S]*?delegationManager: '(0x[0-9a-fA-F]{40})'`))
      expect(block, `no pin for ${id} in delegation-contracts.ts`).not.toBeNull()
      expect(CHAINS[id].manager).toBe(block![1])
    }
  })

  it('lists the same managers in docs/exit/README.md', () => {
    const readme = read('docs/exit/README.md')
    for (const id of [8453, 84532]) {
      expect(readme).toMatch(new RegExp(`\\(${id}\\) \\| \`${CHAINS[id].manager}\``))
    }
  })

  it('uses only public, keyless RPC endpoints by default', () => {
    for (const c of Object.values(CHAINS)) {
      expect(c.rpc).toMatch(/^https:\/\/(mainnet|sepolia)\.base\.org$/)
    }
  })

  // Both chains use the same manager address, so the RPC and explorer are what
  // tell them apart: each must belong to its own chain id.
  it('gives each chain its own RPC, and the explorer core names for it', () => {
    expect(CHAINS[8453].rpc).toBe('https://mainnet.base.org')
    expect(CHAINS[84532].rpc).toBe('https://sepolia.base.org')
    const core = read('packages/core/src/chains.ts')
    for (const id of [8453, 84532]) {
      const m = core.match(new RegExp(`chainId: ${id},[\\s\\S]*?explorerUrl: '([^']+)'`))
      expect(m, `no explorerUrl for ${id} in core chains.ts`).not.toBeNull()
      expect(CHAINS[id].explorer).toBe(m![1])
    }
  })
})

describe('exit page: chain identity is read, not assumed', () => {
  const answering = (answer: unknown) => ({
    send: async (method: string) => {
      expect(method).toBe('eth_chainId')
      if (answer instanceof Error) throw answer
      return answer
    },
  })

  // The refusal, or null when assertChain accepted the RPC.
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message)

  it('accepts an RPC that serves the selected chain', async () => {
    await expect(exitCore.assertChain(answering('0x2105'), 8453)).resolves.toBeUndefined()
    await expect(exitCore.assertChain(answering('0x14a34'), 84532)).resolves.toBeUndefined()
  })

  it('refuses a Base Sepolia RPC with Base selected, and the reverse', async () => {
    expect(await refusal(exitCore.assertChain(answering('0x14a34'), 8453))).toMatch(/serves chain 84532 \(Base Sepolia\), not Base \(8453\)/)
    expect(await refusal(exitCore.assertChain(answering('0x2105'), 84532))).toMatch(/serves chain 8453 \(Base\), not Base Sepolia/)
  })

  it('refuses when the chain id cannot be read', async () => {
    expect(await refusal(exitCore.assertChain(answering(new Error('rpc down')), 8453))).toMatch(/Could not read this RPC's chain id/)
  })

  it('the page checks the chain before every scan and check', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    expect(html).toContain('await assertChain(p, chainId())')
    // Both entry points get their manager only through checkedManager().
    expect(html.match(/const mgr = await checkedManager\(\)/g)).toHaveLength(2)
    expect(html).not.toMatch(/new Contract\([^)]*provider\(\)\)/)
  })
})

describe('exit page: delegation hash', () => {
  // Hash through toPlainDelegation, the path every scanned or pasted
  // delegation takes on the page.
  const pageHash = (del: unknown) => exitCore.delegationHash(exitCore.toPlainDelegation(del))

  it("equals the kit's hashDelegation, which Haven's backend uses", () => {
    const kit = hashDelegation({ ...sample, salt: BigInt(sample.salt) } as never)
    expect(pageHash(sample).toLowerCase()).toBe(kit.toLowerCase())
  })

  it('holds for a delegation with no caveats', () => {
    const del = { ...sample, caveats: [] }
    const kit = hashDelegation({ ...del, salt: BigInt(del.salt) } as never)
    expect(pageHash(del).toLowerCase()).toBe(kit.toLowerCase())
  })

  it('ignores signature and caveat args, as the contract does', () => {
    const other = {
      ...sample,
      signature: '0x01',
      caveats: sample.caveats.map((c) => ({ ...c, args: '0x99' })),
    }
    expect(exitCore.delegationHash(other)).toBe(exitCore.delegationHash(sample))
  })

  it('takes a salt as a string or bigint, never a lossy JSON number', () => {
    expect(pageHash({ ...sample, salt: 123456789n })).toBe(pageHash(sample))
    expect(() => exitCore.toPlainDelegation({ ...sample, salt: 2 ** 60 })).toThrow(/salt must be a string/)
  })

  it('matches the on-chain getDelegationHash for the sample (read 2026-10-24, Base Sepolia)', () => {
    // DelegationManager.getDelegationHash(sample without the second caveat),
    // eth_call on https://sepolia.base.org against 0xdb9B…7dB3.
    const oneCaveat = { ...sample, caveats: [sample.caveats[0]] }
    expect(pageHash(oneCaveat)).toBe(
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

  it('never shows an unknown status as not revoked', () => {
    const { active, unknown } = exitCore.STATUS_VIEW
    expect(unknown.label).not.toBe(active.label)
    expect(unknown.cls).not.toBe(active.cls)
    expect(exitCore.statusView('unknown')).toBe(unknown)
    for (const odd of [undefined, 'redeemed', 'toString', '__proto__']) {
      expect(exitCore.statusView(odd)).toBe(unknown)
    }
  })

  it('says a revoke can be undone only by the delegator', () => {
    expect(exitCore.STATUS_VIEW.revoked.note).toMatch(/Only the delegator account can undo this \(enableDelegation\)/)
  })
})

describe('exit page: what the owner sees', () => {
  const account = sample.delegator
  const answering = (answer: unknown) => ({
    disabledDelegations: async () => {
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  const show = async (del: unknown, answer: unknown, opts: { account?: string; onDetails?: () => void } = {}) => {
    const container = document.createElement('div')
    const row = await exitCore.showDelegation(container, exitCore.toPlainDelegation(del), {
      manager: answering(answer),
      account: opts.account ?? account,
      onDetails: opts.onDetails ?? (() => {}),
    })
    return { container, row, pill: row.querySelector('[data-pill]') as HTMLElement }
  }

  it('renders the status readStatus returns', async () => {
    for (const [answer, status] of [[false, 'active'], [true, 'revoked'], [new Error('rpc down'), 'unknown'], [undefined, 'unknown']] as const) {
      const { row, pill } = await show(sample, answer)
      const view = exitCore.STATUS_VIEW[status]
      expect(pill.textContent).toBe(view.label)
      expect(pill.className).toBe(`pill ${view.cls}`)
      expect(row.querySelector('[data-note]')!.textContent).toBe(view.note)
    }
  })

  // Hashing rejects a malformed address first, so render the row directly:
  // the row itself must never parse a field as HTML.
  it('renders delegation fields as text, never as HTML', () => {
    const tag = (n: number) => `<img data-x="${n}" src=x onerror="alert(1)">`
    const del = { ...sample, delegate: tag(1), delegator: tag(2), salt: tag(3) }
    for (const kind of ['root', 'child']) {
      const row = exitCore.delegationRow(document, del, { hash: tag(4), kind })
      expect(row.querySelector('img'), kind).toBeNull()
      expect(row.querySelector('[data-delegate]')!.textContent).toBe(`delegate ${tag(1)}`)
      expect(row.querySelector('[data-delegator]')!.textContent).toContain(tag(2))
      expect(row.querySelector('[data-salt]')!.textContent).toContain(tag(3))
      expect(row.querySelector('[data-hash]')!.textContent).toBe(`hash ${tag(4)}`)
    }
  })

  it("offers revocation details for the account's own budget", async () => {
    let called = 0
    const { row } = await show(sample, false, { onDetails: () => called++ })
    expect(row.dataset.kind).toBe('root')
    expect(row.querySelector('[data-child]')).toBeNull()
    ;(row.querySelector('[data-revoke]') as HTMLButtonElement).click()
    expect(called).toBe(1)
  })

  it("marks a child delegation and gives no calldata that would revert", async () => {
    const child = { ...sample, delegator: '0x3333333333333333333333333333333333333333', authority: exitCore.delegationHash(sample) }
    const { row } = await show(child, false)
    expect(row.dataset.kind).toBe('child')
    expect(row.querySelector('[data-revoke]')).toBeNull()
    expect(row.querySelector('[data-child]')!.textContent).toBe(exitCore.CHILD_NOTE)
    expect(exitCore.CHILD_NOTE).toMatch(/^Issued by your agent under one of your budgets — revoke that budget\./)
    expect(row.querySelector('[data-delegator]')!.textContent).toContain('(not your account)')
  })

  it('classifies by the account when given, by the authority when not, and lists root budgets first', () => {
    const child = { ...sample, delegator: '0x3333333333333333333333333333333333333333', authority: '0x' + '12'.repeat(32) }
    expect(exitCore.delegationKind(sample, account.toUpperCase().replace('0X', '0x'))).toBe('root')
    expect(exitCore.delegationKind(child, account)).toBe('child')
    expect(exitCore.delegationKind(sample, '')).toBe('root')
    expect(exitCore.delegationKind(child, '')).toBe('child')
    expect(exitCore.rootFirst([child, sample, child], account).map((d: { delegator: string }) => d.delegator)).toEqual([
      sample.delegator,
      child.delegator,
      child.delegator,
    ])
  })

  it('the page renders every delegation through showDelegation, root budgets first', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    expect(html.match(/await showDelegation\(/g)).toHaveLength(2)
    expect(html).toContain('for (const del of rootFirst(seen.values(), account))')
    expect(html).not.toMatch(/readStatus|STATUS_TEXT|data-pill/)
  })

  it('shows "Not revoked" in a warning tone, not the success green', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    expect(html).toMatch(/\.pill\.active \{[^}]*var\(--warn\)/)
    expect(html).not.toMatch(/--ok\b/)
  })
})

describe('exit page: event scan', () => {
  it('scans newest first, narrows to the range a provider names and covers every block once', async () => {
    const asked: Array<[number, number]> = []
    const queryRange = async (a: number, b: number) => {
      if (b - a + 1 > 200) throw new Error('eth_getLogs is limited to a 200 range')
      asked.push([a, b])
      return [`${a}-${b}`]
    }
    const r = await exitCore.scanEvents({ queryRange, fromBlock: 1000, toBlock: 1999, chunk: 5000 })
    expect(r).toMatchObject({ complete: true, chunk: 200, scannedFrom: 1000 })
    expect(asked).toEqual([[1800, 1999], [1600, 1799], [1400, 1599], [1200, 1399], [1000, 1199]])
  })

  it('spends the request cap on the newest blocks and says how far back it got', async () => {
    const queryRange = async () => []
    const r = await exitCore.scanEvents({ queryRange, fromBlock: 0, toBlock: 99_999, chunk: 100, maxRequests: 10 })
    expect(r).toMatchObject({ complete: false, reason: 'request-cap', scannedFrom: 99_000, requests: 10 })
  })

  it('reports an error it cannot narrow, without pretending to be complete', async () => {
    const queryRange = async () => {
      throw new Error('request limit reached')
    }
    const r = await exitCore.scanEvents({ queryRange, fromBlock: 0, toBlock: 10 })
    expect(r).toMatchObject({ complete: false, reason: 'error', scannedFrom: 11 })
  })
})

describe('exit page: no third-party script', () => {
  const VENDORED = `${EXIT_DIR}/vendor/ethers-6.16.0.min.js`

  // A static `from '…'`, a side-effect `import '…'`, a dynamic `import('…')`
  // or a <script src>, to an http(s) or protocol-relative (//) URL.
  const REMOTE = /(?:\bfrom|\bimport)\s*\(?\s*['"`](?:https?:)?\/\/|<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i

  it('recognises every form of remote import (positive controls)', () => {
    for (const line of [
      "import { x } from 'https://esm.sh/ethers@6'",
      "import 'https://esm.sh/ethers@6'",
      "await import('https://esm.sh/ethers@6')",
      "import x from '//esm.sh/ethers'",
      'export * from "http://cdn.example/x.js"',
      '<script src="https://cdn.example/x.js"></script>',
      '<script type="module" src=//cdn.example/x.js></script>',
    ]) {
      expect(line, line).toMatch(REMOTE)
    }
    expect("import { x } from './vendor/ethers-6.16.0.min.js'").not.toMatch(REMOTE)
  })

  it('imports ethers only from the vendored file, never a URL', () => {
    for (const file of ['index.html', 'exit-core.mjs']) {
      const src = read(`${EXIT_DIR}/${file}`)
      expect(src, file).not.toMatch(REMOTE)
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
