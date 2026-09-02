import { afterEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the cast below
import {
  fixtureFor,
  FIXTURE_AGENTS,
  FIXTURE_USER,
  SEED_STORAGE_KEYS,
  FIXTURE_EMPTY_FALLBACK,
  SCENARIOS,
  ScenarioHttpError,
  ScenarioHttpDelay,
} from '../../scripts/screenshot.mjs'
import { AUTH_TOKEN_STORAGE_KEY, ACTIVE_SAFE_STORAGE_KEY } from '../lib/auth-storage'

import {
  isMcpToolCallActivityItem,
  isPaymentActivityItem,
  type ActivityItem,
  type PaymentActivityItem,
} from '../hooks/useAgentActivity'
import { machinePaymentLifecycle } from '@haven_ai/core'

const fx = fixtureFor as (apiPath: string, mode?: string) => Record<string, unknown> | null

/** A scenario that HAS an `api` hook — the shape these assertions exercise. */
type ScenarioShape = {
  api: (apiPath: string, method: string) => Record<string, unknown> | undefined
}

/**
 * Look a scenario up and assert it actually has an `api` hook.
 *
 * The harness treats `api` as optional — `scenario?.api?.(api, req.method())`
 * — and some scenarios are seed-only or staged. A blanket registry cast would
 * therefore state something false about the registry. This says what each
 * lookup actually needs and fails by name if a scenario loses its hook.
 */
const scenarioWithApi = (name: string): ScenarioShape => {
  const scenario = (SCENARIOS as Record<string, Partial<ScenarioShape>>)[name]
  if (typeof scenario?.api !== 'function') {
    throw new Error(`scenario '${name}' has no api hook`)
  }
  return scenario as ScenarioShape
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
    // #2106 moved `/agents/:id/delegations` OUT of this list — it is keyed
    // now (see the delegation-rail case below), so it can no longer stand as
    // this assertion's example of an unkeyed path. The rule being pinned is
    // unchanged; only the specimen moved.
    expect(fx('/reporting/summary')).toBeNull()
    expect(fx('/contacts/ct-1/history')).toBeNull()
  })

  // #2106: `/custody` renders a delegation-rail account's real spend
  // authority from this endpoint. Both recipient states are seeded on
  // purpose — a PINNED recipient (an AllowedCalldataEnforcer caveat) and an
  // open one — because the page presents them differently and a fixture with
  // only one of them cannot evidence that.
  describe('delegation budgets (#2106)', () => {
    it('keys the delegations endpoint for the fixture agents', () => {
      const pinned = fx('/agents/agent-research/delegations') as {
        delegations: { recipient_address: string | null; status: string; budget_atomic: string }[]
      }
      expect(pinned.delegations).toHaveLength(1)
      expect(pinned.delegations[0].status).toBe('active')
      expect(pinned.delegations[0].recipient_address).toMatch(/^0x/)

      // The open-recipient budget sits on `agent-retired`. #2413 removed the
      // legacy `agent-ops` fixture entirely — the API cannot return a
      // legacy-rail agent any more, so a fixture serving one would photograph
      // a screen production cannot produce.
      const open = fx('/agents/agent-retired/delegations') as {
        delegations: { recipient_address: string | null }[]
      }
      expect(open.delegations[0].recipient_address).toBeNull()
    })

    it('gives the user exactly ONE default account (#2202)', () => {
      // Also `haven-reviewer`'s: two-default is union-legal, path-impossible
      // and RENDERED (`AccountsOverviewClient.tsx` badges the default), and it
      // survived the suite green under mutation. The app layer enforces a
      // single default — `CLEAR_DEFAULT_SAFES_FOR_USER_SQL` runs before
      // `SET_SAFE_DEFAULT_SQL` (`infra/repositories/user-safes.ts:160-163`) —
      // so a second `is_default: true` is a state no write path leaves behind.
      // #2413 removed the second (legacy) account, so the non-vacuity guard
      // this had — "one safe cannot disagree" — is gone with it. What remains
      // falsifiable is that the fixture never seeds a second default, which is
      // what `CLEAR_DEFAULT_SAFES_FOR_USER_SQL` guarantees in production.
      const safes = (FIXTURE_USER as unknown as { safes: { is_default: boolean; account_type: string }[] }).safes
      expect(safes.filter((s) => s.is_default)).toHaveLength(1)
      expect(safes.every((s) => s.account_type === 'delegator_hybrid')).toBe(true)
    })

    it('projects `allowances` from the delegation for every delegation-rail agent', () => {
      // `AgentDetailClient` derives DelegationBudgetCard's token list from
      // `allowances`; an agent with a delegation but an empty projection
      // renders raw atomic units ("250000000 per week"). On the real rail
      // `deriveDelegationAllowances` fills it, so the fixture must too.
      for (const agent of FIXTURE_AGENTS.filter((a) => a.account_type === 'delegator_hybrid')) {
        const res = fx(`/agents/${agent.id}/delegations`) as {
          delegations: { budget_atomic: string }[]
        }
        if (res.delegations.length === 0) continue
        expect(agent.allowances.length).toBeGreaterThan(0)
      }
    })

    it('serves an empty list — never null — for an agent with no budget', () => {
      // Falling through to the generic shape would be wrong here: the generic
      // fallback's `delegations: []` happens to match, but keying it means the
      // harness answers the same shape whether or not the id is known, which
      // is what stops an unseeded agent rendering a crashed card.
      expect(fx('/agents/agent-nobody/delegations')).toEqual({ delegations: [] })
    })
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

    /**
     * #2120 — the evidence pipeline must not photograph an approval state.
     *
     * These seeds are the input to every `npm run screenshot` capture, which
     * is what the design-review pass judges. Seeding a state the backend
     * cannot produce does not make weak evidence — it makes evidence of
     * something that never happens, which a reviewer then signs off on.
     * Everything asserted here is pinned to a hardcoded backend value, named
     * beside it, so this stays a comparison rather than a preference.
     */
    describe('no approval state is seeded into the evidence (#2120)', () => {
      it('mirrors the routes that hardcode every approval count to 0', () => {
        // routes/dashboard.ts:84 — `const actionableApprovals = 0`, mirrored
        // into `pendingApprovals` on the same response.
        expect(fx('/dashboard/overview')).toMatchObject({
          actionableApprovals: 0,
          pendingApprovals: 0,
        })
        // routes/agent-activity.ts:129 and :242 — `const pendingApprovals = 0`.
        expect(fx('/agent-activity/agent-research/stats')).toMatchObject({
          pending_approvals: 0,
        })
        expect(fx('/agent-activity/feed')).toMatchObject({ pending_approvals: 0 })
      })

      it('seeds no approval activity row on any keyed activity endpoint', () => {
        // #2055 removed the approval entries from both activity builders, so
        // `type: 'approval'` is not an emittable row kind — and with it went
        // the only path to an approval status on a row.
        const feeds = [
          fx('/agent-activity/agent-research/activity'),
          fx('/agent-activity/agent-ops/activity'),
          fx('/agent-activity/feed'),
        ] as { activity: ActivityItem[] }[]
        const rows = feeds.flatMap((f) => f.activity)
        expect(rows.length).toBeGreaterThan(0) // positive control: not vacuous
        expect(rows.map((r) => r.type).filter((t) => t !== 'payment' && t !== 'mcp_tool_call')).toEqual([])
        for (const row of rows.filter(isPaymentActivityItem)) {
          // The exact statuses the retired queue used to mint.
          expect([row.id, row.status as string]).not.toEqual([
            row.id,
            expect.stringMatching(/^(pending|pending_approval|approved|proposed|rejected|executed)$/),
          ])
        }
      })
    })

    /**
     * #2126 — same defect class as #2120, in the payment-flow-status subsystem.
     *
     * `payment_flow_status` / `payment_attention_reason` are DERIVED per row by
     * the backend (`routes/agent-activity.ts:50-55` and `:182-187` call
     * `machinePaymentLifecycle` and spread its two outputs), never read from a
     * column. A seed that restates them by hand is asserting a derivation
     * output — and can therefore state one the derivation would never produce
     * from the same row's inputs. So do not restate: re-derive with the SHARED
     * function and compare.
     */
    describe('every seeded payment flow status is what the derivation returns (#2126)', () => {
      /** Rows are the route's OUTPUT shape, so pick the derivation's inputs back out of it. */
      const derive = (row: PaymentActivityItem) =>
        machinePaymentLifecycle({
          rail: row.source,
          paymentStatus: row.status,
          paymentProofStatus: row.payment_proof_status,
          // The reconciliation event is an input the route reads from its own
          // query and never echoes; the emitted `payment_attention_reason` is
          // the only trace of it, and the two unions share their single member.
          // If `MachinePaymentAttentionReason` ever gains a member whose name
          // is NOT the reconciliation event that produces it, this round-trip
          // stops being an identity and needs an explicit map instead.
          reconciliationEventType: row.payment_attention_reason,
        })

      const seededPaymentRows = () => {
        const feeds = [
          fx('/agent-activity/agent-research/activity'),
          fx('/agent-activity/agent-ops/activity'),
          fx('/agent-activity/feed'),
        ] as { activity: ActivityItem[] }[]
        return feeds.flatMap((f) => f.activity).filter(isPaymentActivityItem)
      }

      it('derives, rather than restates, payment_flow_status on every seeded row', () => {
        const rows = seededPaymentRows()
        expect(rows.length).toBeGreaterThan(0) // positive control: not vacuous
        for (const row of rows) {
          const lifecycle = derive(row)
          expect([row.id, row.payment_flow_status ?? null]).toEqual([
            row.id,
            lifecycle.paymentFlowStatus,
          ])
          expect([row.id, row.payment_attention_reason ?? null]).toEqual([
            row.id,
            lifecycle.paymentAttentionReason,
          ])
        }
      })

      it('seeds only a proof status the evidence writer can construct', () => {
        // `payment_proof_status` is `machine_payment_evidence.proof_status`
        // (`infra/repositories/agent-activity.ts:99`, `:164`). Its whole domain
        // is `PaymentProofStatus` — `modules/mpp/evidence.ts:38-41` — with
        // `payment_confirmed` the column default (migration 014). 'verified',
        // which pay-1 carried, is not a member and no write site emits it.
        const CONSTRUCTIBLE = [
          'payment_confirmed',
          'merchant_response_observed',
          'protocol_receipt_attached',
        ]
        const rows = seededPaymentRows()
        expect(rows.length).toBeGreaterThan(0) // positive control: not vacuous
        for (const row of rows) {
          if (row.payment_proof_status == null) continue
          expect([row.id, row.payment_proof_status]).toEqual([
            row.id,
            expect.stringMatching(new RegExp(`^(${CONSTRUCTIBLE.join('|')})$`)),
          ])
        }
      })

      /**
       * #2147 — the attention half of the same describe block, extending it
       * rather than standing a parallel one beside it.
       *
       * The `derives, rather than restates` test above round-trips
       * `payment_attention_reason` back in as `reconciliationEventType`, so it
       * proves the seeded PAIR is self-consistent. What it structurally cannot
       * see is whether the reconciliation event could have been recorded at
       * all: `machinePaymentLifecycle` never learns the tx hash, and the
       * endpoint that writes the event refuses on exactly that. So the
       * preconditions are asserted here, against
       * `modules/mpp/reconciliation.ts`.
       */
      const attentionRows = () =>
        seededPaymentRows().filter(
          (r) => r.payment_attention_reason === 'merchant_retry_rejected_after_payment',
        )

      it('seeds the needs_attention state at all — the #2147 gap', () => {
        // Non-vacuity for the two assertions below, and the guard against
        // silently regressing to the state this issue was filed about: with no
        // attention row, `needs_attention`'s badge and the "Recoverable funds"
        // banner's specific copy branch (`AgentDetailClient.tsx:634-636`) have
        // no rendered evidence anywhere in the capture suite.
        const rows = attentionRows()
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.map((r) => r.payment_flow_status)).toEqual(rows.map(() => 'needs_attention'))
      })

      it('seeds an attention row the reconciliation endpoint would have accepted', () => {
        // `handleReconciliationEvent` (`modules/mpp/reconciliation.ts:40-48`)
        // answers 409 "Reconciliation events require a confirmed payment"
        // unless BOTH hold, and stores `payment.tx_hash.toLowerCase()` (`:73`).
        // An attention row missing either describes an event that could never
        // have been written, however consistent its derived pair looks.
        for (const row of attentionRows()) {
          expect([row.id, row.status, row.tx_hash != null]).toEqual([row.id, 'confirmed', true])
        }
      })

      it('leaves an attention row at the proof status its own path can reach', () => {
        // `haven-reviewer`'s should-fix: the #2126 proof-status test above
        // checks UNION MEMBERSHIP, so `merchant_response_observed` on this row
        // passes it while being unreachable — and the value RENDERS, verbatim,
        // as `TransactionDetailPanel.tsx:170`'s "Proof" row. Union membership
        // is the wrong bar for a row whose path is known.
        //
        // On the retry-rejected path the proof status is still the
        // settlement-time base-row literal `'payment_confirmed'`
        // (`infra/repositories/machine-payments.ts:49`; column default,
        // migration `014:13`). The only writer that raises it is
        // `proofStatusForAttach` (`modules/mpp/evidence.ts:196-200`), reached
        // from the agent-reported attach — and the SDK throws at
        // `merchant-completion.ts:137-149` before it can report any evidence.
        // A merchant that answered well enough to attach a response would not
        // have produced the rejection this row is about.
        for (const row of attentionRows()) {
          expect([row.id, row.payment_proof_status]).toEqual([row.id, 'payment_confirmed'])
        }
      })

      it('agrees with the agent row that the reconciliation event is open', () => {
        // One event, two reads. `has_stranded_funds` is
        // `EXISTS(… event_type = 'merchant_retry_rejected_after_payment' AND
        // status = 'open')` over the agent's intents
        // (`infra/repositories/agents.ts:186-192`, `:206-212`) — the same row
        // the activity feed derives `payment_attention_reason` from. A fixture
        // where the two disagree serves a contradiction no backend can.
        const flagged = new Set(
          (FIXTURE_AGENTS as { id: string; has_stranded_funds?: boolean }[])
            .filter((a) => a.has_stranded_funds)
            .map((a) => a.id),
        )
        const withAttention = new Set(attentionRows().map((r) => r.agent_id))
        expect([...withAttention].sort()).toEqual([...flagged].sort())
      })

      // ── The banner's GATE, not just its copy (#2194) ─────────────────────
      //
      // #2147 photographed the "Recoverable funds in agent wallet" banner's
      // unsettled-payment copy branch and reported, in the same PR, that the
      // capture did not prove what it looked like it proved: the banner is
      // gated on `hasRecoverableUsdc`, which checks the configured sweep floor
      // (`hooks/useDelegateBalance.ts:88-93`), and
      // `/agents/:id/delegate-balance` was UNKEYED — so it fell through to
      // `FIXTURE_EMPTY_FALLBACK`, which has no `usdc_atomic`, and `undefined
      // !== '0'` rendered the banner from a body with no balance in it.
      //
      // This is the subtlest member of the #2120/#2126/#2147 family. Those
      // seeded states the product cannot reach. Here the state IS reachable —
      // the fixture reached it by a route the API cannot take, and the PNG is
      // indistinguishable either way. So these guards assert the RESPONSE, not
      // the rendered outcome.
      const agentIds = () => (FIXTURE_AGENTS as { id: string }[]).map((a) => a.id)
      const balanceFor = (id: string) =>
        fixtureFor(`/agents/${id}/delegate-balance`) as
          | (Record<string, unknown> & { usdc_atomic?: string })
          | ScenarioHttpError
          | null

      it('keys /agents/:id/delegate-balance for EVERY fixture agent — the #2194 gap', () => {
        // Non-vacuity for the rest, and the guard against regressing to the
        // mechanism itself rather than to this one instance of it: a `null`
        // here is the fallback answering, and the fallback cannot say "not
        // seeded" — it says 200 with a body that has no `usdc_atomic`.
        expect(agentIds().length).toBeGreaterThan(0)
        for (const id of agentIds()) {
          expect([id, balanceFor(id)]).not.toEqual([id, null])
        }
        expect(FIXTURE_EMPTY_FALLBACK).not.toHaveProperty('usdc_atomic')
      })

      it('answers 422 for exactly the agents the route would refuse', () => {
        // `routes/agents.ts:140-142` — `if (!agent.delegate_address) return
        // reply.code(422).send({ error: 'Agent has no delegate address' })`.
        // Both directions: a null delegate MUST 422, and an agent that has one
        // must NOT, or the fixture is answering for a different agent than the
        // one it names.
        const agents = FIXTURE_AGENTS as { id: string; delegate_address: string | null }[]
        for (const agent of agents) {
          const answer = balanceFor(agent.id)
          if (agent.delegate_address === null) {
            expect(answer).toBeInstanceOf(ScenarioHttpError)
            expect(answer as ScenarioHttpError).toMatchObject({
              status: 422,
              body: { error: 'Agent has no delegate address' },
            })
          } else {
            expect([agent.id, answer instanceof ScenarioHttpError]).toEqual([agent.id, false])
          }
        }
      })

      it('keeps the recovery loading capture pending instead of photographing the settled branch', () => {
        const loading = scenarioWithApi('retired-rail-recovery-loading')
        const response = loading.api('/agents/agent-research/delegate-balance', 'GET') as unknown
        expect(response).toBeInstanceOf(ScenarioHttpDelay)
        expect(response).toMatchObject({ delayMs: 2_000, body: undefined })
      })

      it('serves the exact field set the route builds, and nothing else', () => {
        // `routes/agents.ts:159-172` returns these nine keys; the named
        // `DelegateBalance` schema (`openapi/spec.ts:6516-6534`) requires all
        // nine. A missing one is how this bug worked — `usdc_atomic` absent
        // reads as "not zero" — and an EXTRA one is a field the generated type
        // does not have, i.e. a shape the frontend could not have been written
        // against.
        const expected = [
          'chain_id', 'delegate_address', 'eth', 'eth_atomic',
          'safe_address', 'sweep_min_usdc', 'usdc', 'usdc_address', 'usdc_atomic',
        ]
        const served = agentIds()
          .map((id) => [id, balanceFor(id)] as const)
          .filter(([, b]) => b !== null && !(b instanceof ScenarioHttpError))
        expect(served.length).toBeGreaterThan(0)
        for (const [id, body] of served) {
          expect([id, Object.keys(body as object).sort()]).toEqual([id, expected])
        }
      })

      it('derives the stranded amount from the open reconciliation event, rather than restating it', () => {
        // The delegate holds what the funding leg put there and the merchant
        // never pulled. On the EIP-3009 two-leg x402 shape `payTo` IS the
        // agent's own delegate EOA — that is what selects the funding leg
        // (`modules/x402/scheme-selection.ts:56-58`) — and on
        // `merchant_retry_rejected_after_payment` the SDK throws "x402 retry
        // failed after Haven funded the delegate wallet"
        // (`packages/sdk/src/merchant-completion.ts:137-145`) after recording
        // the event. So the balance is the intent's own amount, and an amount
        // chosen freely here would photograph a number no incident produced.
        const rows = attentionRows()
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          // `agent_id` is optional on the wire type; an attention row without
          // one could not have been joined to an agent at all.
          expect([row.id, typeof row.agent_id]).toEqual([row.id, 'string'])
          const body = balanceFor(row.agent_id as string) as Record<string, unknown>
          expect(body).not.toBeInstanceOf(ScenarioHttpError)
          expect([row.id, body.usdc_atomic]).toEqual([row.id, row.amount_raw])
          // `usdc` and `amount_human` are equal by CONSTRUCTION, not
          // coincidence: `routes/agents.ts:165` formats with
          // `formatTokenValue(usdcAtomic, 6)` and the intent's human string is
          // `formatTokenValue(amountRaw, tokenConfig.decimals)`
          // (`modules/x402/authorize.ts:66`) — one function, one atomic input,
          // the same six decimals.
          expect([row.id, body.usdc]).toEqual([row.id, row.amount])
        }
      })

      it('renders the AMOUNT-bearing sentence, not the degraded fallback', () => {
        // `strandedSummary` (`AgentDetailClient.tsx:296-300`) needs a nonzero
        // atomic amount AND a truthy `usdc`, or the banner degrades to
        // "Recover **it** to your Haven wallet" (#1098 made that deliberate:
        // "Recover undefined USDC" is worse). The real route always returns
        // both as strings, so the degraded branch is what a PARTIAL response
        // looks like — and it is the branch #2147's capture actually showed,
        // because the fallback supplied neither field. This guard is why the
        // amount-bearing sentence now has rendered evidence.
        const rows = attentionRows()
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect([row.id, typeof row.agent_id]).toEqual([row.id, 'string'])
          const body = balanceFor(row.agent_id as string) as { usdc_atomic: string; usdc: string }
          expect([row.id, BigInt(body.usdc_atomic) >= BigInt(10000)]).toEqual([row.id, true]) // configured 0.01 USDC floor
          expect([row.id, Boolean(body.usdc)]).toEqual([row.id, true]) // strandedSummary
        }
      })

      it('describes the agent it is keyed by — every echoed field, not just the amounts', () => {
        // `haven-reviewer`'s should-fix, applied, and it is the shape #2194 is
        // about one field further out: `chain_id: 1` or another agent's
        // `delegate_address` here is union-legal, path-impossible (the route
        // echoes `agent.delegate_address`, `agent.safe_address` and
        // `agent.safe_chain_id ?? DEFAULT_CHAIN_ID` — `routes/agents.ts:143,159-162`
        // — it cannot answer for a different agent or a different chain), and
        // the reviewer's own mutations of both left all 77 tests green.
        //
        // Latent rather than live TODAY: `AgentDetailClient` reads the delegate
        // and chain off the AGENT record, not off this body
        // (`AgentDetailClient.tsx:302,310`), so nothing currently renders these
        // three. `SweepClient.tsx:13` already types `delegate_address` off this
        // response though, so "no consumer" is a fact about today's callers,
        // not a property of the shape. Pinned now rather than after the first
        // caller reads it.
        const agents = FIXTURE_AGENTS as {
          id: string
          delegate_address: string | null
          safe_address: string
          safe_chain_id: number
        }[]
        const usdcAddress = (fixtureFor('/agents/agent-research/delegate-balance') as {
          usdc_address: string
        }).usdc_address
        // One token per chain: the SAME address the API fixture's allowance
        // rows carry, which `chain-fed-capture-guard` pins to the shared
        // registry. Two USDC addresses in one fixture is a contradiction the
        // deployment cannot serve.
        expect(typeof usdcAddress).toBe('string')
        let checked = 0
        for (const agent of agents) {
          const body = balanceFor(agent.id)
          if (body === null || body instanceof ScenarioHttpError) continue
          checked += 1
          expect([agent.id, body.delegate_address]).toEqual([agent.id, agent.delegate_address])
          expect([agent.id, body.safe_address]).toEqual([agent.id, agent.safe_address])
          expect([agent.id, body.chain_id]).toEqual([agent.id, agent.safe_chain_id])
          expect([agent.id, body.usdc_address]).toEqual([agent.id, usdcAddress])
        }
        expect(checked).toBeGreaterThan(0)
      })

      it('formats every human amount the way formatTokenValue actually would', () => {
        // The #2197 reviewer's finding, applied to a numeric field: a value can
        // be union-legal — any string satisfies `type: 'string'` — path-
        // impossible, and RENDER. `'0.00'` for an empty delegate is exactly
        // that: `formatTokenValue` returns early on a zero raw value
        // (`domain/tokens.ts:37`) and never reaches the two-decimal padding at
        // `:44`, so the route emits `'0'`. Asserted as the emitter's two
        // properties rather than a copy of it: a port of the function here
        // would be a second implementation free to drift.
        const bodies = agentIds()
          .map((id) => [id, balanceFor(id)] as const)
          .filter(([, b]) => b !== null && !(b instanceof ScenarioHttpError)) as [
          string,
          Record<string, string>,
        ][]
        expect(bodies.length).toBeGreaterThan(0)
        for (const [id, body] of bodies) {
          for (const [human, atomic, decimals] of [
            [body.eth, body.eth_atomic, 18],
            [body.usdc, body.usdc_atomic, 6],
          ] as [string, string, number][]) {
            if (atomic === '0') {
              expect([id, human]).toEqual([id, '0'])
              continue
            }
            // Non-zero: at least two decimal places (`:44`), at most six
            // (`:46`), and the string must re-parse to the atomic value it
            // claims to format.
            //
            // `haven-reviewer`'s nit, applied: reconstruct via the INTEGER and
            // FRACTIONAL halves separately. Concatenating the whole string and
            // padding by `decimals - frac.length` is only correct while the
            // integer part is a single non-zero digit — for `'0.005'` it keeps
            // the leading `'0'` and produces one digit too many, a FALSE
            // failure on a correctly formatted value. Nothing seeded here is
            // sub-unit today, which is exactly why it would have been found by
            // a future amount rather than by this run.
            const [int = '', frac = ''] = human.split('.')
            expect([id, frac.length >= 2 && frac.length <= 6]).toEqual([id, true])
            const reconstructed = (
              BigInt(int) * 10n ** BigInt(decimals) +
              BigInt(frac.padEnd(decimals, '0'))
            ).toString()
            expect([id, reconstructed]).toEqual([id, atomic])
          }
        }
      })
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
    const connect = scenarioWithApi('connect-agent')
    const approve = scenarioWithApi('connect-agent-approve')
    const signerRemoval = scenarioWithApi('account-signer-removal')
    // Cast the ENTRY, not the registry: `Record<string, StagedScenarioShape>`
    // would claim every scenario is staged, and only this one is.
    const backupRecovery = scenarioWithApi('account-backup-recovery') as StagedScenarioShape

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
      const unresolved = scenarioWithApi('add-funds-unresolved-chain')
      const me = unresolved.api('/auth/me', 'GET') as { safes: Record<string, unknown>[] }
      const list = unresolved.api('/user/safes', 'GET') as { safes: Record<string, unknown>[] }
      for (const { safes } of [me, list]) {
        expect(safes).toHaveLength(1)
        expect(safes[0]).not.toHaveProperty('chain_id')
        // Still a real, addressable safe — the hazard is a MISSING chain beside
        // a PRESENT address, so an empty safe would prove something else.
        expect(safes[0].safe_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(safes[0].id).toBe(FIXTURE_SAFE_ID)
        // #2202: the rail is named, and it matches the resolved twin's — the
        // pair is evidence about `chain_id` only while `chain_id` is the one
        // field that differs between them.
        expect(safes[0].account_type).toBe('safe')
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
      const resolved = scenarioWithApi('add-funds')
      const me = resolved.api('/auth/me', 'GET') as { safes: Record<string, unknown>[] }
      expect(me.safes).toHaveLength(1)
      expect(me.safes[0].chain_id).toBe(84532)
      // #2202: the rail is now NAMED rather than expressed by absence. An
      // absent `account_type` is not a state the API can serve — the column is
      // `NOT NULL DEFAULT 'safe'` (`041_hybrid_accounts.ts:29`) — and `railOf`
      // reads `'safe'` and `undefined` identically, so nothing rendered
      // differently. What this still pins is that the override is the SAME on
      // both halves of the pair, which is what makes `chain_id` the sole
      // variable.
      expect(me.safes[0].account_type).toBe('safe')
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
      const resolved = scenarioWithApi('receive-funds')
      const unresolved = scenarioWithApi('receive-funds-unresolved-chain')

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
        // #2202: named rather than absent — see the #1844 pair above. Both
        // halves carry it, which is the invariant this line is really for.
        expect(r.safes[0].account_type).toBe('safe')
        expect(u.safes[0].account_type).toBe('safe')
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
      const legacy = scenarioWithApi('retired-rail-account')

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

      it('keeps legacy agent records readable without delegation budgets', () => {
        const agents = legacy.api('/agents', 'GET') as {
          agents: Array<{ safe_id: string; account_type: string; allowances: unknown[] }>
        }
        const sharedAgents = agents.agents.filter((agent) => agent.safe_id === FIXTURE_SAFE_ID)
        expect(sharedAgents.length).toBeGreaterThan(0)
        expect(sharedAgents.every((agent) => agent.account_type === 'safe')).toBe(true)
        expect(sharedAgents.every((agent) => agent.allowances.length === 0)).toBe(true)
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
