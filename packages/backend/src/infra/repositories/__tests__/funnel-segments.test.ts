/**
 * Real-DB tests for the segmented onboarding funnel (#2529, D1 of epic #2519).
 *
 * The claim under test is a claim about what Postgres returns — a CTE, a LEFT
 * JOIN, DISTINCT ON attribution and COUNT(DISTINCT) semantics — so it belongs
 * on the #1220 harness rather than on a positional `vi.mock('db.js')` chain
 * that would only prove the SQL string was passed somewhere. Zero mocks.
 *
 * The first test is the one that carries the design. Attribution has to be
 * per USER rather than per event, because only `signed_up` and `agent_created`
 * carry the segment keys: attributing per event reports agent-driven signups
 * and then zero agent-driven first payments, which reads as "agents never
 * convert" when it means "the later event does not restate the marker".
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { insertUser } from '../users.js'
import {
  queryFunnelSegments,
  isFunnelSegment,
  FUNNEL_SEGMENTS,
  UNATTRIBUTED,
} from '../onboarding-funnel.js'

const WINDOW_FROM = new Date('2026-01-01T00:00:00Z')
const WINDOW_TO = new Date('2027-01-01T00:00:00Z')

let seq = 0

async function newUser(): Promise<string> {
  const n = ++seq
  const user = await insertUser(`Funnel ${n}`, `funnel-${n}-${Date.now()}@example.com`, 'hash', null)
  return user.id
}

/**
 * Writes the event SYNCHRONOUSLY. `emitFunnelEvent` is deliberately
 * fire-and-forget and swallows everything, so a test that used it would race
 * its own assertions and pass on a swallowed error. Same table, same columns.
 */
async function event(
  userId: string,
  evt: string,
  metadata: Record<string, unknown> | null,
  createdAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO onboarding_events (user_id, event, metadata, created_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, evt, metadata != null ? JSON.stringify(metadata) : null, createdAt],
  )
}

function stepUsers(steps: { event: string; users: number }[], evt: string): number {
  return steps.find((s) => s.event === evt)?.users ?? 0
}

