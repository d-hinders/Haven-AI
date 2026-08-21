import { describe, it, expect } from 'vitest'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  buildX402ExpectedMessage,
  buildSweepAuthorizationMessage,
  HavenUnsupportedSignerVersionError,
  SignerRefusalCode,
  SIGNER_UPDATE_FALLBACK,
} from '@haven_ai/sdk'
import {
  assertSupportedBindingVersion,
  createEdgeSigner,
  SUPPORTED_SWEEP_BINDING_VERSIONS,
  SUPPORTED_X402_EXPECTED_VERSIONS,
} from './core.js'
import {
  signerCompatibility,
  signerInstructions,
  SIGNER_CAPABILITY_KEY,
  type SignerCompatibility,
} from './capabilities.js'
import { buildSignerMcpServer } from './server.js'
import { createToolHandlers } from './tools.js'

/**
 * #1143 — a signer one release behind the backend must say so.
 *
 * The reported failure was not a signing bug: nothing was ever going to be
 * signed. It was a *diagnosis* bug. The tool schema pinned `auth.version` to a
 * literal, so the MCP server rejected the call before any Haven code ran, and
 * the agent received `Invalid literal value, expected 1 at
 * x402_expected.auth.version` — a string that names neither the cause nor the
 * fix, and which nothing in Haven wrote.
 *
 * These tests hold two properties together, and the second is the one that keeps
 * the first honest:
 *
 *  1. an unknown version produces a named, actionable Haven error;
 *  2. an unknown version is still never signed.
 */

// Well-known test keys (Hardhat accounts). Never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const FUNDING_HASH = '0x' + 'cd'.repeat(32)

/** One past this signer's ceiling — the skew a future context bump will create. */
const UNKNOWN_X402_VERSION = Math.max(...SUPPORTED_X402_EXPECTED_VERSIONS) + 1
const UNKNOWN_SWEEP_VERSION = Math.max(...SUPPORTED_SWEEP_BINDING_VERSIONS) + 1

const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 60,
    },
  ],
}

