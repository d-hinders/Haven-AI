import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: { query: vi.fn() } }))

const { default: pool } = (await import('../../../db.js')) as unknown as {
  default: { query: ReturnType<typeof vi.fn> }
}
const {
  passportStanding,
  enqueuePassportRevocation,
  reconcileRevocation,
  reconcilePendingRevocations,
  listStuckRevocations,
  revocationBackoffSeconds,
  setRevoker,
} = await import('../revocation.js')
const { buildRevokeCall } = await import('../attestation.js')
const { getEasDeployment } = await import('../schema.js')

const AGENT = '11111111-1111-1111-1111-111111111111'
const UID = '0x' + 'cd'.repeat(32)

function mockDb(opts: {
  standing?: Record<string, unknown> | null
  passport?: Record<string, unknown> | null
  due?: Array<{ agent_id: string; revocation_attempts: number }>
  stuck?: Array<Record<string, unknown>>
  onRetry?: (params: unknown[]) => void
  /**
   * `agents.status`. Defaults to 'revoked' because that is the precondition for
   * every reconcile test — claimRevocation checks the invariant, not just a lock.
   */
  agentStatus?: string
  /** Set once another caller holds the lease, so the claim must lose. */
  leased?: boolean
}) {
  const passport = opts.passport === undefined ? null : opts.passport
  const agentStatus = opts.agentStatus ?? 'revoked'
  let leased = opts.leased ?? false
  pool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/a\.status AS agent_status/.test(sql)) {
      return { rows: opts.standing === undefined ? [] : opts.standing ? [opts.standing] : [] }
    }
    if (/FROM agent_passports WHERE agent_id/.test(sql)) {
      return { rows: passport ? [passport] : [] }
    }
    // claimRevocation — checked BEFORE the enqueue branch: both set
    // revocation_status = 'pending', and only the claim leases the row.
    if (/UPDATE agent_passports p/.test(sql) && /MAKE_INTERVAL/.test(sql)) {
      const ok =
        !!passport &&
        agentStatus === 'revoked' &&
        passport.status === 'anchored' &&
        passport.revocation_status !== 'confirmed' &&
        !leased
      if (ok) {
        passport.revocation_status = 'pending'
        leased = true
      }
      return { rows: [], rowCount: ok ? 1 : 0 }
    }
    if (/SET revocation_status = 'pending'/.test(sql)) {
      // Mirrors the guarded UPDATE: only anchored + not-yet-enqueued qualifies.
      const ok = !!passport && passport.status === 'anchored' && passport.revocation_status === 'none'
      if (ok) passport.revocation_status = 'pending'
      return { rows: [], rowCount: ok ? 1 : 0 }
    }
    if (/SET revocation_status = 'confirmed'/.test(sql)) {
      if (passport) Object.assign(passport, { revocation_status: 'confirmed', revocation_tx_hash: params[1] })
      return { rows: [], rowCount: 1 }
    }
    if (/revocation_attempts = revocation_attempts \+ 1/.test(sql)) {
      opts.onRetry?.(params)
      if (passport) passport.revocation_attempts = (passport.revocation_attempts as number) + 1
      return { rows: [], rowCount: 1 }
    }
    // The queue and the alarm are both defined by the INVARIANT (agent revoked
    // + anchor not confirmed), not by a `revocation_status = 'pending'` flag.
    if (/JOIN agents a ON a\.id = p\.agent_id/.test(sql)) {
      if (/p\.revocation_last_error/.test(sql)) return { rows: opts.stuck ?? [] }
      return { rows: opts.due ?? [] }
    }
    return { rows: [], rowCount: 0 }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setRevoker(null)
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
})

