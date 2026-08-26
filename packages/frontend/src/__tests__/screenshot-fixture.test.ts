import { afterEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the cast below
import {
  fixtureFor,
  SEED_STORAGE_KEYS,
  FIXTURE_EMPTY_FALLBACK,
  SCENARIOS,
  ScenarioHttpError,
} from '../../scripts/screenshot.mjs'
import { AUTH_TOKEN_STORAGE_KEY, ACTIVE_SAFE_STORAGE_KEY } from '../lib/auth-storage'
import {
  isMcpToolCallActivityItem,
  isPaymentActivityItem,
  type ActivityItem,
} from '../hooks/useAgentActivity'

const fx = fixtureFor as (apiPath: string, mode?: string) => Record<string, unknown> | null

type ScenarioShape = {
  api: (apiPath: string, method: string) => Record<string, unknown> | undefined
}
/** A scenario that shoots one surface at several states (#1725). */
type StagedScenarioShape = ScenarioShape & {
  stage: (next: string) => void
  stages: Record<string, Record<string, unknown> | null>
}
/** Kept in step with FIXTURE_SAFE in screenshot.mjs. */
const FIXTURE_SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
/** Kept in step with the scenario's own constant in screenshot.mjs. */
const SETUP_ID = 'setup-screenshot'
/** Likewise FIXTURE_SAFE.id — the legacy scenario must reuse the same account. */
const FIXTURE_SAFE_ID = 'safe-fixture'

describe('screenshot populated fixture (#896 follow-up)', () => {
  it('serves the populated shapes the hooks actually read', () => {
    // Each keyed endpoint returns the field its hook destructures — the exact
    // gaps that previously crashed routes render as error boundaries.
    expect(fx('/dashboard/overview')).toMatchObject({ totals: { usd: expect.any(Number) } })
    expect(fx('/portfolio/0x1111?chain_id=84532')).toMatchObject({ breakdown: expect.any(Array) })
    expect(fx('/balances/0x1111?chain_id=84532')).toMatchObject({ balances: expect.any(Array) })
    expect(fx('/agents')).toMatchObject({ agents: expect.any(Array) })
    expect(fx('/contacts')).toMatchObject({ contacts: expect.any(Array) })
    expect(fx('/chains')).toEqual({ deployable: [84532] })
  })

  it('distinguishes the three /transactions shapes', () => {
    // The aggregated feed (useTransactionsFeed):
    expect(fx('/transactions?offset=0&limit=25')).toMatchObject({ hasMore: false, failedSafeIds: [] })
    // Filter options (useTransactionFilters) — must NOT fall into the paginated branch:
    expect(fx('/transactions/filters')).toMatchObject({
      safes: expect.any(Array), agents: expect.any(Array), tokens: expect.any(Array),
    })
    // Safe-scoped paginated (useTransactions):
    expect(fx('/transactions/0x1111?page=1')).toMatchObject({ pages: 1, page: 1 })
  })

  it('regression-locks the shapes that crashed routes (timeAgo/timeUntil inputs)', () => {
    // The `ApprovalCard: timeUntil(expires_at)` lock that stood here went with
    // its subject (#1993): #1989 deleted the card and the route, #2055
    // deregistered the endpoint, and #1993 removed the fixture. A shape lock on
    // a component nobody renders cannot regression-lock anything.
    // SafeCard: timeAgo(safe.created_at) — served via /auth/me + /user/safes in the
    // script itself; asserted here through the agents' safe linkage staying non-null.
    const agents = fx('/agents') as { agents: { safe_id: string }[] }
    expect(agents.agents.every((a) => a.safe_id)).toBe(true)
  })

  it('SCREENSHOT_FIXTURE=empty falls through to the generic empty shape', () => {
    expect(fx('/dashboard/overview', 'empty')).toBeNull()
    expect(fx('/agents', 'empty')).toBeNull()
  })

  it('unkeyed endpoints fall through (null → generic empty shape)', () => {
    expect(fx('/agents/agent-1/delegations')).toBeNull()
    expect(fx('/reporting/summary')).toBeNull()
  })

  // #1075: /agents/[agentId] rendered nothing under the harness because
  // `/agent-activity/:id/activity` was unkeyed AND the generic fallback had no
  // `activity` key — useAgentActivity stored `undefined` and the page's
  // `.filter` over it took the route down. Both halves are pinned here.
  describe('agent activity (#1075)', () => {
    it('keys the agent-activity endpoints the detail page reads', () => {
      const activity = fx('/agent-activity/agent-research/activity') as { activity: ActivityItem[] }
      expect(activity.activity.length).toBeGreaterThan(0)

      expect(fx('/agent-activity/agent-research/stats')).toMatchObject({
        all_time: expect.any(Array),
        today: expect.any(Array),
        this_week: expect.any(Array),
        pending_approvals: expect.any(Number),
      })

      expect(fx('/agent-activity/feed')).toMatchObject({
        activity: expect.any(Array),
        pending_approvals: expect.any(Number),
      })
    })

    it('serves both activity variants in the shape the page discriminates on', () => {
      // The detail page splits the feed with these two guards; an item that
      // matches neither renders in no section at all.
      const { activity } = fx('/agent-activity/agent-research/activity') as {
        activity: ActivityItem[]
      }
      expect(activity.every((i) => isPaymentActivityItem(i) || isMcpToolCallActivityItem(i))).toBe(
        true,
      )
      expect(activity.some(isPaymentActivityItem)).toBe(true)
      expect(activity.some(isMcpToolCallActivityItem)).toBe(true)
      // Payment rows drive the unsettled-payment banner, so the field that
      // predicate reads must exist rather than being silently absent.
      for (const item of activity.filter(isPaymentActivityItem)) {
        expect(item).toHaveProperty('payment_attention_reason')
        expect(item.created_at).toBeTruthy() // timeAgo(created_at)
      }
    })

    it('orders the feed newest-first like the real route', () => {
      // The backend sorts the merged feed created_at-DESC, and the MCP-calls
      // panel renders in array order without re-sorting — an out-of-order
      // fixture would show a jumbled panel in the PR evidence.
      const { activity } = fx('/agent-activity/agent-research/activity') as {
        activity: ActivityItem[]
      }
      const times = activity.map((i) => Date.parse(i.created_at))
      expect(times).toEqual([...times].sort((a, b) => b - a))
    })

    it('carries `activity` in the generic empty fallback', () => {
      // SCREENSHOT_FIXTURE=empty (and any endpoint added later) must still
      // answer with an array here, not a missing key.
      expect(FIXTURE_EMPTY_FALLBACK).toMatchObject({ activity: [] })
      expect(fx('/agent-activity/agent-research/activity', 'empty')).toBeNull()
    })
  })

  it('seeds the SAME localStorage keys the app reads (parity with auth-storage)', () => {
    // A key rename in src/lib/auth-storage.ts must fail HERE — not silently
    // capture logged-out screenshots as PR evidence.
    expect(SEED_STORAGE_KEYS).toEqual({
      token: AUTH_TOKEN_STORAGE_KEY,
      activeSafe: ACTIVE_SAFE_STORAGE_KEY,
    })
  })

  describe('scenarios (#1409)', () => {
    const connect = (SCENARIOS as Record<string, ScenarioShape>)['connect-agent']
    const approve = (SCENARIOS as Record<string, ScenarioShape>)['connect-agent-approve']
    const approveLegacy = (SCENARIOS as Record<string, ScenarioShape>)['connect-agent-approve-legacy']
    const signerRemoval = (SCENARIOS as Record<string, ScenarioShape>)['account-signer-removal']
    // Cast the ENTRY, not the registry: `Record<string, StagedScenarioShape>`
    // would claim every scenario is staged, and only this one is.
    const backupRecovery = (SCENARIOS as Record<string, ScenarioShape>)[
      'account-backup-recovery'
    ] as StagedScenarioShape

    // The stage is module state in screenshot.mjs (the scenario's `run` resets
    // it per viewport for the same reason). Leaving it moved would make every
    // assertion below depend on which test ran last.
    afterEach(() => backupRecovery.stage('healthy'))

    const signersOf = (scenario: ScenarioShape) =>
      scenario.api(`/accounts/hybrid/${FIXTURE_SAFE_ADDRESS}/signers`, 'GET')

    it('overrides only the account signer set needed to reach the removal confirmation (#1199)', () => {
      const signers = signerRemoval.api('/accounts/hybrid/0x111/signers', 'GET')
      expect(signers).toMatchObject({
        owner_address: '0x' + 'ee'.repeat(20),
        passkeys: [expect.objectContaining({ key_id: '0x' + '11'.repeat(32) })],
      })
      expect(signerRemoval.api('/auth/me', 'GET')).toBeUndefined()
    })

    it('serves the healthy multi-signer set the card layout has to render (#1693)', () => {
      // The shared fixture is one passkey and no wallet — the "only one way to
      // approve" state. That shows neither the Wallet row nor a second passkey,
      // so the row layout this capture exists to evidence is not reachable
      // through it.
      const signers = backupRecovery.api('/accounts/hybrid/0x111/signers', 'GET') as {
        owner_address: string
        passkeys: { key_id: string; created_at: string }[]
      }
      expect(signers.owner_address).toBe('0x' + 'ee'.repeat(20))
      expect(signers.passkeys).toHaveLength(2)
      expect(new Set(signers.passkeys.map((p) => p.key_id)).size).toBe(2)
    })

    it('dates every passkey at noon UTC so the wrapped label is timezone-stable (#1679)', () => {
      // The label IS the evidence: passkeyRowLabel formats created_at in LOCAL
      // time, so a midnight timestamp would render a different day either side
      // of UTC and the committed PNG would stop matching what CI shoots.
      const signers = backupRecovery.api('/accounts/hybrid/0x111/signers', 'GET') as {
        passkeys: { created_at: string }[]
      }
      for (const pk of signers.passkeys) {
        expect(pk.created_at).toMatch(/T12:00:00\.000Z$/)
      }
      // Both dates are pinned, not just one: they are the wrap evidence, and a
      // regression that quietly shortened either would still pass a one-date
      // assertion while making the capture prove less than it claims.
      expect(signers.passkeys.map((p) => p.created_at)).toEqual([
        '2026-03-03T12:00:00.000Z',
        '2026-09-12T12:00:00.000Z',
      ])
    })

    it('leaves everything but the signer set to the shared fixture (#1693)', () => {
      expect(backupRecovery.api('/auth/me', 'GET')).toBeUndefined()
      expect(backupRecovery.api('/agents', 'GET')).toBeUndefined()
    })

    // ── The two states #1725 added to the same scenario ──────────────────────

    it('opens on the healthy set, whatever the last run left behind (#1725)', () => {
      // The stage is module state and `run` resets it per viewport. Pinned
      // here because the reset is the difference between the mobile pass
      // shooting the healthy card and shooting whatever the desktop pass
      // finished on — under the healthy capture's filename either way.
      backupRecovery.stage('load-error')
      backupRecovery.stage('healthy')
      expect(signersOf(backupRecovery)).toMatchObject({ owner_address: '0x' + 'ee'.repeat(20) })
    })

    it('serves exactly ONE way to approve for the warning capture (#1725)', () => {
      // `AccountSignersCard` renders the amber banner on
      // `wayCount < 2`, where `wayCount = passkeys.length + (owner_address ? 1 : 0)`.
      // Asserting that arithmetic rather than the shape it happens to take, so
      // a fixture that grew a second passkey fails HERE instead of quietly
      // filing a healthy render under the one-way name.
      backupRecovery.stage('one-way')
      const signers = signersOf(backupRecovery) as {
        owner_address: string | null
        passkeys: unknown[]
      }
      expect(signers.owner_address).toBeNull()
      expect(signers.passkeys).toHaveLength(1)
      expect(signers.passkeys.length + (signers.owner_address ? 1 : 0)).toBeLessThan(2)
    })

    it('reaches loadError the only way the product can — a non-2xx (#1725)', () => {
      // `useAccountSigners`'s `reload` sets `loadError` in its `catch`, and
      // `lib/api.ts` throws only on `!response.ok`. So NO 200 body reaches this
      // branch, however it is shaped — which is what the `ScenarioHttpError`
      // plumbing exists for, and why this test asserts the failure rather than
      // a payload. A regression that turned this back into a body would make
      // the capture a silent duplicate of the healthy one.
      backupRecovery.stage('load-error')
      const answer = signersOf(backupRecovery)
      expect(answer).toBeInstanceOf(ScenarioHttpError)
      expect((answer as unknown as { status: number }).status).toBeGreaterThanOrEqual(500)
    })

    it('still answers only the signer route in every stage (#1725)', () => {
      for (const stage of Object.keys(backupRecovery.stages)) {
        backupRecovery.stage(stage)
        expect(backupRecovery.api('/auth/me', 'GET'), stage).toBeUndefined()
        expect(backupRecovery.api('/agents', 'GET'), stage).toBeUndefined()
      }
    })

    it('refuses an unknown stage instead of serving the previous one (#1725)', () => {
      // A typo'd stage name that silently left the fixture where it was would
      // shoot the wrong state under the right filename — the exact
      // confidently-wrong-evidence shape the capture harness fails loudly for.
      expect(() => backupRecovery.stage('one-way-warning')).toThrow(/unknown stage/)
    })

    it('pins the setup at awaiting_connection for the whole capture', () => {
      // The shared e2e fixture flips to connected_local after the first status
      // read, which would end the waiting screen mid-capture. The scenario
      // must answer `awaiting_connection` EVERY time, not just once.
      const first = connect.api(`/agent-connection-setups/${SETUP_ID}`, 'GET')
      const second = connect.api(`/agent-connection-setups/${SETUP_ID}`, 'GET')
      expect(first).toMatchObject({ status: 'awaiting_connection', agent_id: null })
      expect(second).toMatchObject({ status: 'awaiting_connection' })
    })

    it('serves a safe WITHOUT chain_id for the unresolved-chain capture (#1844)', () => {
      // The capture's whole claim is that the modal reached the fallback path
      // through the wire, not through a hand-edited component. That only holds
      // if the served safe genuinely lacks `chain_id` — a scenario that quietly
      // kept the field would shoot the resolved screen under the unresolved
      // filename, which is exactly the confidently-wrong-evidence shape #1800
      // exists to prevent.
      const unresolved = (SCENARIOS as Record<string, ScenarioShape>)['add-funds-unresolved-chain']
      const me = unresolved.api('/auth/me', 'GET') as { safes: Record<string, unknown>[] }
      const list = unresolved.api('/user/safes', 'GET') as { safes: Record<string, unknown>[] }
      for (const { safes } of [me, list]) {
        expect(safes).toHaveLength(1)
        expect(safes[0]).not.toHaveProperty('chain_id')
        // Still a real, addressable safe — the hazard is a MISSING chain beside
        // a PRESENT address, so an empty safe would prove something else.
        expect(safes[0].safe_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(safes[0].id).toBe(FIXTURE_SAFE_ID)
        expect(safes[0]).not.toHaveProperty('account_type')
      }
      expect(unresolved.api('/agents', 'GET')).toBeUndefined()
    })

    it('keeps the resolved add-funds capture on the shared chain_id (#1844)', () => {
      // The pair is only evidence about the CHAIN if the chain is the only
      // thing that differs. The resolved half must therefore still carry
      // chain_id 84532 — the shared fixture's — while sharing its counterpart's
      // rail override (dropping `account_type`, which exists purely so the hero
      // renders its action buttons instead of the passkey-on-another-device
      // notice).
      const resolved = (SCENARIOS as Record<string, ScenarioShape>)['add-funds']
      const me = resolved.api('/auth/me', 'GET') as { safes: Record<string, unknown>[] }
      expect(me.safes).toHaveLength(1)
      expect(me.safes[0].chain_id).toBe(84532)
      expect(me.safes[0]).not.toHaveProperty('account_type')
      // Both safe endpoints must agree — a fixture where one says 84532 and the
      // other says nothing is a trap for the next scenario that reads the other.
      const list = resolved.api('/user/safes', 'GET') as { safes: Record<string, unknown>[] }
      expect(list.safes[0].chain_id).toBe(84532)
      expect(resolved.api('/agents', 'GET')).toBeUndefined()
    })

    it('serves the receive-funds pair differing by chain_id and nothing else (#1852)', () => {
      // Same contract as the #1844 pair above, asserted for the receive
      // surface. The pair is only evidence about the CHAIN if the chain is the
      // only thing that differs — and the unresolved capture only proves
      // suppression if its safe genuinely lacks `chain_id` on BOTH endpoints.
      const resolved = (SCENARIOS as Record<string, ScenarioShape>)['receive-funds']
      const unresolved = (SCENARIOS as Record<string, ScenarioShape>)['receive-funds-unresolved-chain']

      for (const endpoint of ['/auth/me', '/user/safes']) {
        const r = resolved.api(endpoint, 'GET') as { safes: Record<string, unknown>[] }
        const u = unresolved.api(endpoint, 'GET') as { safes: Record<string, unknown>[] }
        expect(r.safes).toHaveLength(1)
        expect(u.safes).toHaveLength(1)
        expect(r.safes[0].chain_id).toBe(84532)
        expect(u.safes[0]).not.toHaveProperty('chain_id')
        // A MISSING chain beside a PRESENT address is the hazard; an empty safe
        // would prove something else entirely.
        expect(u.safes[0].safe_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(u.safes[0].id).toBe(FIXTURE_SAFE_ID)
        // The rail override is the ONLY other difference from the shared
        // fixture, and both halves carry it, so `chain_id` is the sole variable.
        expect(r.safes[0]).not.toHaveProperty('account_type')
        expect(u.safes[0]).not.toHaveProperty('account_type')
      }
      expect(resolved.api('/agents', 'GET')).toBeUndefined()
      expect(unresolved.api('/agents', 'GET')).toBeUndefined()
    })

    it('answers the setup CREATE that the shared fixture does not key', () => {
      // Without this the modal's create step falls into the empty fallback and
      // never reaches step 4 — the capture would silently shoot the wrong screen.
      const created = connect.api('/agent-connection-setups', 'POST')
      expect(created).toMatchObject({
        setup_id: SETUP_ID,
        status: 'awaiting_connection',
        setup_prompt: expect.stringContaining('@haven_ai/connect'),
      })
    })

    it('leaves every other endpoint to the shared fixture', () => {
      // `undefined` (not null) is the fall-through signal — a scenario states
      // only what is special about it.
      expect(connect.api('/agents', 'GET')).toBeUndefined()
      expect(connect.api('/auth/me', 'GET')).toBeUndefined()
    })

    // #1684: the APPROVE screen — the one between the other two connect
    // scenarios' pins, and the screen that actually grants spend authority.
    describe('connect-agent-approve (#1684)', () => {
      it('pins the setup at connected_local with the runtime already configured', () => {
        // `resolveConnectStepView` only reaches the approval step when the
        // runtime reports configured; without both flags the capture would
        // silently shoot the "Finishing setup" state instead.
        const first = approve.api(`/agent-connection-setups/${SETUP_ID}`, 'GET') as {
          status: string
          agent_id: string
          install_status: Record<string, unknown>
        }
        const second = approve.api(`/agent-connection-setups/${SETUP_ID}`, 'GET')
        expect(first).toMatchObject({ status: 'connected_local', agent_id: 'agent-fixture-1' })
        expect(first.install_status).toMatchObject({
          local_mcp_configured: true,
          local_mcp_acknowledged: true,
        })
        expect(second).toMatchObject({ status: 'connected_local' })
      })

      it('carries a real budget and delegate address — the two things the screen shows', () => {
        const status = approve.api(`/agent-connection-setups/${SETUP_ID}`, 'GET') as {
          agent_budget: Array<{ allowance_amount: string }>
          delegate_address: string
        }
        // An empty budget would render "Waiting for budget" and prove nothing
        // about the row this issue trimmed the description in favour of.
        expect(status.agent_budget).toHaveLength(1)
        expect(status.agent_budget[0].allowance_amount).toBe('25000000')
        // The collapsed verification row's whole point is showing this.
        expect(status.delegate_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      })

      it('puts the LEGACY twin on the other rail, and ONLY by account_type', () => {
        // The rail branch reads `account_type` off /auth/me. Without this
        // override the legacy scenario would silently capture the DELEGATION
        // screen under the legacy filename — the exact wrong-screen failure
        // the scenario's own copy-based wait exists to catch.
        const me = approveLegacy.api('/auth/me', 'GET') as {
          safes: Array<{ account_type: string; id: string }>
          email: string
        }
        expect(me.safes[0].account_type).toBe('safe')
        // Same account otherwise — a scenario states only what is special.
        expect(me.email).toBe('fixture@haven.test')
        expect(me.safes[0].id).toBe(FIXTURE_SAFE_ID)
        const safes = approveLegacy.api('/user/safes', 'GET') as {
          safes: Array<{ account_type: string }>
        }
        // Both readers must agree: `useAgentConnectionSetup` resolves the rail
        // from /auth/me, but a disagreeing /user/safes would make the capture
        // depend on which hook won.
        expect(safes.safes[0].account_type).toBe('safe')
      })

      it('serves a reachable signer so the Approve button renders, not the connect fallback', () => {
        // `pickSigningPath` returns null on an empty signer set, which flips
        // BudgetGrantAction to its not-ready branch — a capture of the wrong
        // screen under the approve screen's filename.
        const signers = approve.api('/agents/agent-fixture-1/account-signers', 'GET') as {
          passkeys: unknown[]
        }
        expect(signers.passkeys).toHaveLength(1)
      })
    })

    /**
     * #1989: the legacy-account capture. Its whole value is that it differs
     * from the shared fixture in exactly ONE field, so the contract worth
     * pinning is that difference and nothing else — a scenario that quietly
     * rebuilt the account would capture a different account and still look
     * right.
     */
    describe('retired-rail-account (#1989)', () => {
      const legacy = (SCENARIOS as Record<string, ScenarioShape>)['retired-rail-account']

      it('puts the SHARED fixture account on the legacy rail, changing only account_type', () => {
        const me = legacy.api('/auth/me', 'GET') as {
          email: string
          safes: Array<Record<string, unknown>>
        }
        const list = legacy.api('/user/safes', 'GET') as {
          safes: Array<Record<string, unknown>>
        }

        // Both readers must agree. `AccountDetailClient` resolves the account
        // from AuthContext, but a disagreeing /user/safes would make the
        // capture depend on which one won.
        expect(me.safes[0].account_type).toBe('safe')
        expect(list.safes[0].account_type).toBe('safe')

        // Same account, not a lookalike — the id is what the capture navigates
        // to, so a drifted id would 404 into "Account not found" and the
        // scenario's own absence check would pass for the wrong reason.
        expect(me.safes[0].id).toBe(FIXTURE_SAFE_ID)
        expect(me.email).toBe('fixture@haven.test')

        // And ONLY account_type differs. Asserted positively so this fails if
        // the scenario starts rebuilding the fixture instead of spreading it.
        expect(me.safes[0].safe_address).toBe(FIXTURE_SAFE_ADDRESS)
        expect(me.safes[0].is_default).toBe(true)
      })

      it('leaves every other endpoint to the shared fixture', () => {
        expect(legacy.api('/agents', 'GET')).toBeUndefined()
        expect(legacy.api(`/balances/${FIXTURE_SAFE_ADDRESS}`, 'GET')).toBeUndefined()
      })
    })

    // The 'send-review' (#1856) fixture contract was asserted here. Both the
    // scenario and its subject (`SendModal`) are deleted by #1989 (epic #1440),
    // so the assertions went with them rather than being repointed — a fixture
    // contract for a scenario that no longer exists is the definition of a
    // guard over the empty set.
  })
})