const EXPECTED_BASE = {
  paymentId: 'pay_x402',
  payloadHash: FUNDING_HASH,
  resourceUrl: PAYMENT_REQUIRED.resource.url,
  merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
  amount: PAYMENT_REQUIRED.accepts[0].amount,
  asset: PAYMENT_REQUIRED.accepts[0].asset,
  network: PAYMENT_REQUIRED.accepts[0].network,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

/**
 * A context whose binding message and signature are entirely VALID — only the
 * announced version is unknown. That isolates the property under test: this is
 * genuine Haven output from a newer backend, not a forgery.
 */
async function expectedWithVersion(
  version: number,
  overrides: Partial<typeof EXPECTED_BASE> & { typedDataHash?: string } = {},
) {
  const context = { ...EXPECTED_BASE, ...overrides }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      version,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

/** Complete an `initialize` handshake against a real signer MCP server. */
async function handshake() {
  const server = buildSignerMcpServer(createEdgeSigner(TEST_KEY))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const advertised = (client.getServerCapabilities()?.experimental as
    | Record<string, SignerCompatibility>
    | undefined)?.[SIGNER_CAPABILITY_KEY]
  const instructions = client.getInstructions()
  await client.close()
  await server.close()
  return { advertised, instructions }
}

describe('assertSupportedBindingVersion (#1143)', () => {
  it('reproduces the reported case: a v2 context against a signer supporting only {1}', () => {
    // The literal incident of 2026-08-06. This signer now knows v2, so the live
    // path can no longer produce it — pinning the supported set is the only way
    // to keep the reported case itself under test.
    let error: Error | undefined
    try {
      assertSupportedBindingVersion(2, [1], 'x402 expected context')
    } catch (err) {
      error = err as Error
    }
    expect(error).toBeDefined()
    const message = error!.message
    // The three things the old Zod string failed to say.
    expect(message).toContain('version 2') // what arrived
    expect(message).toContain('up to 1') // what this signer supports
    expect(message).toContain('@haven_ai/signer') // the fix
    expect(message).not.toMatch(/Invalid literal value/)
  })

  it('tells an agent not to "fix" the version by rewriting it', () => {
    // The reported agent got this right unaided and asked a human instead. The
    // error should not depend on that judgement: the version is inside the
    // Haven-signed message, so editing it invalidates the signature.
    expect(() => assertSupportedBindingVersion(2, [1], 'x402 expected context')).toThrow(
      /invalidates\s+the signature/,
    )
  })

  it('accepts every version in the supported set', () => {
    for (const version of SUPPORTED_X402_EXPECTED_VERSIONS) {
      expect(() =>
        assertSupportedBindingVersion(version, SUPPORTED_X402_EXPECTED_VERSIONS, 'x402 expected context'),
      ).not.toThrow()
    }
  })

  it('names a version below the supported floor without claiming an update fixes it', () => {
    // A retired version is the opposite skew — updating the signer cannot help,
    // so the message must not tell the operator to update.
    let error: Error | undefined
    try {
      assertSupportedBindingVersion(1, [2, 3], 'x402 expected context')
    } catch (err) {
      error = err as Error
    }
    expect(error?.message).toContain('Unsupported x402 expected context version 1')
    expect(error?.message).toContain('2, 3')
    expect(error?.message).not.toMatch(/out of date/)
  })
})

describe('assertSupportedBindingVersion structured fields (#1309)', () => {
  it('throws HavenUnsupportedSignerVersionError with code/supportedVersions/receivedVersion DERIVED from the call site', () => {
    let error: HavenUnsupportedSignerVersionError | undefined
    try {
      assertSupportedBindingVersion(2, [1], 'x402 expected context')
    } catch (err) {
      error = err as HavenUnsupportedSignerVersionError
    }
    expect(error).toBeInstanceOf(HavenUnsupportedSignerVersionError)
    expect(error?.code).toBe(SignerRefusalCode.UnsupportedExpectedContextVersion)
    // Mutation proof: this is [1], not a hard-coded array — it is the SECOND
    // argument passed to assertSupportedBindingVersion, echoed back exactly.
    expect(error?.supportedVersions).toEqual([1])
    expect(error?.receivedVersion).toBe(2)
    // Out-of-date (received > highest supported) → the single-source fallback,
    // byte-identical to what the hosted quote's signer_compatibility.fallback
    // carries (#1155/#1309).
    expect(error?.fallback).toBe(SIGNER_UPDATE_FALLBACK)
  })

  it('uses UNSUPPORTED_SWEEP_BINDING_VERSION for the sweep-binding context', () => {
    let error: HavenUnsupportedSignerVersionError | undefined
    try {
      assertSupportedBindingVersion(2, [1], 'sweep authorization binding')
    } catch (err) {
      error = err as HavenUnsupportedSignerVersionError
    }
    expect(error?.code).toBe(SignerRefusalCode.UnsupportedSweepBindingVersion)
  })

  it('does NOT tell the caller to update when the version is below the floor — updating cannot fix it', () => {
    // The opposite skew: this signer is NEWER than the (retired) version it
    // received. SIGNER_UPDATE_FALLBACK would be actively wrong advice here, so
    // this must be a DIFFERENT string, not the shared constant.
    let error: HavenUnsupportedSignerVersionError | undefined
    try {
      assertSupportedBindingVersion(1, [2, 3], 'x402 expected context')
    } catch (err) {
      error = err as HavenUnsupportedSignerVersionError
    }
    expect(error?.fallback).toBeTruthy()
    expect(error?.fallback).not.toBe(SIGNER_UPDATE_FALLBACK)
    expect(error?.fallback).not.toMatch(/@haven_ai\/connect@alpha/)
    expect(error?.supportedVersions).toEqual([2, 3])
    expect(error?.receivedVersion).toBe(1)
  })
})

describe('x402 funding under an unknown expected-context version (#1143)', () => {
  it('refuses the bare-hash path with the actionable error, and signs nothing', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected)).toThrow(
      new RegExp(`supports x402 expected context versions up to ${Math.max(
        ...SUPPORTED_X402_EXPECTED_VERSIONS,
      )}, and Haven sent version ${UNKNOWN_X402_VERSION}`),
    )
  })

  it('reports the version, not a downstream symptom', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
    // Regression guard on ORDERING: the old code would have reached the
    // recomputed-message comparison and blamed the binding, which is the exact
    // mis-diagnosis the stale docs table recorded.
    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected)).not.toThrow(
      /authentication message is invalid/,
    )
  })

  it('refuses the typed-data path too', async () => {
    const typedData = {
      domain: { chainId: 84532, name: 'HybridDeleGator', version: '1' },
      types: { Payload: [{ name: 'sender', type: 'address' }] },
      primaryType: 'Payload',
      message: { sender: '0x98ffBf30459a98FD80fAce18f519967769641F76' },
    }
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION, {
      typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
    })
    await expect(
      signer.signX402FundingTypedData(typedData as never, expected),
    ).rejects.toThrow(/out of date/)
  })
})

