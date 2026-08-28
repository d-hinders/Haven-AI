/**
 * The screenshot harness can tell "the data came back empty" apart from "the
 * data never came" (#1971).
 *
 * ── Why this is a vitest file and not only a CLI check ───────────────────────
 *
 * `screenshot.mjs` is an on-demand CLI that no CI job runs, so a guard that
 * lives only inside it has no gate — the exact hole #1886 closed for the clip
 * guard by moving it into a testable module. The same reasoning applies here
 * with more force: the defect this guard exists to catch went undetected for the
 * entire life of the harness precisely BECAUSE nothing failed. A guard against a
 * silent failure that is itself only checked when a human happens to run the CLI
 * is a guard with the same shape as the bug.
 *
 * ── What the guard is for ────────────────────────────────────────────────────
 *
 * `CHAIN_READ_GAPS` (#1935) catches "the app asked and the fixture had no
 * answer". It structurally cannot catch #1971, because that failure produces no
 * request: `@wagmi/core`'s `getClient` catches `ChainNotConfiguredError` and
 * returns `undefined`, so `usePublicClient` is `undefined` and every consumer
 * returns at its first line. No request, no error, no visible failure — a
 * photogenic PNG of the empty branch. `CHAIN_SILENT_CAPTURES` is the other half:
 * a capture that VISITED a chain-fed route and observed ZERO chain reads.
 */
import { beforeEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script
import {
  CHAIN_FED_ROUTES,
  CHAIN_SILENT_CAPTURES,
  beginChainWatch,
  endChainWatch,
  noteChainReadObserved,
  noteChainWatchNavigation,
  forgetChainWatchPage,
  abortChainWatch,
  makeAllowanceChainFixture,
  answerSharedChainRead,
  FIXTURE_SAFE,
  FIXTURE_AGENTS,
} from '../../scripts/screenshot.mjs'
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, toFunctionSelector } from 'viem'
import { getChainData, resolveToken } from '@haven_ai/core'

const BASE = 'http://127.0.0.1:3181'

beforeEach(() => {
  CHAIN_SILENT_CAPTURES.length = 0
})

