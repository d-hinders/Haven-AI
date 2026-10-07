import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import {
  createSIWxMessage,
  createSIWxPayload,
  encodeSIWxHeader,
  parseSIWxHeader,
  verifySIWxSignature,
} from '@x402/extensions/sign-in-with-x'
import { createEdgeSigner } from './core.js'
import {
  composeSiwxMessage,
  encodeSiwxHeader,
  buildSiwxPayload,
  SIWX_MAX_AGE_SECONDS,
  validateSiwxChallenge,
} from './siwx.js'
import { createToolHandlers, type ToolPayload } from './tools.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = privateKeyToAccount(TEST_KEY).address

const FIXED_NOW = new Date('2026-10-07T12:00:00.000Z')

/**
 * The live Bitrefill challenge, recorded by the unsigned probe of
 * 2026-10-07 (issue #3728): POST https://api.bitrefill.com/x402/connect →
 * HTTP 402 with extensions['sign-in-with-x'] = { info, supportedChains,
 * schema }, info carrying an ABSOLUTE issuedAt/expirationTime 5 minutes
 * apart and supportedChains an ARRAY OF OBJECTS ({ chainId: 'eip155:8453',
 * type: 'eip191' }, plus Arbitrum, Polygon and a Solana ed25519 entry).
 * The nonce/timestamps below are the probe's shape with fresh values —
 * a challenge is single-use and time-bound, so the recorded bytes could
 * never be replayed anyway; what is pinned is the SHAPE.
 */
