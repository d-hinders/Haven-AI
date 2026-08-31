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
  answerLegacyRailChainRead,
  FIXTURE_SAFE,
  FIXTURE_LEGACY_SAFE,
  FIXTURE_USER,
  FIXTURE_AGENTS,
  SHARED_CHAIN_ROWS,
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

  // ── #2202: TWO accounts, and the reads are keyed per account ───────────────
  //
  // `makeAllowanceChainFixture` checks each call's `to` against the address it
  // was built for and throws on a mismatch, so these two are not
  // interchangeable — which is the point. The shared account is
  // `delegator_hybrid` and has no AllowanceModule; `agent-ops`'s own account is
  // the legacy Safe that does. Before #2202 one fixture answered for both,
  // because one agent claimed a rail its account did not have.
  const LEGACY = FIXTURE_LEGACY_SAFE as { chain_id: number; safe_address: string }

  const call = (to: string, data: string) =>
    answerSharedChainRead('eth_call', [{ to, data }]) as `0x${string}`
  const callLegacy = (to: string, data: string) =>
    answerLegacyRailChainRead('eth_call', [{ to, data }]) as `0x${string}`

  it('is seeded on the SHARED fixture\'s own chain — the one #1971 gave a transport', () => {
    expect(answerSharedChainRead('eth_chainId', [])).toBe(`0x${chainId.toString(16)}`)
    expect(chainId).toBe(84532)
    // Both accounts are the same user's, on the same chain — a second chain
    // here would make the account switch a chain switch too, and the capture
    // would be evidence about the wrong thing.
    expect(LEGACY.chain_id).toBe(chainId)
    expect(LEGACY.safe_address.toLowerCase()).not.toBe(SAFE.safe_address.toLowerCase())
  })

  it('reports NO AllowanceModule on the shared DELEGATION-rail account', () => {
    // #2106 recorded this as impossible and overrode it per-scenario; #2202
    // makes the shared answer itself honest. A Hybrid DeleGator is not a Safe
    // and has no modules, so `true` here is a state the account cannot reach —
    // and it is the read that gates every other one in `useOnChainAllowances`,
    // so a wrong answer here silently invents a whole legacy rail.
    const data = call(SAFE.safe_address, sel('function isModuleEnabled(address) view returns (bool)'))
    expect(decodeAbiParameters(parseAbiParameters('bool'), data)[0]).toBe(false)
  })

  it('reports the AllowanceModule enabled on the LEGACY account that actually has one', () => {
    const data = callLegacy(
      LEGACY.safe_address,
      sel('function isModuleEnabled(address) view returns (bool)'),
    )
    expect(decodeAbiParameters(parseAbiParameters('bool'), data)[0]).toBe(true)
  })

  /**
   * The Safe argument every AllowanceModule read carries, encoded as the app
   * sends it.
   *
   * #2202: these calls used to be made with a BARE selector, because the
   * fixture answered one account and ignored its arguments. It routes by the
   * Safe now, so the calldata has to carry one — which is also what
   * `useOnChainAllowances` actually puts on the wire, so the test got closer to
   * the app rather than further from it.
   */
  const safeArg = (safe: string) =>
    encodeAbiParameters(parseAbiParameters('address'), [safe as `0x${string}`]).slice(2)

  /** The on-chain delegate set the LEGACY account's AllowanceModule reports. */
  const onChainDelegates = (): string[] => {
    const data = callLegacy(
      allowanceModule,
      sel('function getDelegates(address,uint48,uint8) view returns (address[],uint48)') +
        safeArg(LEGACY.safe_address),
    )
    const [delegates] = decodeAbiParameters(parseAbiParameters('address[], uint48'), data)
    return (delegates as string[]).map((d) => d.toLowerCase())
  }

  type FixtureAgent = { id: string; delegate_address: string | null; account_type: string | null }
  const fixtureAgents = FIXTURE_AGENTS as unknown as FixtureAgent[]

  it('discovers no STRANGER — an unlisted delegate would render an unmanaged-delegate warning in every capture', () => {
    // The invariant this guard has always been about, stated as what it is: a
    // CONTAINMENT, not an equality. `useAgentPanelState.ts:261-271` builds
    // `unmanagedDelegates` by subtracting the managed set (every non-null
    // `delegate_address` the API fixture serves) from the on-chain set, so an
    // on-chain delegate Haven does not know about is what puts an
    // `UnmanagedDelegateCard` into every `/agents` capture.
    const managed = new Set(
      fixtureAgents
        .map((a) => a.delegate_address)
        .filter((d): d is string => Boolean(d))
        .map((d) => d.toLowerCase()),
    )
    const chainDelegates = onChainDelegates()
    expect(chainDelegates.length).toBeGreaterThan(0) // non-vacuity: an empty set contains nothing
    for (const delegate of chainDelegates) {
      expect(managed.has(delegate)).toBe(true)
    }
  })

  it('lists exactly the LEGACY-rail delegates — the module is the retired rail\'s registry, not a roster of every agent', () => {
    // #2194 replaced an equality against EVERY non-null fixture delegate. That
    // was true only while the one agent with a delegate address happened to be
    // the legacy-rail one, and it broke the moment `agent-research` — a
    // `delegator_hybrid` agent — honestly got the delegate address its x402
    // payment intents prove it has.
    //
    // ── #2202: the rail predicate was itself path-impossible ────────────────
    //
    // #2194 wrote this filter as `account_type === null`, and #2205 carried it
    // forward and named the rework as residual risk. Both were reading the
    // fixture's own literal rather than the column. `user_safes.account_type`
    // is `VARCHAR(32) NOT NULL DEFAULT 'safe'` under
    // `CHECK (account_type IN ('safe','delegator_hybrid'))`
    // (`041_hybrid_accounts.ts:29`, `:38`) — so `null` is not a value the
    // column can hold, and the LEGACY rail is `'safe'`. The old predicate
    // matched only because `agent-ops` carried the impossible literal #2202
    // removed; it selected the right row for the wrong reason, and it would
    // have selected NOTHING against any honest fixture.
    //
    // The `toBeGreaterThan(0)` below is what makes that a failure rather than
    // a silent pass: a predicate that matches nothing must not read as "no
    // delegation-rail delegate is on-chain, therefore green".
    //
    // `getDelegates` is written by the AllowanceModule's own `addDelegate`, on
    // the Safe rail #1440/#2020 retired. A delegation-rail agent's authority is
    // a delegation grant; nothing registers its delegate with the module. And
    // the difference is RENDERED, not bookkeeping: `useOnChainAllowances` keys
    // its map off this list rather than off its `managedDelegates` argument
    // (`hooks/useOnChainAllowances.ts:110-127`), and `makeAllowanceChainFixture`
    // answers `getTokenAllowance` from `rows` without consulting the delegate
    // argument — so a delegation-rail delegate listed here would render the
    // LEGACY agent's 500 USDC / daily budget on its card
    // (`AgentPanel.tsx:174-176`), beside its own 250 USDC / weekly delegation.
    const legacyRail = fixtureAgents
      .filter((a) => a.account_type === 'safe' && a.delegate_address)
      .map((a) => (a.delegate_address as string).toLowerCase())
    expect(legacyRail.length).toBeGreaterThan(0) // non-vacuity, both directions
    expect(onChainDelegates()).toEqual(legacyRail)
  })

  it('gives every fixture agent an account_type the COLUMN can hold — no third state', () => {
    // The shape #2202 was: a value that is legal for the TypeScript type
    // (`account_type?: string | null`, `core/src/api-types.ts:2818`) and
    // impossible for the column behind it. The wire type is nullable for one
    // real reason — `agents.safe_id` is nullable (`000_initial.ts:209`) and
    // every read is a LEFT JOIN (`infra/repositories/agents.ts:194`, `:214`,
    // `:228`), so an agent with NO account answers null for all four `us.*`
    // fields at once. That is the ONLY null-producing path, and it takes the
    // safe identity with it.
    //
    // So the rule is not "account_type is non-null". It is: an agent that
    // names an account reports that account's rail, and an agent that names
    // none reports null for the whole joined row. Anything else is a response
    // no backend can serve.
    for (const agent of fixtureAgents as (FixtureAgent & {
      safe_id: string | null
      safe_address: string | null
      safe_name: string | null
      safe_chain_id: number | null
    })[]) {
      if (agent.safe_id === null) {
        expect(agent.account_type, `${agent.id}: no safe, so the join finds no row`).toBeNull()
        expect(agent.safe_address).toBeNull()
        expect(agent.safe_name).toBeNull()
        expect(agent.safe_chain_id).toBeNull()
        continue
      }
      expect(
        agent.account_type,
        `${agent.id}: joins a user_safes row, so account_type is that row's — ` +
          "CHECK (account_type IN ('safe','delegator_hybrid'))",
      ).toMatch(/^(safe|delegator_hybrid)$/)
      // The other three come from the SAME joined row, so a populated identity
      // beside a null rail is the exact contradiction #2202 removed.
      expect(agent.safe_address).not.toBeNull()
      expect(agent.safe_name).not.toBeNull()
      expect(agent.safe_chain_id).not.toBeNull()
    }
  })

  it('lets ONE safe answer ONE account_type — the #2202 contradiction, stated directly', () => {
    // `account_type` is not an agent column: it is `us.account_type` off the
    // joined row. Two agents on one `safe_id` therefore cannot report two
    // different rails, however plausible each row looks on its own.
    const bySafe = new Map<string, Set<string | null>>()
    for (const agent of fixtureAgents as (FixtureAgent & { safe_id: string | null })[]) {
      if (!agent.safe_id) continue
      const seen = bySafe.get(agent.safe_id) ?? new Set()
      seen.add(agent.account_type)
      bySafe.set(agent.safe_id, seen)
    }
    expect(bySafe.size).toBeGreaterThan(0)
    for (const [safeId, values] of bySafe) {
      expect(
        [...values],
        `safe ${safeId} is joined by agents claiming ${values.size} different account_types`,
      ).toHaveLength(1)
    }

    // …and each of those agrees with what `/auth/me` says about the same safe,
    // which is the independent source that made `agent-ops` the odd row out.
    const safesById = new Map(
      (FIXTURE_USER as unknown as { safes: { id: string; account_type: string }[] }).safes.map(
        (s) => [s.id, s.account_type],
      ),
    )
    for (const [safeId, values] of bySafe) {
      expect(safesById.get(safeId), `safe ${safeId} is not in /auth/me's safes list`).toBe(
        [...values][0],
      )
    }
  })

  it('gives an `allowances` array ONLY to a delegation-rail agent — the legacy read surface is retired (#2224)', () => {
    // The same defect class as `account_type: null`, one field over, and it
    // was RENDERED: `agent-ops` (`account_type: 'safe'`) carried a 500 USDC /
    // daily allowance row that no backend read can produce, and
    // `AgentCard.showConfiguredFallback` turned it into a budget row on
    // `/agents` — the row #2224's own evidence table was built on.
    //
    // Both agent reads fill this field the same way and neither consults
    // `agent_allowances`:
    //
    //   GET /agents      `account_type === 'delegator_hybrid' ? derived : []`
    //                    (`backend/src/routes/agents.ts:92-98`)
    //   GET /agents/:id  the same branch (`:113-121`)
    //
    // where `derived` is `deriveDelegationAllowances` projecting the agent's
    // ACTIVE `agent_delegations` rows (`rails/delegation-budget-view.ts`). The
    // `agent_allowances` read surface is deleted outright — the four LIST_*
    // projections are gone (`infra/repositories/agents.ts:232-237`,
    // #1440/#2020) and the write routes answer 410.
    //
    // So the direction matters and both halves are asserted: a legacy-rail
    // agent MUST have an empty array (nothing fills it), and a delegation-rail
    // agent with a budget MUST have a non-empty one (the projection is what
    // fills it — an agent with a delegation and an empty array renders its
    // budget as raw atomic units, the state #2106 recorded).
    const withAllowances = FIXTURE_AGENTS as unknown as (FixtureAgent & {
      allowances: unknown[]
    })[]
    // Non-vacuity, both directions: a guard that finds no agent of either rail
    // must not read as green.
    expect(withAllowances.some((a) => a.account_type === 'safe')).toBe(true)
    expect(withAllowances.some((a) => a.account_type === 'delegator_hybrid')).toBe(true)
    for (const agent of withAllowances) {
      if (agent.account_type === 'delegator_hybrid') continue
      expect(
        agent.allowances,
        `${agent.id}: account_type '${agent.account_type}' is not the delegation rail, so ` +
          `routes/agents.ts serves []. A non-empty array here is union-legal, path-impossible ` +
          `and rendered as a budget row on /agents.`,
      ).toEqual([])
    }
  })

  it('leaves every DELEGATION-rail delegate off-chain, so no card renders two spend limits', () => {
    // The complement of the test above, asserted rather than implied — the
    // shape #2194 was filed about is a value that is legal for its type and
    // impossible for its path, and a one-sided equality does not say which
    // side moved.
    const delegationRail = fixtureAgents
      .filter((a) => a.account_type === 'delegator_hybrid' && a.delegate_address)
      .map((a) => (a.delegate_address as string).toLowerCase())
    expect(delegationRail.length).toBeGreaterThan(0)
    const chainDelegates = new Set(onChainDelegates())
    for (const delegate of delegationRail) {
      expect(chainDelegates.has(delegate)).toBe(false)
    }
  })

  it('serves the SAME USDC address the API fixture serves — one token, not two', () => {
    const data = callLegacy(
      allowanceModule,
      sel('function getTokens(address,address) view returns (address[])') +
        safeArg(LEGACY.safe_address),
    )
    const [tokens] = decodeAbiParameters(parseAbiParameters('address[]'), data)
    expect((tokens as string[]).map((t) => t.toLowerCase())).toEqual([
      usdcAddress(chainId).toLowerCase(),
    ])
    // #2224: this used to cross-check the chain's token against `agent-ops`'s
    // API allowance row. That row is gone — a legacy-rail agent's `allowances`
    // array is `[]` on every read — so the cross-check is replaced rather than
    // deleted, against the source that is still there: every token any fixture
    // agent states a budget in must be the SAME registry USDC this chain
    // fixture serves. One token across the fixture is the invariant the old
    // assertion was reaching for through `agent-ops`; it just no longer has to
    // go through a row that cannot exist.
    const apiTokens = (FIXTURE_AGENTS as { allowances: { token_address: string }[] }[])
      .flatMap((a) => a.allowances)
      .map((x) => x.token_address.toLowerCase())
    expect(apiTokens.length, 'no fixture agent states a budget at all — vacuous').toBeGreaterThan(0)
    for (const token of apiTokens) {
      expect(token).toBe(usdcAddress(chainId).toLowerCase())
    }
  })

  it('answers the AMOUNT and PERIOD it was declared with, over the real wire', () => {
    // #2224: this used to assert the chain answer equalled `agent-ops`'s API
    // allowance, on the reasoning that the two render side by side and must not
    // photograph a contradiction. The API side of that pair is gone (see the
    // token test above), and with it the contradiction — the legacy account's
    // budget now has exactly one source.
    //
    // What the assertion was ACTUALLY proving survives, and is stated directly:
    // the fixture's ABI encoding round-trips. `makeAllowanceChainFixture`
    // encodes `SHARED_CHAIN_ROWS` into `uint256[5]` return data and the app
    // decodes it with viem; a wrong encoding is swallowed by
    // `useOnChainAllowances` into an empty map and renders as a plausible empty
    // card, so nothing else would say so. Anchored on the exported declaration
    // rather than on pasted literals, so the numbers stay in one place.
    //
    // Be exact about what this is and is not, because the old and new versions
    // look alike and guarantee different things (`haven-reviewer` on this
    // change). It is a ROUND-TRIP proof of the encoder — a wrong slot order or
    // a wrong scale in `allowance-chain-fixture.mjs` still fails it. It is NOT
    // a cross-source consistency proof: the second, independently authored
    // source it used to compare against no longer exists, because the API side
    // is now correctly always `[]`.
    const encoded = encodeAbiParameters(parseAbiParameters('address,address,address'), [
      LEGACY.safe_address as `0x${string}`,
      '0x0000000000000000000000000000000000000000',
      usdcAddress(chainId) as `0x${string}`,
    ]).slice(2)
    const data = callLegacy(
      allowanceModule,
      sel('function getTokenAllowance(address,address,address) view returns (uint256[5])') + encoded,
    )
    const [row] = decodeAbiParameters(parseAbiParameters('uint256[5]'), data)
    const [amount, , resetTimeMin] = row as unknown as bigint[]

    const declared = (SHARED_CHAIN_ROWS as {
      token: string
      amount: bigint
      resetTimeMin: number
    }[]).find((r) => r.token.toLowerCase() === usdcAddress(chainId).toLowerCase())
    expect(declared, 'SHARED_CHAIN_ROWS declares no USDC row — vacuous').toBeDefined()

    expect(amount).toBe(declared!.amount)
    expect(Number(resetTimeMin)).toBe(declared!.resetTimeMin)
  })

  it('routes each account\'s reads by the SAFE they name, not by call order (#2202)', () => {
    // The shared fixture answers for BOTH accounts now, because one capture
    // reads both: `/custody` renders a card per account and only the legacy
    // one mounts `useOnChainAllowances`. The hazard a multi-account fixture
    // introduces is answering account A's budget for account B — which renders
    // perfectly and is wrong, this issue's own defect class one layer down.
    //
    // So: the SAME selector, on the SAME module, differing only in its Safe
    // argument, must come back different.
    const delegatesFor = (safe: string): string[] => {
      const data = answerSharedChainRead('eth_call', [
        {
          to: allowanceModule,
          data:
            sel('function getDelegates(address,uint48,uint8) view returns (address[],uint48)') +
            safeArg(safe),
        },
      ]) as `0x${string}`
      const [delegates] = decodeAbiParameters(parseAbiParameters('address[], uint48'), data)
      return (delegates as string[]).map((d) => d.toLowerCase())
    }

    expect(delegatesFor(LEGACY.safe_address)).toEqual(
      fixtureAgents
        .filter((a) => a.account_type === 'safe' && a.delegate_address)
        .map((a) => (a.delegate_address as string).toLowerCase()),
    )
    // The delegation account has no AllowanceModule at all, so its registry is
    // empty — and crucially NOT the legacy account's list.
    expect(delegatesFor(SAFE.safe_address)).toEqual([])
    expect(delegatesFor(SAFE.safe_address)).not.toEqual(delegatesFor(LEGACY.safe_address))

    // `isModuleEnabled` is the other axis — addressed to the Safe rather than
    // carrying it as an argument — and it must disagree across the two.
    const moduleOn = (safe: string) =>
      decodeAbiParameters(
        parseAbiParameters('bool'),
        answerSharedChainRead('eth_call', [
          { to: safe, data: sel('function isModuleEnabled(address) view returns (bool)') },
        ]) as `0x${string}`,
      )[0]
    expect(moduleOn(LEGACY.safe_address)).toBe(true)
    expect(moduleOn(SAFE.safe_address)).toBe(false)

    // And a Safe the fixture does not describe is refused rather than handed
    // whichever account happens to be first.
    expect(() => delegatesFor('0x00000000000000000000000000000000000000aa')).toThrow(
      /different contract/,
    )
  })

  it('refuses a read aimed at the wrong contract rather than answering it plausibly', () => {
    // A selector collision or a read aimed elsewhere must fail loudly — an
    // answer for the wrong address is the same class of photogenic wrong answer
    // this whole change is about.
    expect(() =>
      callLegacy('0x0000000000000000000000000000000000000dead', sel('function getTokens(address,address) view returns (address[])')),
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
