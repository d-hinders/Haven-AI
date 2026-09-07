import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: { query: vi.fn() } }))

const {
  deserializeUserOp,
  redactVendorSecrets,
  resolveExecutionRail,
  serializeUserOp,
  sessionRailRetired,
  isRetiredRailIntent,
  allowanceModuleRailRetired,
  isRetiredAllowanceIntent,
} = await import('../execution-rail.js')

const CHAIN = 84532 // Base Sepolia — the only session-rail chain today

describe('resolveExecutionRail — retirement decided in the seam (#993)', () => {
  // #2263: `sessionPermissionId` is no longer part of `ExecutionRailState` —
  // #993 had already stopped the seam consulting it, and migration 075 dropped
  // the column it came from. The cases below keep their names because the
  // claim is unchanged: the marking alone decides, whatever else is or is not
  // known about the account.
  const full = {
    safeExecutionRail: 'session_key',
    chainId: CHAIN,
  }

  // #993 behavior change, DELIBERATE and documented: pre-#993, a session-
  // marked account with a missing/malformed permission or an off-allowlist
  // chain silently fell through to the legacy rail (a post-retirement 403 in
  // a confusing costume). The retired rail's only honest answer is 410 — the
  // marking alone decides.
  it.each([
    ['full session state', full],
    ['Base mainnet', { ...full, chainId: 8453 }],
    ['Gnosis', { ...full, chainId: 100 }],
  ])('a session-marked account is retired regardless of %s', (_label, state) => {
    expect(resolveExecutionRail(state)).toEqual({ rail: 'retired_session' })
  })

  // #1986 (epic #1440 slice 3): the same three states used to route to a LIVE
  // legacy rail. They are now retired. Note which one the issue's own wording
  // would have missed: `execution_rail='allowance_module'` is the literal
  // string, but `null` (the LEFT-JOIN miss in FIND_EXECUTION_RAIL_FOR_AGENT_SQL)
  // and any unknown value reached the same AllowanceModule executor. Closing
  // the string alone would have left a spend path open.
  it.each([
    ['default legacy safe', { ...full, safeExecutionRail: 'allowance_module' }],
    ['missing safe row', { ...full, safeExecutionRail: null }],
    ['unknown safe rail value', { ...full, safeExecutionRail: 'something_else' }],
  ])('everything not session-marked and not delegation is RETIRED when %s', (_label, state) => {
    expect(resolveExecutionRail(state)).toEqual({ rail: 'retired_allowance' })
  })

  // The positive control at the seam: the one live rail keeps its own answer,
  // and it is named — a guard against a fork has to say which branch it is on.
  it('the delegation rail is NOT retired — it gets its own decision', () => {
    expect(resolveExecutionRail({ ...full, safeExecutionRail: 'delegation' })).toEqual({
      rail: 'delegation',
    })
  })

  // Both tombstones coexist: #1986 must not swallow #834's message.
  it('a session-marked account still answers retired_session, not retired_allowance', () => {
    expect(resolveExecutionRail({ ...full, safeExecutionRail: 'session_key' })).toEqual({
      rail: 'retired_session',
    })
  })
})