const BITREFILL_CHALLENGE = {
  info: {
    domain: 'api.bitrefill.com',
    uri: 'https://api.bitrefill.com/x402/connect',
    version: '1',
    nonce: '9f2c1e7a4b8d3f06a5c2e19d7b4f803c',
    issuedAt: '2026-10-07T11:58:00.000Z',
    expirationTime: '2026-10-07T12:03:00.000Z',
    statement: 'Sign in with your Ethereum account to access Bitrefill x402 APIs',
    resources: ['https://api.bitrefill.com/x402/resource'],
  },
  supportedChains: [
    { chainId: 'eip155:8453', type: 'eip191' },
    { chainId: 'eip155:42161', type: 'eip191' },
    { chainId: 'eip155:137', type: 'eip191' },
    { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', type: 'ed25519' },
  ],
  schema: { type: 'object' },
}

const BITREFILL_URL = 'https://api.bitrefill.com/x402/connect'

function challengeExpiringIn(seconds: number, from: Date = FIXED_NOW): string {
  return new Date(from.getTime() + seconds * 1000).toISOString()
}

function validOverrides(overrides: {
  url?: string
  challenge?: unknown
  chainId?: number
  now?: Date
}) {
  return {
    url: BITREFILL_URL,
    challenge: structuredClone(BITREFILL_CHALLENGE),
    chainId: 8453,
    now: FIXED_NOW,
    ...overrides,
  }
}

function expectRefused(input: Parameters<typeof validateSiwxChallenge>[0]): void {
  expect(() => validateSiwxChallenge(input)).toThrow()
}

describe('validateSiwxChallenge', () => {
  it('accepts the recorded Bitrefill 402-extension shape (wrapper with info + supportedChains)', () => {
    const fields = validateSiwxChallenge(validOverrides({}))
    expect(fields.domain).toBe('api.bitrefill.com')
    expect(fields.numericChainId).toBe(8453)
    expect(fields.chainIdCaip2).toBe('eip155:8453')
  })

  it('accepts the flattened reference-client shape ({ ...info, chainId, type, supportedChains })', () => {
    const flat = {
      ...BITREFILL_CHALLENGE.info,
      supportedChains: BITREFILL_CHALLENGE.supportedChains,
    }
    const fields = validateSiwxChallenge(validOverrides({ challenge: flat }))
    expect(fields.nonce).toBe(BITREFILL_CHALLENGE.info.nonce)
  })

  it('refuses a non-https url', () => {
    expectRefused(validOverrides({ url: 'http://api.bitrefill.com/x402/connect' }))
  })

  it('refuses an unparseable url', () => {
    expectRefused(validOverrides({ url: 'not a url' }))
  })

  it('refuses when the challenge domain differs from the url host', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.domain = 'evil.example.com'
    expectRefused(validOverrides({ challenge }))
  })

  it('refuses a domain that only differs in case from the host? — no: host comparison is case-insensitive', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.domain = 'API.BITREFILL.COM'
    expect(validateSiwxChallenge(validOverrides({ challenge })).domain).toBe('API.BITREFILL.COM')
  })

  it('refuses a resource_uri whose origin differs from the url origin', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.uri = 'https://evil.example.com/x402/connect'
    expectRefused(validOverrides({ challenge }))
    const portChallenge = structuredClone(BITREFILL_CHALLENGE)
    portChallenge.info.uri = 'https://api.bitrefill.com:8443/x402/connect'
    expectRefused(validOverrides({ challenge: portChallenge }))
  })

  it('refuses a missing, short, or non-alphanumeric nonce', () => {
    const missing = structuredClone(BITREFILL_CHALLENGE)
    delete (missing.info as Record<string, unknown>).nonce
    expectRefused(validOverrides({ challenge: missing }))
    const short = structuredClone(BITREFILL_CHALLENGE)
    short.info.nonce = 'abc12'
    expectRefused(validOverrides({ challenge: short }))
    const punctuated = structuredClone(BITREFILL_CHALLENGE)
    punctuated.info.nonce = 'abcdef12abcdef12abcdef12abcdef1!'
    expectRefused(validOverrides({ challenge: punctuated }))
  })

  it('refuses a statement containing a line break', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.statement = 'Sign in\nhaven:receipt-drop'
    expectRefused(validOverrides({ challenge }))
  })

  it('refuses a challenge whose version is not 1', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.version = '2'
    expectRefused(validOverrides({ challenge }))
  })

  it('refuses an expiry beyond the pinned bound plus skew tolerance', () => {
    // exactly maxAge + skew: accepted (the upper edge of the tolerance)
    const atBound = validateSiwxChallenge(validOverrides({ challenge: {
      ...BITREFILL_CHALLENGE,
      info: { ...BITREFILL_CHALLENGE.info, expirationTime: challengeExpiringIn(SIWX_MAX_AGE_SECONDS + 30) },
    } }))
    expect(atBound.expirationTime).toBe(challengeExpiringIn(SIWX_MAX_AGE_SECONDS + 30))
    // one second past it: refused
    expectRefused(validOverrides({ challenge: {
      ...BITREFILL_CHALLENGE,
      info: { ...BITREFILL_CHALLENGE.info, expirationTime: challengeExpiringIn(SIWX_MAX_AGE_SECONDS + 31) },
    } }))
    // the plain bound without skew also holds
    expectRefused(validOverrides({ challenge: {
      ...BITREFILL_CHALLENGE,
      info: { ...BITREFILL_CHALLENGE.info, expirationTime: challengeExpiringIn(SIWX_MAX_AGE_SECONDS + 60) },
    } }))
  })

  it('accepts an expiry of exactly the bound and refuses an already-passed one beyond the skew tolerance', () => {
    const exact = validateSiwxChallenge(validOverrides({ challenge: {
      ...BITREFILL_CHALLENGE,
      info: { ...BITREFILL_CHALLENGE.info, expirationTime: challengeExpiringIn(SIWX_MAX_AGE_SECONDS) },
    } }))
    expect(exact.expirationTime).toBe(challengeExpiringIn(SIWX_MAX_AGE_SECONDS))
    // expired but WITHIN the skew tolerance (lower edge): accepted
    const withinSkew = validateSiwxChallenge(validOverrides({ challenge: {
      ...BITREFILL_CHALLENGE,
      info: { ...BITREFILL_CHALLENGE.info, expirationTime: new Date(FIXED_NOW.getTime() - 30_000).toISOString() },
    } }))
    expect(withinSkew.expirationTime).toBe(new Date(FIXED_NOW.getTime() - 30_000).toISOString())
    // expired one second BEYOND the tolerance: refused
    const past = { ...BITREFILL_CHALLENGE, info: { ...BITREFILL_CHALLENGE.info, expirationTime: new Date(FIXED_NOW.getTime() - 31_000).toISOString() } }
    expectRefused(validOverrides({ challenge: past }))
  })

  it('refuses a relative expirationSeconds instead of an absolute expirationTime', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    const info = challenge.info as unknown as Record<string, unknown>
    delete info.expirationTime
    info.expirationSeconds = 300
    expectRefused(validOverrides({ challenge }))
  })

  it('refuses when the credential chain is absent from supportedChains (or offered only with another signature type)', () => {
    expectRefused(validOverrides({ chainId: 1 }))
    const wrongType = structuredClone(BITREFILL_CHALLENGE)
    wrongType.supportedChains = [{ chainId: 'eip155:8453', type: 'eip1271' }]
    expectRefused(validOverrides({ challenge: wrongType }))
  })

  it('refuses when the signer credential carries no chain id at all', () => {
    expectRefused(validOverrides({ chainId: undefined }))
  })

  it('refuses a resources array with a non-URI entry', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.resources = ['not a uri']
    expectRefused(validOverrides({ challenge }))
  })

  it('refuses a challenge that is not an object, and a wrapper whose info is not an object', () => {
    expectRefused(validOverrides({ challenge: 'sign-in-with-x' }))
    expectRefused(validOverrides({ challenge: { info: 'nope', supportedChains: [] } }))
  })
})