describe('sweep binding under an unknown version (#1143)', () => {
  const AUTHORIZATION = {
    from: '0x000000000000000000000000000000000000bEEF',
    to: '0x000000000000000000000000000000000000cAfe',
    value: '1000000',
    validAfter: '0',
    validBefore: '99999999999',
    nonce: '0x' + '11'.repeat(32),
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    chainId: 8453,
  }

  it('refuses an unknown sweep binding version with the actionable error', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const message = buildSweepAuthorizationMessage(AUTHORIZATION)
    const account = privateKeyToAccount(BINDING_KEY)
    await expect(
      signer.signSweepAuthorization({
        authorization: AUTHORIZATION,
        expectedAuth: {
          version: UNKNOWN_SWEEP_VERSION,
          message,
          signature: await account.signMessage({ message }),
          signer: account.address,
        },
      }),
    ).rejects.toThrow(
      new RegExp(`sweep authorization binding versions up to ${Math.max(
        ...SUPPORTED_SWEEP_BINDING_VERSIONS,
      )}, and Haven sent version ${UNKNOWN_SWEEP_VERSION}`),
    )
  })

  it('does not blame the authorization when only the version is unknown', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const message = buildSweepAuthorizationMessage(AUTHORIZATION)
    const account = privateKeyToAccount(BINDING_KEY)
    const failure = await signer
      .signSweepAuthorization({
        authorization: AUTHORIZATION,
        expectedAuth: {
          version: UNKNOWN_SWEEP_VERSION,
          message,
          signature: await account.signMessage({ message }),
          signer: account.address,
        },
      })
      .catch((err: Error) => err)
    expect((failure as Error).message).not.toMatch(/does not match the authorization/)
  })
})

/**
 * The boundary that actually produced the reported string. The schema is
 * validated by the MCP server before the handler runs, so a literal `version`
 * there meant no Haven error could ever be reached — widening the schema is what
 * makes the tests above observable to an agent.
 */