describeDb('queryFunnelSegments — real Postgres', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('carries a user\'s marker across steps that never restate it', async () => {
    const agentDriven = await newUser()
    await event(agentDriven, 'signed_up', { handoff_via: 'agent' }, '2026-06-01T10:00:00Z')
    // Neither of these carries handoff_via — which is the real shape: only
    // signed_up and agent_created write the key.
    await event(agentDriven, 'safe_funded', { safe_address: '0x1' }, '2026-06-01T11:00:00Z')
    await event(agentDriven, 'first_payment_settled', { payment_id: 'p1' }, '2026-06-01T12:00:00Z')

    const organic = await newUser()
    await event(organic, 'signed_up', null, '2026-06-02T10:00:00Z')
    await event(organic, 'first_payment_settled', { payment_id: 'p2' }, '2026-06-02T12:00:00Z')

    const groups = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'via')
    const agentGroup = groups.find((g) => g.value === 'agent')
    expect(agentGroup).toBeDefined()

    // The assertion the per-event shape would fail: the marker reaches the
    // LAST step, so conversion is answerable.
    expect(stepUsers(agentGroup!.steps, 'signed_up')).toBe(1)
    expect(stepUsers(agentGroup!.steps, 'safe_funded')).toBe(1)
    expect(stepUsers(agentGroup!.steps, 'first_payment_settled')).toBe(1)

    const organicGroup = groups.find((g) => g.value === UNATTRIBUTED)
    expect(stepUsers(organicGroup!.steps, 'signed_up')).toBe(1)
    expect(stepUsers(organicGroup!.steps, 'first_payment_settled')).toBe(1)
  })

  it('counts DISTINCT users, so a multi-agent user cannot exceed 100%', async () => {
    const user = await newUser()
    await event(user, 'signed_up', { handoff_via: 'agent' }, '2026-06-01T10:00:00Z')
    // agent_created is repeatable — three rows, ONE user. COUNT(*) here would
    // report 3 created against 1 signed up: a 300% conversion.
    await event(user, 'agent_created', { handoff_via: 'agent', agent_id: 'a1' }, '2026-06-01T10:01:00Z')
    await event(user, 'agent_created', { handoff_via: 'agent', agent_id: 'a2' }, '2026-06-01T10:02:00Z')
    await event(user, 'agent_created', { handoff_via: 'agent', agent_id: 'a3' }, '2026-06-01T10:03:00Z')

    const [group] = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'via')
    expect(group.value).toBe('agent')
    // 1, not 3. This is the whole assertion: three rows, one user.
    expect(stepUsers(group.steps, 'agent_created')).toBe(1)
    expect(stepUsers(group.steps, 'agent_created')).toBeLessThanOrEqual(
      stepUsers(group.steps, 'signed_up'),
    )
    // NOT asserted via `conversionFromPrev`, which is null here and would have
    // passed a `toBeLessThanOrEqual` for the wrong reason: `agent_created`'s
    // predecessor in FUNNEL_ORDER is `safe_imported`, one of the three stages
    // retired to a permanent zero (#1984/#2020), so there is nothing to
    // convert from. The count is the honest instrument for over-counting.
    expect(group.steps.find((s) => s.event === 'agent_created')!.conversionFromPrev).toBeNull()
  })

  it('segments run_mode, and an unreported run_mode is not prose', async () => {
    const jsonUser = await newUser()
    await event(jsonUser, 'signed_up', null, '2026-06-01T10:00:00Z')
    await event(jsonUser, 'agent_created', { run_mode: 'json' }, '2026-06-01T10:01:00Z')

    const proseUser = await newUser()
    await event(proseUser, 'signed_up', null, '2026-06-02T10:00:00Z')
    await event(proseUser, 'agent_created', { run_mode: 'prose' }, '2026-06-02T10:01:00Z')

    // A connector predating #2528 omits the key entirely.
    const oldUser = await newUser()
    await event(oldUser, 'signed_up', null, '2026-06-03T10:00:00Z')
    await event(oldUser, 'agent_created', { agent_id: 'a9' }, '2026-06-03T10:01:00Z')

    const groups = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'run_mode')
    expect(groups.map((g) => g.value)).toEqual(['json', 'prose', UNATTRIBUTED])
    // The old connector must NOT land in `prose`: absent and prose are
    // different facts, and collapsing them silently inflates prose.
    expect(stepUsers(groups.find((g) => g.value === 'prose')!.steps, 'agent_created')).toBe(1)
    expect(stepUsers(groups.find((g) => g.value === UNATTRIBUTED)!.steps, 'agent_created')).toBe(1)
  })

  it('reads `handoff_via`, never the `via` key that means the code path', async () => {
    const user = await newUser()
    // Exactly what routes/agent-connection-setups.ts writes: BOTH keys, with
    // different meanings. Segmenting on the wrong one answers
    // `connection_setup` for every connect-modal agent.
    await event(
      user,
      'agent_created',
      { agent_id: 'a1', via: 'connection_setup', handoff_via: 'agent' },
      '2026-06-01T10:00:00Z',
    )

    const groups = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'via')
    expect(groups.map((g) => g.value)).toEqual(['agent'])
    expect(groups.map((g) => g.value)).not.toContain('connection_setup')
    expect(FUNNEL_SEGMENTS.via).toBe('handoff_via')
  })

  it('a later event with no value does not un-attribute the user', async () => {
    const user = await newUser()
    await event(user, 'signed_up', { handoff_via: 'agent' }, '2026-06-01T10:00:00Z')
    // A later agent created straight from the dashboard, no marker — must not
    // move the user out of `agent`. The CTE's IS NOT NULL filter is what does
    // this, independently of the ordering the next test pins.
    await event(user, 'agent_created', { agent_id: 'a1' }, '2026-06-05T10:00:00Z')

    const groups = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'via')
    expect(groups.map((g) => g.value)).toEqual(['agent'])
  })

  it('resolves FIRST touch when a user carries two different values', async () => {
    const user = await newUser()
    await event(user, 'signed_up', null, '2026-06-01T09:00:00Z')
    // Two agents, two run modes. `handoff_via` cannot do this — it is a
    // sanitised one-value enum — but `run_mode` genuinely can, and this is
    // the only shape that distinguishes first touch from last.
    await event(user, 'agent_created', { run_mode: 'prose', agent_id: 'a1' }, '2026-06-01T10:00:00Z')
    await event(user, 'agent_created', { run_mode: 'json', agent_id: 'a2' }, '2026-06-05T10:00:00Z')

    const groups = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'run_mode')
    // First touch: `prose`. Flipping the CTE's ORDER BY to DESC makes this
    // `json`, which is what the mutation proof shows.
    expect(groups.map((g) => g.value)).toEqual(['prose'])
    expect(stepUsers(groups[0].steps, 'signed_up')).toBe(1)
  })

  it('breaks an exact-timestamp tie STABLY — arbitrary winner, same answer', async () => {
    const sameInstant = '2026-06-01T10:00:00Z'
    const user = await newUser()
    await event(user, 'agent_created', { run_mode: 'prose', agent_id: 'a1' }, sameInstant)
    await event(user, 'agent_created', { run_mode: 'json', agent_id: 'a2' }, sameInstant)

    // The property is STABILITY, not insertion order, and the difference is
    // load-bearing: `onboarding_events.id` is a `gen_random_uuid()` column,
    // so `id ASC` picks a winner that is arbitrary with respect to which row
    // was written first. An earlier draft of this test asserted `prose` (the
    // row inserted first) and the mutation pass caught it returning `json` —
    // the test was wrong, not the query. Asserting insertion order here would
    // pin a guarantee the schema cannot give.
    const first = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'run_mode')
    expect(first).toHaveLength(1)
    expect(['prose', 'json']).toContain(first[0].value)

    for (let i = 0; i < 5; i++) {
      const again = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'run_mode')
      expect(again.map((g) => g.value)).toEqual(first.map((g) => g.value))
    }
  })

  it('honours the window on both edges', async () => {
    const inside = await newUser()
    await event(inside, 'signed_up', { handoff_via: 'agent' }, '2026-06-01T10:00:00Z')
    const outside = await newUser()
    await event(outside, 'signed_up', { handoff_via: 'agent' }, '2025-06-01T10:00:00Z')

    const groups = await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'via')
    expect(stepUsers(groups.find((g) => g.value === 'agent')!.steps, 'signed_up')).toBe(1)
  })

  it('returns no groups for an empty window rather than throwing', async () => {
    expect(await queryFunnelSegments(WINDOW_FROM, WINDOW_TO, 'via')).toEqual([])
  })

  it('accepts exactly the two documented segments', () => {
    expect(isFunnelSegment('via')).toBe(true)
    expect(isFunnelSegment('run_mode')).toBe(true)
    expect(isFunnelSegment('handoff_via')).toBe(false)
    expect(isFunnelSegment('source')).toBe(false)
    expect(isFunnelSegment('')).toBe(false)
    expect(isFunnelSegment(undefined)).toBe(false)
    // Object.hasOwn, not `in` — a prototype key must not pass as a segment.
    expect(isFunnelSegment('toString')).toBe(false)
    expect(isFunnelSegment('constructor')).toBe(false)
  })
})