describe('composeSiwxMessage — byte-exact vs the reference builder', () => {
  const ADDRESS = TEST_ADDRESS

  /**
   * The verifier rebuilds the EIP-4361 message from the header's decomposed
   * fields, so the signer's composition must equal `@x402/extensions`'
   * `createSIWxMessage` (→ `@signinwithethereum/siwe` `prepareMessage()`)
   * BYTE FOR BYTE — pinned at the devDependency version.
   */
  function referenceMessage(info: Record<string, unknown>): string {
    return createSIWxMessage(
      { ...info, chainId: 'eip155:8453', type: 'eip191' } as never,
      ADDRESS,
    )
  }

  it('matches the reference byte for byte — full challenge (statement, resources, expirationTime)', () => {
    const fields = validateSiwxChallenge(validOverrides({}))
    const mine = composeSiwxMessage(fields, ADDRESS)
    const reference = referenceMessage(BITREFILL_CHALLENGE.info)
    expect(mine).toBe(reference)
  })

  it('matches the reference byte for byte — no statement', () => {
    const info = { ...BITREFILL_CHALLENGE.info }
    delete (info as Record<string, unknown>).statement
    const fields = validateSiwxChallenge(validOverrides({ challenge: { ...BITREFILL_CHALLENGE, info } }))
    expect(composeSiwxMessage(fields, ADDRESS)).toBe(referenceMessage(info))
  })

  it('matches the reference byte for byte — notBefore and requestId relayed when present', () => {
    const info = {
      ...BITREFILL_CHALLENGE.info,
      notBefore: '2026-10-07T11:59:00.000Z',
      requestId: 'req-123',
    }
    const fields = validateSiwxChallenge(validOverrides({ challenge: { ...BITREFILL_CHALLENGE, info } }))
    expect(composeSiwxMessage(fields, ADDRESS)).toBe(referenceMessage(info))
  })

  it('the composed message always begins with the EIP-4361 preamble', () => {
    const fields = validateSiwxChallenge(validOverrides({}))
    expect(composeSiwxMessage(fields, ADDRESS)).toMatch(
      /^api\.bitrefill\.com wants you to sign in with your Ethereum account:\n/,
    )
  })
})

describe('haven_sign_siwx — cross-protocol replay into Haven is impossible', () => {
  /**
   * #3728 invariant 2: a composed SIWX message can equal neither Haven setup
   * proof (`Haven Connect Agent 2…`) nor the receipt-drop format
   * (`haven:receipt-drop…`) — the EIP-4361 preamble plus the grammar checks
   * make every escape hatch a refusal.
   */
  const SETUP_PROOF_PREFIX = 'Haven Connect Agent 2'
  const RECEIPT_DROP_PREFIX = 'haven:receipt-drop'

  it('a statement smuggling the receipt-drop shape via a line break is refused by the grammar check', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.statement = `innocent\n${RECEIPT_DROP_PREFIX}\ntx:0xabc\namount_raw:1000000`
    expect(() =>
      validateSiwxChallenge(validOverrides({ challenge })),
    ).toThrow(/line break/)
  })

  it('a statement attempting the setup-proof shape via a line break is refused', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.statement = `x\n${SETUP_PROOF_PREFIX} ...`
    expect(() => validateSiwxChallenge(validOverrides({ challenge }))).toThrow(/line break/)
  })

  it('a domain pretending to be the receipt-drop marker is not a valid authority and is refused', () => {
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.domain = RECEIPT_DROP_PREFIX
    expect(() => validateSiwxChallenge(validOverrides({ challenge }))).toThrow()
  })

  it('no accepted challenge composes a message equal to — or parseable as — either Haven format', () => {
    const variants = [
      structuredClone(BITREFILL_CHALLENGE),
      // minimal statement-less challenge
      { ...BITREFILL_CHALLENGE, info: { ...BITREFILL_CHALLENGE.info, statement: undefined } },
    ]
    for (const challenge of variants) {
      const fields = validateSiwxChallenge(validOverrides({ challenge }))
      const message = composeSiwxMessage(fields, TEST_ADDRESS)
      expect(message.startsWith(SETUP_PROOF_PREFIX)).toBe(false)
      expect(message.startsWith(RECEIPT_DROP_PREFIX)).toBe(false)
      expect(() => JSON.parse(message)).toThrow() // the Haven drop format is line JSON-ish, never a parse of a preamble-led SIWE message
      expect(message).toMatch(/wants you to sign in with your Ethereum account:/)
    }
  })
})