describe('tool boundary surfaces the skew instead of a Zod string (#1143)', () => {
  it('returns a structured refusal naming the fix, not INVALID_INPUT (#1143, structured #1309)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
    const result = await handlers.haven_sign_x402({
      payload_hash: FUNDING_HASH,
      payment_required: PAYMENT_REQUIRED,
      x402_expected: {
        payment_id: expected.paymentId,
        payload_hash: expected.payloadHash,
        resource_url: expected.resourceUrl,
        merchant_to: expected.merchantTo,
        amount: expected.amount,
        asset: expected.asset,
        network: expected.network,
        expires_at: expected.expiresAt,
        auth: expected.auth,
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    // Not the schema boundary, and not the old generic SIGNING_ERROR either:
    // an unknown version is now a machine-readable Haven diagnosis with its
    // own stable code (#1309).
    expect(result.code).toBe('UNSUPPORTED_EXPECTED_CONTEXT_VERSION')
    expect(result.code).not.toBe('INVALID_INPUT')
    expect(result.code).not.toBe('SIGNING_ERROR')
    expect(result.message).toMatch(/out of date/)
    expect(result.message).toContain('@haven_ai/signer')
  })

  describe('structured refusal fields (#1309)', () => {
    it('x402 refusal carries supported_versions/received_version/fallback DERIVED from the exported constant, plus the existing next_action taxonomy', async () => {
      const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
      const handlers = createToolHandlers(signer)
      const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
      const result = await handlers.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        payment_required: PAYMENT_REQUIRED,
        x402_expected: {
          payment_id: expected.paymentId,
          payload_hash: expected.payloadHash,
          resource_url: expected.resourceUrl,
          merchant_to: expected.merchantTo,
          amount: expected.amount,
          asset: expected.asset,
          network: expected.network,
          expires_at: expected.expiresAt,
          auth: expected.auth,
        },
      })
      expect(result.success).toBe(false)
      if (result.success) return
      // DERIVED, not a second literal: if this ever hard-codes a different
      // array than the exported constant, this is the assertion that catches
      // it (mutation proof for #1309).
      expect(result.supported_versions).toEqual([...SUPPORTED_X402_EXPECTED_VERSIONS])
      expect(result.received_version).toBe(UNKNOWN_X402_VERSION)
      expect(result.fallback).toBeTruthy()
      expect(result.fallback).toContain('@haven_ai/signer')
      expect(result.fallback).toContain('npx @haven_ai/connect@alpha')
      expect(result.fallback).toMatch(/unspent|unaffected/)
      // Existing taxonomy, not a new one: AgentPaymentNextAction.StopAndTellUser.
      expect(result.next_action).toBe('stop_and_tell_user')
    })

    it('sweep refusal uses UNSUPPORTED_SWEEP_BINDING_VERSION with the same structured shape', async () => {
      const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
      const handlers = createToolHandlers(signer)
      const authorization = {
        from: '0x000000000000000000000000000000000000bEEF',
        to: '0x000000000000000000000000000000000000cAfe',
        value: '1000000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: '0x' + '22'.repeat(32),
        token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        chainId: 8453,
      }
      const message = buildSweepAuthorizationMessage(authorization)
      const account = privateKeyToAccount(BINDING_KEY)
      const result = await handlers.haven_sign_sweep_delegate({
        authorization,
        expected_auth: {
          version: UNKNOWN_SWEEP_VERSION,
          message,
          signature: await account.signMessage({ message }),
          signer: account.address,
        },
      })
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.code).toBe('UNSUPPORTED_SWEEP_BINDING_VERSION')
      expect(result.supported_versions).toEqual([...SUPPORTED_SWEEP_BINDING_VERSIONS])
      expect(result.received_version).toBe(UNKNOWN_SWEEP_VERSION)
      expect(result.fallback).toBeTruthy()
      expect(result.next_action).toBe('stop_and_tell_user')
    })

    it('a compatible signer still signs unchanged — the structured refusal adds no new refusal path', async () => {
      // v1 signs over the bare hash; v2 commits to EIP-712 typed data (#1138) —
      // exercise both real shapes this signer actually supports, not just the
      // version number in isolation.
      const typedData = {
        domain: { chainId: 84532, name: 'HybridDeleGator', version: '1' },
        types: { Payload: [{ name: 'sender', type: 'address' }] },
        primaryType: 'Payload',
        message: { sender: '0x98ffBf30459a98FD80fAce18f519967769641F76' },
      }
      const typedDataHash = hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
      const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
      const handlers = createToolHandlers(signer)
      for (const version of SUPPORTED_X402_EXPECTED_VERSIONS) {
        const usesTypedData = version >= 2
        // #1690: a v3 context CARRIES a payer claim, and the claim must be
        // THIS signer's delegate or the guard (correctly) refuses — this loop
        // proves compatibility, not the mismatch path.
        const payerClaim = version >= 3 ? { payerDelegate: signer.delegateAddress } : {}
        const expected = await expectedWithVersion(version, {
          ...(usesTypedData ? { typedDataHash } : {}),
          ...payerClaim,
        })
        const result = await handlers.haven_sign_x402({
          payload_hash: FUNDING_HASH,
          payment_required: PAYMENT_REQUIRED,
          ...(usesTypedData ? { typed_data: typedData } : {}),
          x402_expected: {
            payment_id: expected.paymentId,
            payload_hash: expected.payloadHash,
            resource_url: expected.resourceUrl,
            merchant_to: expected.merchantTo,
            amount: expected.amount,
            asset: expected.asset,
            network: expected.network,
            expires_at: expected.expiresAt,
            typed_data_hash: usesTypedData ? typedDataHash : undefined,
            payer_delegate: version >= 3 ? signer.delegateAddress : undefined,
            auth: expected.auth,
          },
        })
        expect(result.success).toBe(true)
      }
    })
  })

  it('still rejects a structurally invalid version at the schema boundary (#1143)', async () => {
    // Widening the version is not the same as removing validation: a
    // non-numeric or nonsensical version is still an input error.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)
    const expected = await expectedWithVersion(1)
    const result = await handlers.haven_sign_x402({
      payload_hash: FUNDING_HASH,
      payment_required: PAYMENT_REQUIRED,
      x402_expected: {
        payment_id: expected.paymentId,
        payload_hash: expected.payloadHash,
        resource_url: expected.resourceUrl,
        merchant_to: expected.merchantTo,
        amount: expected.amount,
        asset: expected.asset,
        network: expected.network,
        expires_at: expected.expiresAt,
        auth: { ...expected.auth, version: 'two' as unknown as number },
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe('INVALID_INPUT')
  })
})

/**
 * #1155 — the same skew, detectable BEFORE a payment is attempted.
 *
 * #1143 left detection reactive: the agent found out by quoting, signing, and
 * failing. The handshake now states what this signer can verify, so the check
 * costs nothing and happens before any funds can move. It stays advisory —
 * these tests assert information, never a new refusal.
 */
describe('signer advertises its supported versions at handshake (#1155)', () => {
  it('advertises the enforced sets, machine-readably, in the initialize result', async () => {
    const { advertised } = await handshake()

    // Machine-readable, and DERIVED — not a second literal that can drift from
    // what the signing path enforces. If these ever disagree the feature is a
    // lie, which is the main way it could fail.
    expect(advertised).toEqual({
      x402_expected_context_versions: [...SUPPORTED_X402_EXPECTED_VERSIONS],
      sweep_binding_versions: [...SUPPORTED_SWEEP_BINDING_VERSIONS],
    })
  })

  it('survives the tools capability McpServer registers when the first tool is added', async () => {
    // `mergeCapabilities` merges per top-level key, so a regression here would
    // be silent: tools would still work and only the advertisement would vanish.
    const { advertised } = await handshake()
    expect(advertised).toBeDefined()
  })

  it('states the same versions in the instructions clients show the model', async () => {
    const { instructions } = await handshake()
    const compatibility = signerCompatibility()

    // The instructions are free text, so they are where a hand-maintained copy
    // would drift. Pin the rendered list to the enforced set in BOTH directions:
    // every supported version appears, and nothing outside the set does.
    const rendered = /x402 expected-context versions supported: ([0-9, ]+)/.exec(instructions ?? '')
    expect(rendered).not.toBeNull()
    expect(rendered![1].split(',').map((v) => Number(v.trim()))).toEqual(
      compatibility.x402_expected_context_versions,
    )
    expect(instructions).toContain(
      `sweep authorization binding versions supported: ${compatibility.sweep_binding_versions.join(', ')}`,
    )
  })

  it('names the #1143 fix at handshake, so the agent can act without paying first', async () => {
    const { instructions } = await handshake()
    expect(instructions).toContain('@haven_ai/signer')
    expect(instructions).toContain('npx @haven_ai/connect@alpha')
    // Same standing instruction as the signing-time error: the version is inside
    // the Haven-signed message, so rewriting it is never the fix.
    expect(instructions).toMatch(/invalidates the signature/)
  })

  it('advertises nothing the signing path would reject as unknown', async () => {
    // The drift guard with teeth: drive the REAL signing path with each version
    // the handshake advertises and assert the skew guard is never what rejects
    // it. (A v2 context fails later for an unrelated reason — it must commit to
    // typed data — which is why this asserts the absence of the skew error
    // rather than success.) Advertising {1,2,3} while enforcing {1,2} fails here.
    const { advertised } = await handshake()
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const skewError = /out of date|Unsupported x402 expected context version/

    for (const version of advertised!.x402_expected_context_versions) {
      const expected = await expectedWithVersion(version)
      let message = ''
      try {
        signer.signX402FundingHash(FUNDING_HASH, expected)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).not.toMatch(skewError)
    }

    // And the converse: one past the advertised ceiling still IS a skew.
    const beyond = await expectedWithVersion(
      Math.max(...advertised!.x402_expected_context_versions) + 1,
    )
    expect(() => signer.signX402FundingHash(FUNDING_HASH, beyond)).toThrow(skewError)
  })

  it('makes a hosted-emitted version comparable before any signing call', async () => {
    // The skew scenario, agent-side: the hosted quote reports the version it
    // will emit (`signer_compatibility.x402_expected_context_version`), and the
    // agent holds the advertised set from this handshake. Both are available
    // before haven_sign is called and before haven_submit moves anything.
    const { advertised } = await handshake()
    const emittedByANewerBackend = Math.max(...SUPPORTED_X402_EXPECTED_VERSIONS) + 1

    expect(advertised!.x402_expected_context_versions).not.toContain(emittedByANewerBackend)
    for (const version of SUPPORTED_X402_EXPECTED_VERSIONS) {
      expect(advertised!.x402_expected_context_versions).toContain(version)
    }
  })

  it('adds no refusal: a supported context still signs after the advertisement', async () => {
    // The whole feature is warn-not-block. Nothing that succeeded before may
    // fail now — the #1143 signing-time guard remains the only enforcement.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(1)
    const result = signer.signX402FundingHash(FUNDING_HASH, expected)
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]+$/)
  })

  it('does not leak the delegate key through the new handshake surface', async () => {
    const { advertised, instructions } = await handshake()
    const surface = JSON.stringify({ advertised, instructions })
    expect(surface).not.toContain(TEST_KEY)
    expect(surface).not.toContain(TEST_KEY.slice(2))
  })
})

describe('signerInstructions is derived, not hand-maintained (#1155)', () => {
  it('renders from the exported constants', () => {
    // Cheap unit-level backstop for the handshake assertions above: the string
    // builder itself never hard-codes a version.
    const instructions = signerInstructions()
    // Parse the rendered LIST, not the whole text: `toContain('4')` would trip
    // on any stray character ('4337', '404'), which is exactly what happened
    // when the supported set grew to include 3 and the probe became '4'.
    const rendered = /x402 expected-context versions supported: ([0-9, ]+)/.exec(instructions)
    expect(rendered).not.toBeNull()
    const listed = rendered![1].split(',').map((v) => Number(v.trim()))
    expect(listed).toEqual([...SUPPORTED_X402_EXPECTED_VERSIONS])
    expect(listed).not.toContain(Math.max(...SUPPORTED_X402_EXPECTED_VERSIONS) + 1)
  })
})