describe('the silent-capture guard', () => {
  it('FAILS a capture that visited a chain-fed route and issued no chain read', () => {
    beginChainWatch('scenario:connect-agent', 'desktop')
    noteChainWatchNavigation(`${BASE}/agents`)
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES).toEqual([
      {
        capture: 'scenario:connect-agent',
        viewport: 'desktop',
        route: '/agents',
        reads: expect.stringContaining('useOnChainAllowances'),
      },
    ])
  })

  it('passes the same capture once ONE chain read is observed', () => {
    beginChainWatch('scenario:connect-agent', 'desktop')
    noteChainWatchNavigation(`${BASE}/agents`)
    noteChainReadObserved('eth_call')
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES).toEqual([])
  })

  it('says nothing about a capture that never visited a chain-fed route', () => {
    // The guard must not turn `npm run screenshot` permanently red on the
    // default run, which captures `/design-system` only — a page with no chain
    // surface on it. A gate that is red on an unchanged `dev` is one people
    // learn to ignore.
    beginChainWatch('routes · desktop', 'desktop')
    noteChainWatchNavigation(`${BASE}/design-system`)
    noteChainWatchNavigation(`${BASE}/`)
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES).toEqual([])
  })

  it('reports every chain-fed route the capture visited, not just the first', () => {
    beginChainWatch('scenario:modal-migrations', 'mobile')
    noteChainWatchNavigation(`${BASE}/custody`)
    noteChainWatchNavigation(`${BASE}/agents/agent-ops`)
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES.map((c) => c.route).sort()).toEqual([
      '/agents/agent-ops',
      '/custody',
    ])
  })

  it('attributes reads to the PAGE that made them — a healthy route does not excuse a silent one', () => {
    // The soundness gap independent review caught before this shipped. One
    // context sweeps several routes (`npm run screenshot -- /agents /custody`
    // is ONE context, two screens). A context-wide counter would be non-zero
    // here and would swallow the `/agents` regression entirely — the exact
    // failure this guard exists to catch, missed by the guard.
    beginChainWatch('routes · desktop', 'desktop')
    noteChainWatchNavigation(`${BASE}/agents`)
    // …no reads on /agents…
    noteChainWatchNavigation(`${BASE}/custody`)
    noteChainReadObserved('eth_call')
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES.map((c) => c.route)).toEqual(['/agents'])
  })

  it('does not credit a chain-fed page with a read made on a NON-chain-fed page', () => {
    beginChainWatch('routes · desktop', 'desktop')
    noteChainWatchNavigation(`${BASE}/agents`)
    noteChainWatchNavigation(`${BASE}/design-system`)
    noteChainReadObserved('eth_call')
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES.map((c) => c.route)).toEqual(['/agents'])
  })

  it('keeps a page\'s reads when a scenario navigates back to it', () => {
    beginChainWatch('scenario:modal-migrations', 'desktop')
    noteChainWatchNavigation(`${BASE}/agents`)
    noteChainReadObserved('eth_call')
    noteChainWatchNavigation(`${BASE}/custody`)
    noteChainReadObserved('eth_call')
    noteChainWatchNavigation(`${BASE}/agents`)
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES).toEqual([])
  })

  it('covers /custody, which reads the chain at render just as /agents does', () => {
    beginChainWatch('routes · desktop', 'desktop')
    noteChainWatchNavigation(`${BASE}/custody`)
    endChainWatch()
    expect(CHAIN_SILENT_CAPTURES.map((c) => c.route)).toEqual(['/custody'])
  })

  /**
   * #2106 made `/custody` conditionally chain-fed: it renders a per-account
   * card and only the LEGACY Safe branch mounts `useOnChainAllowances`. The
   * delegation-rail card proves custody from two API reads and touches the
   * chain not at all, so zero reads is correct there — but only there.
   *
   * Both directions are pinned, because an exemption that only ever says "fine"
   * is the kind of guard this repo keeps finding already broken.
   */
  describe('a capture may declare a route legitimately chain-silent (#2106)', () => {
    it('does not report a declared-silent route that made no read', () => {
      beginChainWatch('scenario:custody-delegation-rail', 'desktop')
      noteChainWatchNavigation(`${BASE}/custody`)
      endChainWatch([/^\/custody(\/|$)/])
      expect(CHAIN_SILENT_CAPTURES).toEqual([])
    })

    it('still reports a route the capture did NOT declare', () => {
      // The declaration is per route: silence on /custody must not buy
      // silence on /agents in the same capture.
      beginChainWatch('scenario:custody-delegation-rail', 'desktop')
      noteChainWatchNavigation(`${BASE}/custody`)
      noteChainWatchNavigation(`${BASE}/agents`)
      endChainWatch([/^\/custody(\/|$)/])
      expect(CHAIN_SILENT_CAPTURES.map((c) => c.route)).toEqual(['/agents'])
    })

    it('reports a declared-silent route that DID read — the declaration is stale', () => {
      // The direction that keeps this honest. The day the delegation card
      // starts reading the chain, the exemption stops being true and must
      // fail rather than quietly widen.
      beginChainWatch('scenario:custody-delegation-rail', 'desktop')
      noteChainWatchNavigation(`${BASE}/custody`)
      noteChainReadObserved('eth_call')
      endChainWatch([/^\/custody(\/|$)/])
      expect(CHAIN_SILENT_CAPTURES).toHaveLength(1)
      expect(CHAIN_SILENT_CAPTURES[0].route).toBe('/custody')
      expect(CHAIN_SILENT_CAPTURES[0].unexpectedRead).toMatch(/declared chain-silent/i)
    })

    it('leaves the guard armed for a capture that declares nothing', () => {
      beginChainWatch('scenario:custody-legacy-rail', 'desktop')
      noteChainWatchNavigation(`${BASE}/custody`)
      endChainWatch()
      expect(CHAIN_SILENT_CAPTURES.map((c) => c.route)).toEqual(['/custody'])
    })
  })

  it('a read seen after the watch closed does not excuse the capture it left behind', () => {
    // Per-context bookkeeping: `endChainWatch` closes the window. A read seen
    // after it belongs to nothing, and must not retroactively clear a capture
    // already recorded as silent.
    beginChainWatch('scenario:a', 'desktop')
    noteChainWatchNavigation(`${BASE}/agents`)
    endChainWatch()
    noteChainReadObserved('eth_call')

    expect(CHAIN_SILENT_CAPTURES).toHaveLength(1)
    expect(CHAIN_SILENT_CAPTURES[0]!.capture).toBe('scenario:a')
  })

  it('withdraws a page whose navigation FAILED — a machine timeout is not a transport defect', () => {
    // Observed live on the authoring run, on a box at load average 300+: a
    // `goto` that times out still fires `framenavigated`, so the page enters
    // the watch, renders nothing, reads nothing, and gets reported as a silent
    // chain-fed capture — directly beneath the `goto failed:` line that already
    // says what really happened, pointing the reader at lib/wagmi.ts for a bug
    // that is not there.
    beginChainWatch('routes · mobile', 'mobile')
    noteChainWatchNavigation(`${BASE}/agents`)
    forgetChainWatchPage(`${BASE}/agents`)
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES).toEqual([])
  })

  it('withdrawing one page does not excuse another that really was silent', () => {
    beginChainWatch('routes · mobile', 'mobile')
    noteChainWatchNavigation(`${BASE}/agents`)
    forgetChainWatchPage(`${BASE}/agents`)
    noteChainWatchNavigation(`${BASE}/custody`)
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES.map((c) => c.route)).toEqual(['/custody'])
  })

  it('a scenario that threw reports its own failure, not a transport verdict', () => {
    beginChainWatch('scenario:connect-agent', 'mobile')
    noteChainWatchNavigation(`${BASE}/agents`)
    abortChainWatch()
    endChainWatch()

    expect(CHAIN_SILENT_CAPTURES).toEqual([])
  })

  it('ignores a non-URL navigation target instead of throwing', () => {
    beginChainWatch('scenario:a', 'desktop')
    noteChainWatchNavigation('about:blank')
    endChainWatch()
    expect(CHAIN_SILENT_CAPTURES).toEqual([])
  })

  it('every chain-fed route names the hook that reads the chain there', () => {
    // The report has to be actionable without this file open. A pattern with no
    // stated reason invites the next editor to delete it as noise.
    //
    // Whether the LIST itself is right — every render-time chain read covered,
    // and nothing covered that is not one — is deliberately NOT asserted here.
    // The first version of this test pinned the list against an array of route
    // strings typed by hand a few lines up, which only proved that two
    // hand-maintained lists agreed with each other, and would not have caught
    // `/dashboard` being in the list on a false premise.
    // `chain-fed-route-coverage.test.ts` derives that answer from the app's own
    // import graph instead.
    for (const route of CHAIN_FED_ROUTES) {
      expect(route.reads).toMatch(/useOnChainAllowances/)
      expect(route.reads.length).toBeGreaterThan(20)
    }
  })
})

