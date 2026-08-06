import { describe, expect, it, vi } from 'vitest'

vi.mock('../db.js', () => ({ default: { query: vi.fn() } }))

const {
  deserializeUserOp,
  redactVendorSecrets,
  resolveExecutionRail,
  serializeUserOp,
  sessionRailRetired,
  isRetiredRailIntent,
} = await import('./execution-rail.js')

const PERMISSION_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const CHAIN = 84532 // Base Sepolia — the only session-rail chain today

describe('resolveExecutionRail — retirement decided in the seam (#993)', () => {
  const full = {
    safeExecutionRail: 'session_key',
    sessionPermissionId: PERMISSION_ID,
    chainId: CHAIN,
  }

  // #993 behavior change, DELIBERATE and documented: pre-#993, a session-
  // marked account with a missing/malformed permission or an off-allowlist
  // chain silently fell through to the legacy rail (a post-retirement 403 in
  // a confusing costume). The retired rail's only honest answer is 410 — the
  // marking alone decides.
  it.each([
    ['full session state', full],
    ['no agent session', { ...full, sessionPermissionId: null }],
    ['malformed permissionId', { ...full, sessionPermissionId: '0x1234' }],
    ['Base mainnet', { ...full, chainId: 8453 }],
    ['Gnosis', { ...full, chainId: 100 }],
  ])('a session-marked account is retired regardless of %s', (_label, state) => {
    expect(resolveExecutionRail(state)).toEqual({ rail: 'retired_session' })
  })

  it.each([
    ['default legacy safe', { ...full, safeExecutionRail: 'allowance_module' }],
    ['missing safe row', { ...full, safeExecutionRail: null }],
    ['unknown safe rail value', { ...full, safeExecutionRail: 'something_else' }],
  ])('everything not session-marked routes legacy when %s', (_label, state) => {
    expect(resolveExecutionRail(state)).toEqual({ rail: 'allowance_module' })
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


