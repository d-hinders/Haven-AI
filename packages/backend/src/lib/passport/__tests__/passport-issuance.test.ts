import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: { query: vi.fn() } }))

const { default: pool } = (await import('../../../db.js')) as unknown as {
  default: { query: ReturnType<typeof vi.fn> }
}
const {
  getPassport,
  requestPassport,
  issuePassport,
  issuePassportBestEffort,
  retryPendingPassports,
  setAnchor,
} = await import('../issuance.js')

const AGENT = '11111111-1111-1111-1111-111111111111'
const USER = '22222222-2222-2222-2222-222222222222'
const EOA = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const TREASURY = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UID = '0x' + 'cd'.repeat(32)

/** Dispatch on SQL content, not call order (backend playbook). */
function mockDb(opts: {
  passport?: Record<string, unknown> | null
  agent?: Record<string, unknown> | null
  onUpdate?: (sql: string, params: unknown[]) => void
  retryRows?: Array<{ agent_id: string; user_id: string }>
}) {
  let passport = opts.passport === undefined ? null : opts.passport
  pool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM agent_passports WHERE agent_id/.test(sql)) return { rows: passport ? [passport] : [], rowCount: passport ? 1 : 0 }
    if (/INSERT INTO agent_passports/.test(sql)) {
      if (passport) return { rows: [], rowCount: 0 }
      passport = { agent_id: params[0], chain_id: params[1], status: 'pending', assurance_level: 0, attestation_uid: null, tx_hash: null, attempts: 0, last_error: null }
      return { rows: [], rowCount: 1 }
    }
    if (/FROM agents a/.test(sql) && /LEFT JOIN user_safes/.test(sql)) {
      return { rows: opts.agent === undefined ? [{ delegate_address: EOA, chain_id: 84532, safe_address: TREASURY }] : opts.agent ? [opts.agent] : [] }
    }
    if (/UPDATE agent_passports/.test(sql)) {
      opts.onUpdate?.(sql, params)
      if (passport) {
        if (/status = 'anchored'/.test(sql)) Object.assign(passport, { status: 'anchored', attestation_uid: params[1], tx_hash: params[2] })
        if (/status = 'failed'/.test(sql)) Object.assign(passport, { status: 'failed', last_error: params[1], attempts: (passport.attempts as number) + 1 })
      }
      return { rows: [], rowCount: 1 }
    }
    if (/JOIN agents a ON a\.id = p\.agent_id/.test(sql)) return { rows: opts.retryRows ?? [] }
    return { rows: [], rowCount: 0 }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setAnchor(null)
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
})

describe('opt-in — a basic agent has no passport', () => {
  it('an agent with no row returns null and issuance is a no-op', async () => {
    mockDb({ passport: null })
    expect(await getPassport(AGENT)).toBeNull()
    // Never requested → nothing to issue, and crucially no attestation attempt.
    const anchor = vi.fn()
    setAnchor(anchor)
    expect(await issuePassport(AGENT, USER)).toBeNull()
    expect(anchor).not.toHaveBeenCalled()
  })

  it('requestPassport is idempotent — a second request does not re-request', async () => {
    mockDb({ passport: null })
    expect(await requestPassport(AGENT, 84532)).toBe(true)
    expect(await requestPassport(AGENT, 84532)).toBe(false)
  })
})