describe('standing — the DB is authoritative (v6 review point 1)', () => {
  it('ACCEPTANCE: revoked in DB but EAS still pending reads as REVOKED', async () => {
    // The headline test of #973. A merchant checking only the chain during this
    // window would still see a valid attestation — which is exactly why the
    // verifier, not the chain, is the authority.
    mockDb({
      standing: {
        agent_id: AGENT, agent_status: 'revoked', passport_status: 'anchored',
        attestation_uid: UID, revocation_status: 'pending', revocation_confirmed_at: null,
      },
    })
    const s = await passportStanding(AGENT)
    expect(s.standing).toBe('revoked')
    expect(s.anchor).toBe('revocation_pending')
    // Explicitly surfaced so a caller can SEE the divergence rather than infer it.
    expect(s.chainLagging).toBe(true)
  })

  it('an active agent with an anchored passport reads active', async () => {
    mockDb({
      standing: {
        agent_id: AGENT, agent_status: 'active', passport_status: 'anchored',
        attestation_uid: UID, revocation_status: 'none', revocation_confirmed_at: null,
      },
    })
    const s = await passportStanding(AGENT)
    expect(s.standing).toBe('active')
    expect(s.anchor).toBe('anchored')
    expect(s.chainLagging).toBe(false)
  })

  it('an agent revoked BEFORE its passport ever anchored is still revoked', async () => {
    // Standing reads agents.status, never a passport column.
    mockDb({
      standing: {
        agent_id: AGENT, agent_status: 'revoked', passport_status: null,
        attestation_uid: null, revocation_status: null, revocation_confirmed_at: null,
      },
    })
    const s = await passportStanding(AGENT)
    expect(s.standing).toBe('revoked')
    expect(s.anchor).toBe('not_anchored')
    // Nothing on-chain to diverge from, so this is not "lagging".
    expect(s.chainLagging).toBe(false)
  })

  it('a PAUSED agent does not read as active', async () => {
    // Standing was a deny-list (`!== 'revoked' ? 'active'`), so a paused agent
    // — one the owner has explicitly stopped — reported `active` to the
    // verifier. Now only the literal 'active' is active.
    mockDb({
      standing: {
        agent_id: AGENT, agent_status: 'paused', passport_status: 'anchored',
        attestation_uid: UID, revocation_status: 'none', revocation_confirmed_at: null,
      },
    })
    const s = await passportStanding(AGENT)
    expect(s.standing).toBe('suspended')
    // Pausing is reversible and must NOT revoke the anchor — an EAS revoke is
    // one-way, so un-pausing would otherwise require re-issuing the passport.
    expect(s.anchor).toBe('anchored')
    expect(s.chainLagging).toBe(false)
  })

  it('an UNRECOGNISED agent status is never active either', async () => {
    // The allow-list's real job: whatever a later migration adds does not
    // become a permission by default.
    mockDb({
      standing: {
        agent_id: AGENT, agent_status: 'quarantined_by_some_future_migration',
        passport_status: 'anchored', attestation_uid: UID,
        revocation_status: 'none', revocation_confirmed_at: null,
      },
    })
    expect((await passportStanding(AGENT)).standing).toBe('suspended')
  })

  it('an unknown agent is NEVER active', async () => {
    // Failing open here would let a deleted or mistyped id read as usable.
    mockDb({ standing: null })
    expect((await passportStanding(AGENT)).standing).toBe('unknown')
  })

  it('reports revoked_onchain once the anchor agrees', async () => {
    mockDb({
      standing: {
        agent_id: AGENT, agent_status: 'revoked', passport_status: 'anchored',
        attestation_uid: UID, revocation_status: 'confirmed', revocation_confirmed_at: new Date(),
      },
    })
    const s = await passportStanding(AGENT)
    expect(s.anchor).toBe('revoked_onchain')
    expect(s.chainLagging).toBe(false)
  })
})

describe('enqueue', () => {
  it('enqueues only when a passport is actually anchored', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', revocation_status: 'none', revocation_attempts: 0 } })
    expect(await enqueuePassportRevocation(AGENT)).toBe(true)
  })

  it('is a no-op when nothing is anchored — nothing on-chain to revoke', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', revocation_status: 'none', revocation_attempts: 0 } })
    expect(await enqueuePassportRevocation(AGENT)).toBe(false)
  })
})