describe('allowanceModuleRailRetired — the ONE Safe-rail refusal producer (#1986)', () => {
  it('produces 410 for both kinds, each naming what refused', () => {
    expect(allowanceModuleRailRetired('account').statusCode).toBe(410)
    expect(allowanceModuleRailRetired('account').body.error).toMatch(/Safe rail is retired/)
    expect(allowanceModuleRailRetired('account').body.error).toMatch(/delegation rail/)
    expect(allowanceModuleRailRetired('intent').statusCode).toBe(410)
    expect(allowanceModuleRailRetired('intent').body.error).toMatch(/can no longer execute/)
  })

  it('no longer offers an `approval` kind (#2085)', () => {
    // It had zero production callers, and its message had gone false: it said
    // the queued approval "stays readable, and it can still be rejected" while
    // /approvals is deregistered and migration 070 dropped the table. This
    // test asserted that false promise verbatim (`/rejected/`) — a test
    // holding wrong copy in place, the same shape #2086 found in the MCP
    // consent gate. Pinned as a type-level absence so re-adding the variant
    // has to be deliberate.
    const kinds: Array<Parameters<typeof allowanceModuleRailRetired>[0]> = ['account', 'intent']
    expect(kinds).toHaveLength(2)
    for (const kind of kinds) {
      expect(allowanceModuleRailRetired(kind).body.error).not.toMatch(/queued approval/)
    }
  })

  it('does not collide with the session-rail refusal (#834 stays distinct)', () => {
    expect(allowanceModuleRailRetired('account').body.error).not.toBe(
      sessionRailRetired('account').body.error,
    )
    expect(sessionRailRetired('account').body.error).toMatch(/session rail is retired/)
  })

  it('isRetiredAllowanceIntent catches the null pin, spares delegation and session', () => {
    // The population it must catch is mostly `null`: payment_intents
    // .execution_rail is nullable and legacy inserts leave it unset.
    expect(isRetiredAllowanceIntent(null)).toBe(true)
    expect(isRetiredAllowanceIntent(undefined)).toBe(true)
    expect(isRetiredAllowanceIntent('allowance_module')).toBe(true)
    expect(isRetiredAllowanceIntent('something_else')).toBe(true)
    // Named branches — the delegation pin is what makes the negative safe.
    expect(isRetiredAllowanceIntent('delegation')).toBe(false)
    // #834 keeps its own message.
    expect(isRetiredAllowanceIntent('session_key')).toBe(false)
  })
})

describe('sessionRailRetired — the ONE refusal producer (#993)', () => {
  it('produces 410 with the re-onboarding instruction for both kinds', () => {
    expect(sessionRailRetired('account').statusCode).toBe(410)
    expect(sessionRailRetired('account').body.error).toMatch(/delegation rail/)
    expect(sessionRailRetired('intent').statusCode).toBe(410)
    expect(sessionRailRetired('intent').body.error).toMatch(/can no longer execute/)
  })
  it('isRetiredRailIntent keys on the pinned rail only', () => {
    expect(isRetiredRailIntent('session_key')).toBe(true)
    expect(isRetiredRailIntent('delegation')).toBe(false)
    expect(isRetiredRailIntent(null)).toBe(false)
    expect(isRetiredRailIntent(undefined)).toBe(false)
  })
})

describe('serializeUserOp / deserializeUserOp', () => {
  const userOp = {
    sender: '0x' + 'aa'.repeat(20),
    nonce: 123456789012345678901234567890n,
    callData: '0xdeadbeef',
    maxFeePerGas: 1_000_000n,
    factory: null,
    paymasterData: '0x',
    nested: { verificationGasLimit: 900_000n },
  }

  it('round-trips bigints exactly (string path)', () => {
    expect(deserializeUserOp(serializeUserOp(userOp))).toEqual(userOp)
  })

  it('round-trips through a JSONB read (pg returns a parsed object)', () => {
    // node-postgres parses JSONB columns — simulate: parse WITHOUT the reviver.
    const fromPg = JSON.parse(serializeUserOp(userOp))
    expect(deserializeUserOp(fromPg)).toEqual(userOp)
  })
})

describe('redactVendorSecrets — bundler errors must never leak the API key', () => {
  it('redacts apikey query params wherever they appear (found live, #738)', () => {
    const viemStyle =
      'Invalid parameters.\n\nURL: https://api.pimlico.io/v2/84532/rpc?apikey=pim_SECRETKEY123\n' +
      'Request body: {"method":"pm_getPaymasterData"}\n\nDetails: sponsorshipPolicy not active'
    const redacted = redactVendorSecrets(viemStyle)
    expect(redacted).not.toContain('pim_SECRETKEY123')
    expect(redacted).toContain('apikey=REDACTED')
    expect(redacted).toContain('sponsorshipPolicy not active') // debuggability preserved
    // Also inside JSON-escaped strings and with trailing delimiters:
    expect(redactVendorSecrets('x?apikey=abc&other=1')).toBe('x?apikey=REDACTED&other=1')
    expect(redactVendorSecrets('\\"url\\":\\"rpc?apikey=abc\\"')).toContain('apikey=REDACTED')
  })
})


