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
import { Interface } from '../../../public/exit/vendor/ethers-6.16.0.min.js'
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

  // The refusal's message, or 'accepted' when assertChain let the RPC through.
  const refusal = (p: Promise<unknown>) => p.then(() => 'accepted', (e: Error) => e.message)

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

  it('refuses an answer that is not a chain id, with a clear message', async () => {
    for (const odd of [undefined, null, 'abc', '0x', 8453]) {
      expect(await refusal(exitCore.assertChain(answering(odd), 8453)), String(odd)).toMatch(/answered eth_chainId with .*, not a chain id; nothing was checked/)
    }
  })

  it('checkedManager reads only through the provider whose chain it checked', async () => {
    // A wrongly refused provider fails here by assertion, not by a throw.
    type Checked = { runner?: unknown; target?: unknown; refused?: string }
    const accepted = (p: Promise<unknown>): Promise<Checked> =>
      p.then((m) => m as Checked, (e: Error) => ({ refused: e.message }))
    const good = answering('0x2105')
    const mgr = await accepted(exitCore.checkedManager(good, 8453))
    expect(mgr).not.toHaveProperty('refused')
    expect(mgr.runner).toBe(good)
    expect(mgr.target).toBe(CHAINS[8453].manager)
    expect(await refusal(exitCore.checkedManager(answering('0x14a34'), 8453))).toMatch(/serves chain 84532/)
    expect(await refusal(exitCore.checkedManager(answering(new Error('rpc down')), 8453))).toMatch(/Could not read this RPC's chain id/)
    // It checks the chain it is given, not the default: Base Sepolia selected.
    const sepolia = answering('0x14a34')
    const onSepolia = await accepted(exitCore.checkedManager(sepolia, 84532))
    expect(onSepolia).not.toHaveProperty('refused')
    expect(onSepolia.runner).toBe(sepolia)
    expect(onSepolia.target).toBe(CHAINS[84532].manager)
    expect(await refusal(exitCore.checkedManager(answering('0x2105'), 84532))).toMatch(/serves chain 8453 \(Base\), not Base Sepolia/)
  })

  it('the page checks the chain before every scan and check', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    // Both entry points get their manager only through core's checkedManager,
    // on the one JSON-RPC provider the page builds. The only other provider is
    // the wallet's, built in the Connect handler to show the signer, and no
    // contract is ever re-connected to it.
    expect(html.match(/const mgr = await checkedManager\(provider\(\), chainId\(\)\)/g)).toHaveLength(2)
    expect(html.match(/checkedManager\(/g)).toHaveLength(2)
    expect(html).not.toMatch(/new Contract\(|\bContract\b.*from '\.\/vendor/)
    expect(html.match(/new JsonRpcProvider\(/g)).toHaveLength(1)
    expect(html).toMatch(/function provider\(\) \{ return new JsonRpcProvider\(/)
    expect(html.match(/new BrowserProvider\(/g)).toHaveLength(1)
    expect(html).toMatch(/\$\('connect'\)\.onclick = async \(\) => \{\n[^\n]*\n  const bp = new BrowserProvider\(window\.ethereum\)\n/)
    expect(html.match(/new \w*Provider\(/g)).toHaveLength(2)
    expect(html).not.toMatch(/\.connect\(|getDefaultProvider/)
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

  it('encodes disableDelegation calldata for the same delegation', () => {
    const iface = new Interface(exitCore.MANAGER_ABI)
    const del = exitCore.toPlainDelegation(sample)
    const data = exitCore.disableDelegationCalldata(iface, del)
    expect(data.slice(0, 10)).toBe('0x49934047')
    expect(iface.getFunction('disableDelegation')!.selector).toBe('0x49934047')
    const [decoded] = iface.decodeFunctionData('disableDelegation', data)
    const back = {
      delegate: decoded.delegate,
      delegator: decoded.delegator,
      authority: decoded.authority,
      caveats: decoded.caveats.map((c: { enforcer: string; terms: string; args: string }) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
      salt: decoded.salt.toString(),
      signature: decoded.signature,
    }
    expect(exitCore.delegationHash(back)).toBe(exitCore.delegationHash(del))
    expect(back).toEqual({ ...del, delegate: decoded.delegate, delegator: decoded.delegator })
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
  const show = async (del: unknown, answer: unknown, opts: { account?: string; onDetails?: () => void; source?: string } = {}) => {
    const container = document.createElement('div')
    const row = await exitCore.showDelegation(container, exitCore.toPlainDelegation(del), {
      manager: answering(answer),
      account: opts.account ?? account,
      onDetails: opts.onDetails ?? (() => {}),
      ...(opts.source ? { source: opts.source } : {}),
    })
    return { container, row, pill: row.querySelector('[data-pill]') as HTMLElement }
  }

  it('renders the status readStatus returns', async () => {
    for (const [answer, status] of [[false, 'active'], [true, 'revoked'], [new Error('rpc down'), 'unknown'], [undefined, 'unknown']] as const) {
      const { row, pill } = await show(sample, answer)
      const view = exitCore.STATUS_VIEW[status]
      expect(pill.textContent).toBe(view.label)
      expect(pill.className).toBe(`pill ${view.cls}`)
      expect(row.querySelector('[data-note]')?.textContent).toBe(view.note)
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
      expect(row.querySelector('[data-delegate]')?.textContent).toBe(`delegate ${tag(1)}`)
      expect(row.querySelector('[data-delegator]')?.textContent).toContain(tag(2))
      expect(row.querySelector('[data-salt]')?.textContent).toContain(tag(3))
      expect(row.querySelector('[data-hash]')?.textContent).toBe(`hash ${tag(4)}`)
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

  const child = { ...sample, delegator: '0x3333333333333333333333333333333333333333', authority: exitCore.delegationHash(sample) }

  it("marks a child delegation and gives no calldata that would revert", async () => {
    const { row } = await show(child, false)
    expect(row.dataset.kind).toBe('child')
    expect(row.querySelector('[data-revoke]')).toBeNull()
    expect(row.querySelector('[data-child]')?.textContent).toBe(exitCore.CHILD_NOTE)
    expect(exitCore.CHILD_NOTE).toMatch(/^Issued by your agent under one of your budgets — revoke that budget\./)
    expect(row.querySelector('[data-delegator]')?.textContent).toContain('(your agent)')
  })

  it('never tells the owner a child still has authority of its own', async () => {
    const { row } = await show(child, false)
    const note = row.querySelector('[data-note]')?.textContent
    expect(note).toBe(exitCore.CHILD_ACTIVE_NOTE)
    expect(note).not.toBe(exitCore.STATUS_VIEW.active.note)
    expect(note).toMatch(/^Not revoked on its own; it stops when the budget it was issued under is revoked/)
    // A revoked or unknown child shows the ordinary note.
    expect((await show(child, true)).row.querySelector('[data-note]')?.textContent).toBe(exitCore.STATUS_VIEW.revoked.note)
  })

  // A pasted child may not be under this account's budget at all, and there is
  // no budget row beside it: its copy claims no ownership and points to the
  // budget it was issued under.
  it('tells a pasted child to revoke the budget it was issued under, claiming no owner', async () => {
    for (const acct of [account, '0x4444444444444444444444444444444444444444', '']) {
      const { row } = await show(child, false, { account: acct, source: 'paste' })
      expect(row.dataset.kind).toBe('child')
      expect(row.querySelector('[data-revoke]')).toBeNull()
      expect(row.querySelector('[data-child]')?.textContent).toBe(exitCore.PASTED_CHILD_NOTE)
      expect(row.querySelector('[data-note]')?.textContent).toBe(exitCore.PASTED_CHILD_ACTIVE_NOTE)
      const text = row.textContent ?? ''
      expect(text, acct).not.toMatch(/your agent|your budgets|that budget's row/i)
      expect(text).toContain('revoke the budget it was issued under')
    }
    expect(exitCore.PASTED_CHILD_ACTIVE_NOTE).toMatch(/^Not revoked on its own; it stops when the budget it was issued under is revoked\.$/)
    expect(read(`${EXIT_DIR}/index.html`)).toMatch(/await showDelegation\(\$\('pasted'\), del, \{[^}]*source: 'paste' \}\)/)
  })

  // Connect wallet gives the owner's signer (an EOA); a Haven account is a
  // smart account. A root budget pasted with that address entered is still a
  // root budget: it says it is not this account's, and keeps its details.
  it("keeps a root budget a root when the entered account is another address", async () => {
    const eoa = '0x4444444444444444444444444444444444444444'
    const { row } = await show(sample, false, { account: eoa })
    expect(row.dataset.kind).toBe('root')
    expect(row.querySelector('[data-child]')).toBeNull()
    expect(row.querySelector('[data-revoke]')).not.toBeNull()
    expect(row.querySelector('[data-foreign]')?.textContent).toBe(exitCore.FOREIGN_NOTE)
    expect(exitCore.FOREIGN_NOTE).toMatch(/^Not this account's budget/)
    expect(row.querySelector('[data-delegator]')?.textContent).toContain('(not this account)')
    expect(row.querySelector('[data-note]')?.textContent).toBe(exitCore.STATUS_VIEW.active.note)
    // With the right account, or none, there is no such marker.
    expect((await show(sample, false, { account })).row.querySelector('[data-foreign]')).toBeNull()
    expect((await show(sample, false, { account: '' })).row.querySelector('[data-foreign]')).toBeNull()
  })

  it('classifies by the authority alone, and lists root budgets first', () => {
    const other = { ...child, delegator: account }
    expect(exitCore.delegationKind(sample)).toBe('root')
    expect(exitCore.delegationKind(child)).toBe('child')
    expect(exitCore.delegationKind(other)).toBe('child')
    expect(exitCore.isAccountsBudget(sample, account.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(exitCore.isAccountsBudget(sample, '0x4444444444444444444444444444444444444444')).toBe(false)
    expect(exitCore.isAccountsBudget(sample, '')).toBe(true)
    expect(exitCore.rootFirst([child, sample, other]).map((d: { authority: string }) => exitCore.delegationKind(d))).toEqual(['root', 'child', 'child'])
  })

  it('the page renders every delegation through showDelegation, root budgets first', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    expect(html.match(/await showDelegation\(/g)).toHaveLength(2)
    expect(html).toContain('for (const del of rootFirst(seen.values()))')
    expect(html).not.toMatch(/readStatus|STATUS_TEXT|data-pill/)
  })

  it('never fills the account field with the connected wallet', () => {
    const html = read(`${EXIT_DIR}/index.html`)
    // No write of any form (=, ||=, &&=, ??=); every use of the field reads it.
    expect(html).not.toMatch(/\$\('account'\)\.value\s*(?:\|\||&&|\?\?)?=(?!=)/)
    const uses = html.match(/\$\('account'\)[^\n]{0,20}/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(use, use).toMatch(/^\$\('account'\)\.value\.trim\(\)/)
    expect(html).not.toMatch(/getElementById\(['"]account['"]\)|#account/)
    expect(html).toContain('Connected signer ${ownerAddr}')
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

  it('refuses a from block after the latest block', async () => {
    const r = await exitCore.scanEvents({ queryRange: async () => [], fromBlock: 10, toBlock: 5 }).then(
      () => 'scanned',
      (e: Error) => e.message,
    )
    expect(r).toBe('The from block (10) is after the latest block (5).')
  })

  it('says older budgets were not searched when the scan stops early', async () => {
    const capped = await exitCore.scanEvents({ queryRange: async () => [], fromBlock: 0, toBlock: 99_999, chunk: 100, maxRequests: 10 })
    const text = exitCore.scanSummary(capped, 99_999, 2)
    expect(text).toMatch(/^Scanned the newest blocks 99000–99999 only\. This RPC allows 100 blocks per query, so the page stopped after 10 queries\. Older budgets were not searched: /)
    expect(text).toMatch(/2 delegation\(s\) found so far\.$/)
    const failed = exitCore.scanSummary({ complete: false, reason: 'error', error: 'boom', scannedFrom: 11, requests: 1, chunk: 50_000 }, 10, 0)
    expect(failed).toContain('The RPC refused a query: boom. Older budgets were not searched')
    const done = await exitCore.scanEvents({ queryRange: async () => [], fromBlock: 0, toBlock: 99, chunk: 100 })
    expect(exitCore.scanSummary(done, 99, 0)).toMatch(/^No redeemed delegations found for this account in blocks 0–99\./)
    expect(exitCore.scanSummary(done, 99, 3)).toBe('3 delegation(s) found in blocks 0–99.')
    expect(read(`${EXIT_DIR}/index.html`)).toContain("$('scanStatus').textContent = scanSummary(result, latest, seen.size)")
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