describe('the shared chain fixture', () => {
  const SAFE = FIXTURE_SAFE as { chain_id: number; safe_address: string }
  const chainId = SAFE.chain_id
  const allowanceModule = getChainData(chainId).contracts.allowanceModule

  /**
   * USDC's address on a chain, or a throw.
   *
   * `resolveToken` is total (it can answer "no such token") and `address` is
   * nullable (a native token has none). Both are real possibilities the type
   * system is right to insist on — and both would make every assertion below
   * compare `undefined` to `undefined` and pass. The throw is the point.
   */
  const usdcAddress = (id: number): string => {
    const token = resolveToken(id, 'USDC')
    if (!token?.address) throw new Error(`the shared registry has no USDC address for chain ${id}`)
    return token.address
  }
  const sel = (sig: string) => toFunctionSelector(sig)

  const call = (to: string, data: string) =>
    answerSharedChainRead('eth_call', [{ to, data }]) as `0x${string}`

  it('is seeded on the SHARED fixture\'s own chain — the one #1971 gave a transport', () => {
    expect(answerSharedChainRead('eth_chainId', [])).toBe(`0x${chainId.toString(16)}`)
    expect(chainId).toBe(84532)
  })

  it('reports the AllowanceModule enabled on the shared fixture Safe', () => {
    const data = call(SAFE.safe_address, sel('function isModuleEnabled(address) view returns (bool)'))
    expect(decodeAbiParameters(parseAbiParameters('bool'), data)[0]).toBe(true)
  })

  it('discovers exactly the MANAGED delegate — a stranger here would render an unmanaged-delegate warning in every capture', () => {
    const data = call(allowanceModule, sel('function getDelegates(address,uint48,uint8) view returns (address[],uint48)'))
    const [delegates] = decodeAbiParameters(parseAbiParameters('address[], uint48'), data)
    const managed = (FIXTURE_AGENTS as { delegate_address: string | null }[])
      .map((a) => a.delegate_address)
      .filter((d): d is string => Boolean(d))
      .map((d) => d.toLowerCase())
    expect((delegates as string[]).map((d) => d.toLowerCase())).toEqual(managed)
  })

  it('serves the SAME USDC address the API fixture serves — one token, not two', () => {
    const data = call(allowanceModule, sel('function getTokens(address,address) view returns (address[])'))
    const [tokens] = decodeAbiParameters(parseAbiParameters('address[]'), data)
    expect((tokens as string[]).map((t) => t.toLowerCase())).toEqual([
      usdcAddress(chainId).toLowerCase(),
    ])
    // The API fixture's own allowance row for agent-ops.
    const apiAllowance = (FIXTURE_AGENTS as { id: string; allowances: { token_address: string }[] }[])
      .find((a) => a.id === 'agent-ops')!.allowances[0]!
    expect(apiAllowance.token_address.toLowerCase()).toBe(
      usdcAddress(chainId).toLowerCase(),
    )
  })

  it('agrees with the API fixture on the AMOUNT and the PERIOD', () => {
    // The two sources render side by side on AgentPanel. A fixture whose chain
    // and API disagree photographs a contradiction the product cannot produce.
    const encoded = encodeAbiParameters(parseAbiParameters('address,address,address'), [
      SAFE.safe_address as `0x${string}`,
      '0x0000000000000000000000000000000000000000',
      usdcAddress(chainId) as `0x${string}`,
    ]).slice(2)
    const data = call(
      allowanceModule,
      sel('function getTokenAllowance(address,address,address) view returns (uint256[5])') + encoded,
    )
    const [row] = decodeAbiParameters(parseAbiParameters('uint256[5]'), data)
    const [amount, , resetTimeMin] = row as unknown as bigint[]

    const apiAllowance = (FIXTURE_AGENTS as {
      id: string
      allowances: { allowance_amount: string; reset_period_min: number }[]
    }[]).find((a) => a.id === 'agent-ops')!.allowances[0]!

    expect(amount).toBe(BigInt(Math.round(Number(apiAllowance.allowance_amount) * 1e6)))
    expect(Number(resetTimeMin)).toBe(apiAllowance.reset_period_min)
  })

  it('refuses a read aimed at the wrong contract rather than answering it plausibly', () => {
    // A selector collision or a read aimed elsewhere must fail loudly — an
    // answer for the wrong address is the same class of photogenic wrong answer
    // this whole change is about.
    expect(() =>
      call('0x0000000000000000000000000000000000000dead', sel('function getTokens(address,address) view returns (address[])')),
    ).toThrow(/reading a different contract/)
  })

  it('declines an unseeded method instead of inventing one — the gap report has something to record', () => {
    expect(answerSharedChainRead('eth_sendRawTransaction', [])).toBeUndefined()
    expect(answerSharedChainRead('eth_call', [{ to: allowanceModule, data: '0xdeadbeef' }])).toBeUndefined()
  })

  it('the factory serves a DIFFERENT chain from the same code', () => {
    // Proves the instrument: if the factory ignored its arguments, every
    // assertion above would be true of any fixture it produced.
    const other = makeAllowanceChainFixture({
      chainId: 8453,
      safeAddress: SAFE.safe_address,
      delegates: ['0x000000000000000000000000000000000000BEEF'],
      rows: [{ token: usdcAddress(8453), amount: 1n, spent: 0n, resetTimeMin: 1440 }],
    })
    expect(other('eth_chainId', [])).toBe('0x2105')
    expect(other('eth_chainId', [])).not.toBe(answerSharedChainRead('eth_chainId', []))
    // …and on the other chain's OWN AllowanceModule, not this one's.
    expect(getChainData(8453).contracts.allowanceModule).not.toBe(allowanceModule)
    expect(() =>
      other('eth_call', [{ to: allowanceModule, data: sel('function getTokens(address,address) view returns (address[])') }]),
    ).toThrow(/reading a different contract/)
  })
})