describe('reconciliation — retries until DB and chain agree', () => {
  it('confirms on success', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'pending', revocation_attempts: 0 } })
    setRevoker(async () => ({ txHash: '0xrev' }))
    expect(await reconcileRevocation(AGENT)).toBe('revoked_onchain')
  })

  it('stays PENDING on failure — there is no terminal failed state', async () => {
    // Owner decision: revocation retries until they agree. A terminal failure
    // would leave a revoked agent valid on-chain forever.
    let recorded: unknown[] = []
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'pending', revocation_attempts: 0 },
      onRetry: (p) => { recorded = p },
    })
    setRevoker(async () => { throw new Error('rpc down') })
    expect(await reconcileRevocation(AGENT)).toBe('revocation_pending')
    expect(String(recorded[1])).toContain('rpc down')
    expect(Number(recorded[2])).toBeGreaterThan(0) // a backoff was scheduled
  })

  it('REDACTS vendor secrets from the retry error', async () => {
    let recorded: unknown[] = []
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'pending', revocation_attempts: 0 },
      onRetry: (p) => { recorded = p },
    })
    setRevoker(async () => { throw new Error('https://rpc.example/v2?apikey=sk_live_SECRET down') })
    await reconcileRevocation(AGENT)
    expect(String(recorded[1])).not.toContain('sk_live_SECRET')
    expect(String(recorded[1])).toContain('apikey=REDACTED')
  })

  it('schedules a retry rather than dropping it when no revoker is configured', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'pending', revocation_attempts: 0 } })
    expect(await reconcileRevocation(AGENT)).toBe('revocation_pending')
  })

  it('is idempotent once confirmed — never re-revokes or re-spends gas', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'confirmed', revocation_attempts: 0 } })
    const revoker = vi.fn()
    setRevoker(revoker)
    expect(await reconcileRevocation(AGENT)).toBe('revoked_onchain')
    expect(revoker).not.toHaveBeenCalled()
  })

  it('SUBMITS NOTHING when another caller holds the claim', async () => {
    // EAS reverts a second revoke with `AlreadyRevoked`. Without the lease the
    // fire-and-forget call and the sweep both read 'pending' and both submit:
    // the loser burns gas, then reverts on every backoff cycle forever instead
    // of converging.
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'pending', revocation_attempts: 0 },
      leased: true,
    })
    const revoker = vi.fn(async () => ({ txHash: '0x1' }))
    setRevoker(revoker)
    expect(await reconcileRevocation(AGENT)).toBe('revocation_pending')
    expect(revoker).not.toHaveBeenCalled()
  })

  it('REFUSES to revoke the anchor of an agent that is not revoked', async () => {
    // The invariant lives in claimRevocation's WHERE, not in the caller — which
    // is what makes the unconditional anchor-completion hook safe. A live
    // agent's attestation must survive any number of stray reconcile calls.
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'none', revocation_attempts: 0 },
      agentStatus: 'active',
    })
    const revoker = vi.fn(async () => ({ txHash: '0x1' }))
    setRevoker(revoker)
    expect(await reconcileRevocation(AGENT)).toBe('anchored')
    expect(revoker).not.toHaveBeenCalled()
  })

  it('adopts an agent revoked MID-ANCHOR, which was never enqueued', async () => {
    // The enqueue guard requires an already-anchored passport, so revoking
    // during the seconds an attestation is in flight enqueued nothing. Because
    // the claim keys off the invariant rather than the flag, the anchor still
    // gets revoked — `revocation_status` is 'none' here, not 'pending'.
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'none', revocation_attempts: 0 },
    })
    setRevoker(async () => ({ txHash: '0xrev' }))
    expect(await reconcileRevocation(AGENT)).toBe('revoked_onchain')
  })

  it('sweeps every due revocation', async () => {
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, revocation_status: 'pending', revocation_attempts: 0 },
      due: [{ agent_id: AGENT, revocation_attempts: 0 }],
    })
    setRevoker(async () => ({ txHash: '0x1' }))
    expect(await reconcilePendingRevocations()).toEqual({ attempted: 1 })
  })
})

describe('the stuck-revoke alarm', () => {
  it('surfaces divergences the sweep has not closed', async () => {
    // A revoke that never lands is an operational INCIDENT, not a retry: a
    // merchant checking only the chain still sees the agent as valid. It has to
    // be visible to a human, not retried silently forever.
    mockDb({
      stuck: [{ agent_id: AGENT, revocation_requested_at: new Date(), revocation_attempts: 12, revocation_last_error: 'rpc down' }],
    })
    const rows = await listStuckRevocations(3600)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(AGENT)
  })

  it('is quiet when nothing has diverged', async () => {
    mockDb({ stuck: [] })
    expect(await listStuckRevocations(3600)).toHaveLength(0)
  })
})

describe('backoff', () => {
  it('grows exponentially and CAPS — an unbounded schedule looks like giving up', () => {
    expect(revocationBackoffSeconds(0)).toBe(30)
    expect(revocationBackoffSeconds(1)).toBe(60)
    expect(revocationBackoffSeconds(3)).toBe(240)
    expect(revocationBackoffSeconds(99)).toBe(3600)
    expect(revocationBackoffSeconds(-5)).toBe(30) // defensive
  })
})

describe('non-custody: the revoke transaction shape', () => {
  it('targets the pinned EAS contract with zero value', () => {
    const call = buildRevokeCall(84532, UID)
    expect(call.to).toBe(getEasDeployment(84532).eas)
    expect(call.value).toBe(0n)
  })

  it('refuses an unpinned chain', () => {
    expect(() => buildRevokeCall(8453, UID)).toThrow(/no pinned EAS deployment/)
  })
})