describe('the EAS write NEVER blocks agent creation', () => {
  it('a throwing anchor is recorded as failed, not propagated', async () => {
    let recorded = ''
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 },
      onUpdate: (sql, p) => { if (/failed/.test(sql)) recorded = String(p[1]) },
    })
    setAnchor(async () => { throw new Error('bundler exhausted') })
    const row = await issuePassport(AGENT, USER)
    expect(row?.status).toBe('failed')
    expect(recorded).toContain('bundler exhausted')
  })

  it('issuePassportBestEffort never rejects, even when everything fails', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 } })
    setAnchor(async () => { throw new Error('boom') })
    // The guarantee agent creation depends on: this returns void and cannot throw.
    expect(issuePassportBestEffort(AGENT, USER)).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('survives the DB itself throwing mid-issuance', async () => {
    pool.query.mockRejectedValue(new Error('connection reset'))
    expect(issuePassportBestEffort(AGENT, USER)).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    // No unhandled rejection — that is the whole assertion.
  })

  it('degrades to a retryable failure when the schema is unregistered', async () => {
    delete process.env.AGENT_PASSPORT_SCHEMA_UID_84532
    let recorded = ''
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 },
      onUpdate: (sql, p) => { if (/failed/.test(sql)) recorded = String(p[1]) },
    })
    const anchor = vi.fn()
    setAnchor(anchor)
    const row = await issuePassport(AGENT, USER)
    expect(row?.status).toBe('failed')
    expect(recorded).toMatch(/not registered/)
    // Never spends gas against an unregistered schema.
    expect(anchor).not.toHaveBeenCalled()
  })
})

describe('anchoring', () => {
  it('records the UID and tx hash on success', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 } })
    setAnchor(async () => ({ attestationUid: UID, txHash: '0xfeed' }))
    const row = await issuePassport(AGENT, USER)
    expect(row?.status).toBe('anchored')
    expect(row?.attestation_uid).toBe(UID)
    expect(row?.tx_hash).toBe('0xfeed')
  })

  it('an already-anchored passport is a no-op — no second attestation, no re-spent gas', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'anchored', attestation_uid: UID, attempts: 0 } })
    const anchor = vi.fn()
    setAnchor(anchor)
    const row = await issuePassport(AGENT, USER)
    expect(row?.status).toBe('anchored')
    expect(anchor).not.toHaveBeenCalled()
  })

  it('builds a claim binding both addresses and the treasury', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 } })
    const anchor = vi.fn(async () => ({ attestationUid: UID, txHash: '0x1' }))
    setAnchor(anchor)
    await issuePassport(AGENT, USER)
    const [chainId, claim] = anchor.mock.calls[0] as unknown as [number, Record<string, unknown>]
    expect(chainId).toBe(84532)
    expect(claim.agentEoa).toBe(EOA)
    expect(claim.treasury).toBe(TREASURY)
    expect(claim.assuranceLevel).toBe(0) // L0 only
    // EOA-only agent → smart account encodes as the zero-address sentinel.
    expect(claim.smartAccount).toBe('0x0000000000000000000000000000000000000000')
  })

  it('fails cleanly when the agent has no treasury bound', async () => {
    let recorded = ''
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 },
      agent: { delegate_address: EOA, chain_id: 84532, safe_address: null },
      onUpdate: (sql, p) => { if (/failed/.test(sql)) recorded = String(p[1]) },
    })
    setAnchor(async () => ({ attestationUid: UID, txHash: '0x1' }))
    expect((await issuePassport(AGENT, USER))?.status).toBe('failed')
    expect(recorded).toMatch(/treasury/)
  })

  it('refuses an agent belonging to another user', async () => {
    mockDb({ passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 0 }, agent: null })
    const anchor = vi.fn()
    setAnchor(anchor)
    expect((await issuePassport(AGENT, USER))?.status).toBe('failed')
    expect(anchor).not.toHaveBeenCalled()
  })
})

describe('retry sweep', () => {
  it('attempts every non-anchored passport', async () => {
    mockDb({
      passport: { agent_id: AGENT, chain_id: 84532, status: 'pending', attempts: 1 },
      retryRows: [{ agent_id: AGENT, user_id: USER }],
    })
    setAnchor(async () => ({ attestationUid: UID, txHash: '0x2' }))
    expect(await retryPendingPassports()).toEqual({ attempted: 1 })
  })

  it('is a no-op when nothing is pending', async () => {
    mockDb({ passport: null, retryRows: [] })
    expect(await retryPendingPassports()).toEqual({ attempted: 0 })
  })
})