describe('haven_sign_siwx handler', () => {
  async function handlerWithAudit() {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3728-'))
    const auditPath = join(dir, 'audit.jsonl')
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer, {
      audit: { auditPath, delegateAddress: signer.delegateAddress, chainId: 8453 },
    })
    return { signer, handlers, auditPath, dir }
  }

  function ok<T>(payload: ToolPayload): T {
    if (!payload.success) throw new Error(`expected success, got: ${payload.code} ${payload.message}`)
    return payload.data as T
  }

  function fail(payload: ToolPayload): ToolPayload & { success: false } {
    if (payload.success) throw new Error('expected a refusal')
    return payload as ToolPayload & { success: false }
  }

  it('returns a SIGN-IN-WITH-X header whose decoded message verifies offline to the delegate address (no RPC)', async () => {
    const { signer, handlers } = await handlerWithAudit()
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.issuedAt = new Date(Date.now() - 1000).toISOString()
    challenge.info.expirationTime = new Date(Date.now() + 60_000).toISOString()

    const result = ok<{ sign_in_with_x_header: string }>(
      await handlers.haven_sign_siwx({ url: BITREFILL_URL, challenge }),
    )

    const payload = JSON.parse(Buffer.from(result.sign_in_with_x_header, 'base64').toString('utf8')) as {
      domain: string
      address: string
      uri: string
      version: string
      chainId: string
      type: string
      nonce: string
      issuedAt: string
      expirationTime: string
      statement?: string
      resources?: string[]
      signature: string
    }
    expect(payload.address).toBe(signer.delegateAddress)
    expect(payload.type).toBe('eip191')
    expect(payload.chainId).toBe('eip155:8453')
    expect(payload.domain).toBe('api.bitrefill.com')
    // Offline recovery over the recomposed message — no RPC anywhere.
    const recomposed = composeSiwxMessage(
      validateSiwxChallenge({ url: BITREFILL_URL, challenge, chainId: 8453 }),
      signer.delegateAddress,
    )
    const recovered = await verifyMessage({
      address: signer.delegateAddress as `0x${string}`,
      message: recomposed,
      signature: payload.signature as `0x${string}`,
    })
    expect(recovered).toBe(true)
    // Custody: neither the key nor the raw signature appear outside the header payload.
    expect(JSON.stringify(result)).not.toContain(TEST_KEY.slice(2))
  })

  it('the header verifies through the reference implementation (parseSIWxHeader + verifySIWxSignature), offline', async () => {
    const { signer, handlers } = await handlerWithAudit()
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.issuedAt = new Date(Date.now() - 1000).toISOString()
    challenge.info.expirationTime = new Date(Date.now() + 60_000).toISOString()

    const result = ok<{ sign_in_with_x_header: string }>(
      await handlers.haven_sign_siwx({ url: BITREFILL_URL, challenge }),
    )
    const parsed = parseSIWxHeader(result.sign_in_with_x_header) as Parameters<typeof verifySIWxSignature>[0]
    const verification = await verifySIWxSignature(parsed)
    expect(verification.valid).toBe(true)
    if (verification.valid) {
      expect(verification.address?.toLowerCase()).toBe(signer.delegateAddress.toLowerCase())
    }
  })

  it('an address inside the challenge never changes whose wallet signs in', async () => {
    const { signer, handlers } = await handlerWithAudit()
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.issuedAt = new Date(Date.now() - 1000).toISOString()
    challenge.info.expirationTime = new Date(Date.now() + 60_000).toISOString()
    ;(challenge.info as Record<string, unknown>).address = '0x9999999999999999999999999999999999999999'

    const result = ok<{ sign_in_with_x_header: string }>(
      await handlers.haven_sign_siwx({ url: BITREFILL_URL, challenge }),
    )
    const payload = JSON.parse(Buffer.from(result.sign_in_with_x_header, 'base64').toString('utf8')) as {
      address: string
    }
    expect(payload.address).toBe(signer.delegateAddress)
    expect(JSON.stringify(payload)).not.toContain('9999999999999999999999999999999999999999')
  })

  it('refusals are structured: SIWX_REFUSED, next_action, an omitted-reason step, no signature, no audit entry', async () => {
    const { handlers, auditPath, dir } = await handlerWithAudit()
    const badChallenge = structuredClone(BITREFILL_CHALLENGE)
    badChallenge.info.domain = 'evil.example.com'
    const result = fail(
      await handlers.haven_sign_siwx({ url: BITREFILL_URL, challenge: badChallenge }),
    )
    expect(result.code).toBe('SIWX_REFUSED')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect(result.next_tool_omitted_reason).toMatch(/haven_sign_siwx/)
    expect(JSON.stringify(result)).not.toMatch(/"signature"/)
    await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a version:1 audit entry whose payload_hash is the sha256 of the composed message', async () => {
    const { handlers, auditPath, dir } = await handlerWithAudit()
    const challenge = structuredClone(BITREFILL_CHALLENGE)
    challenge.info.issuedAt = new Date(Date.now() - 1000).toISOString()
    challenge.info.expirationTime = new Date(Date.now() + 60_000).toISOString()
    await handlers.haven_sign_siwx({ url: BITREFILL_URL, challenge })

    const raw = await readFile(auditPath, 'utf8')
    const entry = JSON.parse(raw.trim().split('\n')[0]!) as {
      version: number
      tool: string
      payload_hash: string
      delegate_address: string
      domain?: string
      nonce?: string
    }
    expect(entry.version).toBe(1)
    expect(entry.tool).toBe('haven_sign_siwx')
    expect(entry.delegate_address).toBe(TEST_ADDRESS)
    // #3728: the additive optional fields ride along on SIWX entries.
    expect(entry.domain).toBe('api.bitrefill.com')
    expect(entry.nonce).toBe(BITREFILL_CHALLENGE.info.nonce)
    // The digest the way hashPayloadForAudit computes it: sha256 over the
    // stable-stringified composed message (a JSON-quoted string).
    const { createHash } = await import('node:crypto')
    const fields = validateSiwxChallenge({ url: BITREFILL_URL, challenge, chainId: 8453 })
    const message = composeSiwxMessage(fields, TEST_ADDRESS)
    const expected = `0x${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`
    expect(entry.payload_hash).toBe(expected)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('#3728 golden — the signer matches the @x402/extensions reference client byte for byte', () => {
  const account = privateKeyToAccount(TEST_KEY)

  it('composed message === createSIWxMessage for the live Bitrefill challenge', () => {
    const fields = validateSiwxChallenge(validOverrides({}))
    const mine = composeSiwxMessage(fields, account.address)
    const reference = createSIWxMessage(
      { ...BITREFILL_CHALLENGE.info, chainId: 'eip155:8453', type: 'eip191' } as never,
      account.address,
    )
    expect(mine).toBe(reference)
  })

  it('header === encodeSIWxHeader(createSIWxPayload(...)) for the same challenge and key', async () => {
    const fields = validateSiwxChallenge(validOverrides({}))
    const message = composeSiwxMessage(fields, account.address)
    const signature = await account.signMessage({ message })
    const mine = encodeSiwxHeader(buildSiwxPayload(fields, account.address, signature))

    const referencePayload = await createSIWxPayload(
      { ...BITREFILL_CHALLENGE.info, chainId: 'eip155:8453', type: 'eip191' } as never,
      account,
    )
    const reference = encodeSIWxHeader(referencePayload)
    expect(mine).toBe(reference)
  })
})
