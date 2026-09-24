import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, hashTypedData } from 'viem'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  buildX402ExpectedMessage,
  verifySignature,
} from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'
import { buildSignerMcpServer, resolveEdgeSigner, runSignerConsentGate, runSignerStdioServer } from './server.js'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'
import { computeSignerConsentHash, type SignerConsentInput } from './consent.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import {
  buildBoundDirectUserOp,
  buildBoundRedeemDelegationsCallData,
  buildDelegation,
  buildEmptyPermissionContextRedemption,
  buildExecuteCallData,
  buildPermissionContext,
  buildChainPermissionContext,
  buildSelfCallCallData,
  buildSingleExecutionCallData,
  DEFAULT_DELEGATOR,
} from './test-support/direct-userop.js'
import { REDEEM_DELEGATIONS_ABI, SINGLE_DEFAULT_MODE } from './redemption-guard.js'

// Pinned so the #1161 Node floor cannot make these host-dependent: the
// guard lives at the credential/client choke point, which these exercise.
const SUPPORTED_NODE = '22.0.0'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const HASH = '0x' + 'cd'.repeat(32)

/** This test file's own delegate — every "own account" UserOp below derives its sender from this address. */
const TEST_DELEGATE_ADDRESS = privateKeyToAccount(TEST_KEY).address

/**
 * #3271/#3272: a real-shaped, BOUND `PackedUserOperation` for `TEST_KEY`'s own
 * delegate account — every field the binding check
 * (`assertUserOpTypedDataBinding`) inspects is well-formed (domain
 * name/version, sender === verifyingContract, the v0.7 EntryPoint, the full
 * 9-field type list) AND the #3272 allowlist's content checks pass (sender is
 * TEST_KEY's own counterfactual account, callData redeems delegations through
 * the DelegationManager). Replaces the old toy fixture (mismatched sender,
 * empty callData) that #3272 correctly refuses.
 */
function buildDirectUserOp(overrides: { chainId?: number; sender?: `0x${string}` } = {}) {
  return buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS, ...overrides })
}

/** #3169: a direct-payment UserOp — the account validating its OWN operation (#1254), the honest vehicle for a haven_sign signature. */
const { typedData: DIRECT_USEROP, payloadHash: DIRECT_USEROP_HASH } = buildDirectUserOp()
const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 60,
    },
  ],
}
const EXPECTED_X402_BASE = {
  payment_id: 'pay_x402',
  payload_hash: HASH,
  resource_url: PAYMENT_REQUIRED.resource.url,
  merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
  amount: PAYMENT_REQUIRED.accepts[0].amount,
  asset: PAYMENT_REQUIRED.accepts[0].asset,
  network: PAYMENT_REQUIRED.accepts[0].network,
  expires_at: '2099-01-01T00:00:00.000Z',
}

// #3272 (criterion 8): every x402 funding intent is delegation-rail typed
// data now — v1's bare payload_hash signing is retired. This fixture's SHAPE
// does not matter (any well-formed EIP-712 object), only that its digest is
// what `expectedX402`'s `typed_data_hash` commits to; tests pass it as
// `typed_data` alongside `x402_expected`.
const X402_TYPED_DATA = {
  domain: { name: 'HavenX402Funding', version: '1', chainId: 84532, verifyingContract: `0x${'11'.repeat(20)}` },
  types: { Funding: [{ name: 'note', type: 'string' }] },
  primaryType: 'Funding',
  message: { note: 'x402 funding leg (#3272 test fixture)' },
}
const X402_TYPED_DATA_HASH = hashTypedData(X402_TYPED_DATA as Parameters<typeof hashTypedData>[0])

async function expectedX402(overrides: Partial<typeof EXPECTED_X402_BASE> & { typed_data_hash?: string } = {}) {
  const expected = { ...EXPECTED_X402_BASE, typed_data_hash: X402_TYPED_DATA_HASH, ...overrides }
  const message = buildX402ExpectedMessage({
    paymentId: expected.payment_id,
    payloadHash: expected.payload_hash,
    resourceUrl: expected.resource_url,
    merchantTo: expected.merchant_to,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
    expiresAt: expected.expires_at,
    typedDataHash: expected.typed_data_hash,
  })
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...expected,
    auth: {
      version: (expected.typed_data_hash ? 2 : 1) as 1 | 2,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

describe('resolveEdgeSigner', () => {
  it('builds a signer from an explicit delegate key', async () => {
    const signer = await resolveEdgeSigner({ delegateKey: TEST_KEY, nodeVersion: SUPPORTED_NODE })
    expect(signer.delegateAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('runSignerConsentGate', () => {
  it('blocks startup until the current signer surface is acknowledged', async () => {
    const chunks: string[] = []
    const consentOut = {
      write(chunk: string) {
        chunks.push(chunk)
        return true
      },
    }
    const signer = createEdgeSigner(TEST_KEY)
    const credentials = {
      delegateKey: TEST_KEY,
      accountAddress: '0x000000000000000000000000000000000000Cafe',
      chainId: 100,
      network: 'Gnosis Chain',
    }

    const blocked = await runSignerConsentGate(signer, credentials, {
      consentEnv: {},
      consentOut,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe('no_acknowledgement')
    expect(chunks.join('')).toContain('Haven edge signer - first-launch consent')

    const input: SignerConsentInput = {
      delegateAddress: signer.delegateAddress,
      accountAddress: credentials.accountAddress,
      chainId: credentials.chainId,
      network: credentials.network,
      toolNames: ['haven_sign', 'haven_x402_sign_header', 'haven_sign_x402', 'haven_sign_sweep_delegate'],
    }
    const allowed = await runSignerConsentGate(signer, credentials, {
      consentEnv: { HAVEN_SIGNER_ACK: computeSignerConsentHash(input) },
      consentOut,
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.reason).toBe('env_var_match')
  })
})

describe('buildSignerMcpServer', () => {
  it('lists only the sign tools', async () => {
    const server = buildSignerMcpServer(createEdgeSigner(TEST_KEY))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'haven_sign',
      'haven_sign_sweep_delegate',
      'haven_sign_x402',
      'haven_x402_sign_header',
    ])

    await client.close()
    await server.close()
  })

  it('publishes cross-namespace next-tool guidance for x402 flows', async () => {
    const server = buildSignerMcpServer(createEdgeSigner(TEST_KEY))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']))

    expect(byName.get('haven_sign')).toContain('Next: call mcp__haven__haven_submit')
    expect(byName.get('haven_sign')).toContain('expires_at')
    expect(byName.get('haven_x402_sign_header')).toContain(
      'Next for paid MCP tools: call mcp__haven__haven_complete_mcp_tool',
    )
    // #2291: haven_sign_x402 serves TWO paths and now names both successors —
    // settle_mcp_tool for a paid MCP tool, and submit-then-retry-yourself for a
    // direct plain-HTTP merchant. It previously named only the first, which is
    // how the direct path came to be documented as ending at
    // haven_x402_sign_header, a call this one-shot's spent binding cannot serve.
    expect(byName.get('haven_sign_x402')).toContain(
      'call mcp__haven__haven_settle_mcp_tool',
    )
    expect(byName.get('haven_sign_x402')).toContain('mcp__haven__haven_submit')
    expect(byName.get('haven_sign_x402')).toContain('ALREADY SPENT')
    expect(byName.get('haven_sign_x402')).toContain('PAYMENT_WINDOW_EXPIRED')
    // And the header tool says whose binding it takes, since taking the wrong
    // one is the whole defect.
    expect(byName.get('haven_x402_sign_header')).toContain('NOT haven_sign_x402')
    expect(byName.get('haven_sign_sweep_delegate')).toContain('mcp__haven__haven_sweep_delegate')

    await client.close()
    await server.close()
  })
})

describe('#3173: the consent refusal an MCP host relays names the connector doctor', () => {
  it('runSignerStdioServer rejects with a message that names npx @haven_ai/connect --doctor', async () => {
    const out: string[] = []
    await expect(
      runSignerStdioServer({ delegateKey: TEST_KEY, consentEnv: {}, consentOut: { write: (c: string) => out.push(c) } }),
    ).rejects.toThrow(/npx @haven_ai\/connect --doctor/)
    // and the block itself (stderr in real life) carries the same hint
    expect(out.join('')).toContain('npx @haven_ai/connect --doctor')
  })
})

describe('haven_sign tool', () => {
  it('returns a signature that recovers to the delegate, and emits no key', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer)

    // #3169: the vehicle is a direct-payment UserOp (typed data the account
    // validates) — the bare-hash arm this test once rode is gone.
    const result = ok<{ signature: string }>(
      await handlers.haven_sign({ payload_hash: DIRECT_USEROP_HASH, typed_data: DIRECT_USEROP }),
    )

    const digest = hashTypedData(DIRECT_USEROP as Parameters<typeof hashTypedData>[0])
    expect(verifySignature(digest, result.data.signature, signer.delegateAddress)).toBe(true)
    // Custody: the output is only the signature — never the key.
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
    expect(JSON.stringify(result)).not.toContain(TEST_KEY.slice(2))
  })

  // #3169: the bare `payload_hash` arm was a blind-signing oracle for the
  // delegate key — raw secp256k1 over caller bytes with nothing to verify.
  describe('refuses a bare payload_hash (#3169)', () => {
    it('is a structured refusal: named code, next_action, a typed step with the reason no tool can fix it', async () => {
      const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
      const payload = await handlers.haven_sign({ payload_hash: HASH })
      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('unreachable')
      expect(payload.code).toBe('BARE_HASH_REFUSED')
      expect(payload.next_action).toBe('stop_and_tell_user')
      expect(payload).not.toHaveProperty('next_tool')
      expect(payload.next_tool_omitted_reason).toMatch(/payment_id/)
      expect(payload.message).toMatch(/payment_id/)
      expect(payload.message).toMatch(/typed_data/)
      expect(JSON.stringify(payload)).not.toContain(TEST_KEY.slice(2))
    })

    it('the reproduction: an EIP-3009 TransferWithAuthorization digest for the delegate is refused, not signed', async () => {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer)
      const transfer = {
        domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: { from: signer.delegateAddress, to: '0x00000000000000000000000000000000deadbeef', value: 1000000n, validAfter: 0n, validBefore: 4102444800n, nonce: `0x${'01'.repeat(32)}` },
      }
      const digest = hashTypedData(transfer as Parameters<typeof hashTypedData>[0])
      const payload = await handlers.haven_sign({ payload_hash: digest })
      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('unreachable')
      expect(payload.code).toBe('BARE_HASH_REFUSED')
      expect(JSON.stringify(payload)).not.toMatch(/"signature"/)
    })

    it('#1476 parity: a settlement Delegation is refused as typed_data AND as its pre-hashed digest — hashing first buys nothing', async () => {
      const CHILD = JSON.parse(JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')))
      const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
      const asTypedData = await handlers.haven_sign({ payload_hash: HASH, typed_data: CHILD })
      const digest = hashTypedData(CHILD as Parameters<typeof hashTypedData>[0])
      const preHashed = await handlers.haven_sign({ payload_hash: digest })
      expect(asTypedData.success).toBe(false)
      expect(preHashed.success).toBe(false)
      expect(JSON.stringify(asTypedData)).toMatch(/Refusing to sign a delegation payload/)
      if (preHashed.success) throw new Error('unreachable')
      expect(preHashed.code).toBe('BARE_HASH_REFUSED')
      expect(JSON.stringify(asTypedData)).not.toMatch(/"signature"/)
      expect(JSON.stringify(preHashed)).not.toMatch(/"signature"/)
    })

    it('does not audit a refusal as a signing operation', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-bare-hash-audit-'))
      const auditPath = join(dir, 'audit.jsonl')
      try {
        const signer = createEdgeSigner(TEST_KEY)
        const handlers = createToolHandlers(signer, { audit: { auditPath, delegateAddress: signer.delegateAddress, accountAddress: '0x000000000000000000000000000000000000Cafe', chainId: 84532 } })
        await handlers.haven_sign({ payload_hash: HASH })
        await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('rejects a malformed payload_hash without throwing', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
    const payload = await handlers.haven_sign({ payload_hash: 'nope' })
    expect(payload.success).toBe(false)
  })

  it('#3172: payload_hash is a 32-byte hash on the schema — caller-controlled hex of any other length is INVALID_INPUT, and never reaches the audit line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-hash-bound-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
        audit: { auditPath, delegateAddress: '0x000000000000000000000000000000000000dEaD' },
      })
      // 33 bytes and 31 bytes, both with a valid typed_data beside them so the
      // ONLY thing wrong is the hash length.
      for (const bad of [`0x${'ab'.repeat(33)}`, `0x${'ab'.repeat(31)}`, `0x${TEST_KEY.slice(2)}${'00'.repeat(8)}`]) {
        const payload = (await handlers.haven_sign({ payload_hash: bad, typed_data: DIRECT_USEROP })) as {
          success: boolean
          code?: string
          message?: string
        }
        expect(payload.success).toBe(false)
        expect(payload.code).toBe('INVALID_INPUT')
        expect(payload.message).toMatch(/32-byte/)
      }
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('#3172: the bound holds on haven_sign_x402 and inside x402_expected (payload_hash, typed_data_hash) — all four schema sites', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-hash-bound-x402-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
        audit: { auditPath, delegateAddress: '0x000000000000000000000000000000000000dEaD' },
      })
      const expected = {
        payment_id: 'pay_1',
        payload_hash: `0x${'ab'.repeat(32)}`,
        resource_url: 'https://merchant.example/resource',
        merchant_to: '0x000000000000000000000000000000000000Cafe',
        amount: '1000',
        asset: '0x0000000000000000000000000000000000000001',
        network: 'base-sepolia',
        expires_at: '2026-01-02T03:04:05.000Z',
      }
      const cases: Array<Record<string, unknown>> = [
        // haven_sign_x402 top-level payload_hash
        { payload_hash: `0x${'ab'.repeat(33)}`, x402_expected: expected, payment_required: { x402Version: 1, accepts: [] } },
        // x402_expected.payload_hash
        { payload_hash: `0x${'ab'.repeat(32)}`, x402_expected: { ...expected, payload_hash: `0x${'ab'.repeat(31)}` }, payment_required: { x402Version: 1, accepts: [] } },
        // x402_expected.typed_data_hash
        { payload_hash: `0x${'ab'.repeat(32)}`, x402_expected: { ...expected, typed_data_hash: `0x${'cd'.repeat(40)}` }, payment_required: { x402Version: 1, accepts: [] } },
      ]
      for (const input of cases) {
        const payload = (await handlers.haven_sign_x402(input)) as { success: boolean; code?: string; message?: string }
        expect(payload.success).toBe(false)
        expect(payload.code).toBe('INVALID_INPUT')
        expect(payload.message).toMatch(/32-byte/)
      }
      // and the same typed_data_hash bound through haven_sign's x402_expected
      const viaSign = (await handlers.haven_sign({ payload_hash: `0x${'ab'.repeat(32)}`, x402_expected: { ...expected, typed_data_hash: `0x${'cd'.repeat(40)}` } })) as { success: boolean; code?: string }
      expect(viaSign.success).toBe(false)
      expect(viaSign.code).toBe('INVALID_INPUT')
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('#3172: an audit write that fails does not turn a produced signature into a failed call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-unwritable-'))
    try {
      // A path UNDER a regular file cannot be created: mkdir/appendFile throw.
      await writeFile(join(dir, 'blocker'), 'x')
      const auditPath = join(dir, 'blocker', 'audit.jsonl')
      const warnings: string[] = []
      const original = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => {
        warnings.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
          audit: { auditPath, delegateAddress: '0x000000000000000000000000000000000000dEaD' },
        })
        const payload = (await handlers.haven_sign({ payload_hash: DIRECT_USEROP_HASH, typed_data: DIRECT_USEROP })) as ToolSuccess<{ signature: string }>
        expect(payload.success).toBe(true)
        expect(payload.data.signature).toMatch(/^0x[0-9a-f]+$/)
      } finally {
        process.stderr.write = original
      }
      expect(warnings.some((w) => w.includes('audit entry for haven_sign could not be written'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('signs the TYPED DATA, not the raw hash, when typed_data is present (#1254)', async () => {
    // The direct delegation-rail case found live during the #908 mainnet
    // canary: the Hybrid account validates EIP-712 typed data, and a raw
    // signature over payload_hash reverts on-chain with AA24. When the
    // hosted result carries typed_data, THAT is what gets signed.
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-typed-data-audit-'))
    const auditPath = join(dir, 'audit.jsonl')
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer, {
      audit: {
        auditPath,
        delegateAddress: signer.delegateAddress,
        accountAddress: '0x000000000000000000000000000000000000Cafe',
        chainId: 8453,
      },
    })
    const { typedData, payloadHash } = buildDirectUserOp({ chainId: 8453 })

    const result = ok<{ signature: string }>(
      await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData }),
    )

    // The signature verifies against the typed data's EIP-712 digest —
    // and does NOT verify against the raw payload_hash, which is exactly
    // the property that failed on-chain before this fix.
    const digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
    expect(verifySignature(digest, result.data.signature, signer.delegateAddress)).toBe(true)
    expect(verifySignature(payloadHash, result.data.signature, signer.delegateAddress)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(TEST_KEY.slice(2))

    // The audit trail covers this branch too — a typed-data signing that
    // left no local record would be invisible to the user. #3272 (criterion
    // 4): it records the digest ACTUALLY SIGNED (the EIP-712 digest) — never
    // the caller-supplied payload_hash, a DIFFERENT value (the ERC-4337
    // UserOp hash) the #3271 binding check merely cross-checks this typed
    // data against.
    const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
    expect(rows).toHaveLength(1)
    const entry = JSON.parse(rows[0])
    expect(entry).toMatchObject({ tool: 'haven_sign', payload_hash: digest })
    expect(entry.payload_hash).not.toBe(payloadHash)
    expect(JSON.stringify(entry)).not.toContain(TEST_KEY.slice(2))
    expect(JSON.stringify(entry)).not.toContain(result.data.signature)
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts typed_data_b64 as the copy-through-safe form and prefers it over typed_data (#1255)', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer)
    const { typedData, payloadHash } = buildDirectUserOp({ chainId: 8453 })
    const b64 = Buffer.from(JSON.stringify(typedData)).toString('base64')

    // b64 alone works — the live #1255 failure was the nested-JSON copy.
    const alone = ok<{ signature: string }>(
      await handlers.haven_sign({ payload_hash: payloadHash, typed_data_b64: b64 }),
    )
    const digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
    expect(verifySignature(digest, alone.data.signature, signer.delegateAddress)).toBe(true)

    // When both are present, the OPAQUE form wins: a truncated/reshaped
    // typed_data object next to an intact b64 must not poison the signing.
    const mangledTypedData = { ...typedData, message: { ...typedData.message, nonce: '999' } }
    const both = ok<{ signature: string }>(
      await handlers.haven_sign({
        payload_hash: payloadHash,
        typed_data: mangledTypedData,
        typed_data_b64: b64,
      }),
    )
    expect(verifySignature(digest, both.data.signature, signer.delegateAddress)).toBe(true)
  })

  it('refuses a typed_data_b64 that does not decode to a JSON object, with a copy-through hint (#1255)', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
    const payload = await handlers.haven_sign({
      payload_hash: HASH,
      typed_data_b64: Buffer.from('"just a string"').toString('base64'),
    })
    expect(payload.success).toBe(false)
    if (!payload.success) {
      expect(payload.message).toContain('typed_data_b64 did not decode to a JSON object')
      expect(payload.message).toContain('unchanged')
    }
  })

  it('appends a local audit row for signing without key material or signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-tool-audit-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
      const handlers = createToolHandlers(signer, {
        audit: {
          auditPath,
          delegateAddress: signer.delegateAddress,
          accountAddress: '0x000000000000000000000000000000000000Cafe',
          chainId: 100,
        },
      })

      // #3169: typed-data vehicle (the bare-hash arm is gone). #3272
      // (criterion 4): the audit row records the digest ACTUALLY SIGNED — the
      // EIP-712 digest of DIRECT_USEROP — never the caller's payload_hash
      // argument, never the key or signature.
      const result = ok<{ signature: string }>(
        await handlers.haven_sign({ payload_hash: DIRECT_USEROP_HASH, typed_data: DIRECT_USEROP }),
      )
      const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
      expect(rows).toHaveLength(1)

      const entry = JSON.parse(rows[0])
      expect(entry).toMatchObject({
        version: 1,
        tool: 'haven_sign',
        payload_hash: hashTypedData(DIRECT_USEROP as Parameters<typeof hashTypedData>[0]),
        delegate_address: signer.delegateAddress,
        safe_address: '0x000000000000000000000000000000000000Cafe',
        chain_id: 100,
      })
      expect(entry.payload_hash).not.toBe(DIRECT_USEROP_HASH)
      expect(entry.timestamp).toEqual(expect.any(String))

      const serialized = JSON.stringify(entry)
      expect(serialized).not.toContain(TEST_KEY)
      expect(serialized).not.toContain(TEST_KEY.slice(2))
      expect(serialized).not.toContain(result.data.signature)
      expect(serialized).not.toContain('signature')
      expect(serialized).not.toContain('payment_header')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('haven_x402_sign_header tool', () => {
  it('appends a local audit row for x402 header signing without the header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-x402-audit-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
      const handlers = createToolHandlers(signer, {
        audit: { auditPath, delegateAddress: signer.delegateAddress },
      })
      const signed = ok<{ signature: string; x402_binding: string }>(
        await handlers.haven_sign({
          payload_hash: HASH,
          typed_data: X402_TYPED_DATA,
          x402_expected: await expectedX402(),
        }),
      )

      const result = ok<{ payment_header: string }>(
        await handlers.haven_x402_sign_header({
          payment_required: PAYMENT_REQUIRED,
          x402_binding: signed.data.x402_binding,
        }),
      )
      const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
      expect(rows).toHaveLength(2)

      const entry = JSON.parse(rows[1])
      expect(entry).toMatchObject({
        version: 1,
        tool: 'haven_x402_sign_header',
        delegate_address: signer.delegateAddress,
      })
      expect(entry.payload_hash).toMatch(/^0x[0-9a-f]{64}$/)

      const serialized = JSON.stringify(entry)
      expect(serialized).not.toContain(TEST_KEY)
      expect(serialized).not.toContain(TEST_KEY.slice(2))
      expect(serialized).not.toContain(result.data.payment_header)
      expect(serialized).not.toContain('payment_header')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes a SPENT binding from an unknown one, and names the right remedy for each (#2291)', async () => {
    // The defect this pins: haven_sign_x402 is a one-shot that builds the
    // header itself, spending its own binding on the way. Re-using that
    // binding used to produce the same refusal as a typo — "sign first" — and
    // a reporter reasonably concluded haven_x402_sign_header had a lookup bug.
    // It did not; the caller had signed, seconds earlier, with the tool whose
    // own guidance named this one as the successor.
    const handlers = createToolHandlers(
      createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }),
    )

    const oneShot = ok<{ x402_binding: string; payment_header: string }>(
      await handlers.haven_sign_x402({
        payload_hash: HASH,
        typed_data: X402_TYPED_DATA,
        x402_expected: await expectedX402(),
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    // The one-shot did produce a usable header — the binding is spent BECAUSE
    // the work is already done, not because anything failed.
    expect(oneShot.data.payment_header.length).toBeGreaterThan(0)

    const reused = await handlers.haven_x402_sign_header({
      payment_required: PAYMENT_REQUIRED,
      x402_binding: oneShot.data.x402_binding,
    })
    expect(reused.success).toBe(false)
    const reusedText = JSON.stringify(reused)
    expect(reusedText).toContain('already used')
    // Names the actual remedy: the header you already hold.
    expect(reusedText).toContain('payment_header')
    expect(reusedText).not.toContain('Sign the hosted funding hash')

    // An id the signer never held is the OTHER situation, with the other
    // remedy — and must not be described as re-use.
    const unknown = await handlers.haven_x402_sign_header({
      payment_required: PAYMENT_REQUIRED,
      x402_binding: '00000000-0000-4000-8000-000000000000',
    })
    expect(unknown.success).toBe(false)
    const unknownText = JSON.stringify(unknown)
    expect(unknownText).not.toContain('already used')
    expect(unknownText).toContain('restarts')
  })

  it('a binding minted by haven_sign is NOT spent, so the decomposed flow still works (#2291)', async () => {
    // The counterpart the fix must not break: haven_sign only records the
    // context, so haven_sign -> haven_x402_sign_header remains valid. If this
    // ever fails, the spent-binding bookkeeping has over-reached.
    const handlers = createToolHandlers(
      createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }),
    )
    const signed = ok<{ x402_binding: string }>(
      await handlers.haven_sign({
        payload_hash: HASH,
        typed_data: X402_TYPED_DATA,
        x402_expected: await expectedX402(),
      }),
    )
    const header = ok<{ payment_header: string }>(
      await handlers.haven_x402_sign_header({
        payment_required: PAYMENT_REQUIRED,
        x402_binding: signed.data.x402_binding,
      }),
    )
    expect(header.data.payment_header.length).toBeGreaterThan(0)

    // ...and it is single-use afterwards, reported as spent.
    const again = await handlers.haven_x402_sign_header({
      payment_required: PAYMENT_REQUIRED,
      x402_binding: signed.data.x402_binding,
    })
    expect(again.success).toBe(false)
    expect(JSON.stringify(again)).toContain('already used')
  })

  it('rejects a merchant header when expected context is missing or mismatched', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))
    const missing = await handlers.haven_x402_sign_header({ payment_required: PAYMENT_REQUIRED })
    expect(missing.success).toBe(false)

    const signed = ok<{ x402_binding: string }>(
      await handlers.haven_sign({
        payload_hash: HASH,
        typed_data: X402_TYPED_DATA,
        x402_expected: await expectedX402({
          amount: '2000000',
        }),
      }),
    )
    const mismatched = await handlers.haven_x402_sign_header({
      payment_required: PAYMENT_REQUIRED,
      x402_binding: signed.data.x402_binding,
    })
    expect(mismatched.success).toBe(false)
    expect(JSON.stringify(mismatched)).toContain('amount')
  })

  it('returns PAYMENT_WINDOW_EXPIRED when x402_expected.expires_at has passed', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))
    const signed = ok<{ x402_binding: string }>(
      await handlers.haven_sign({
        payload_hash: HASH,
        typed_data: X402_TYPED_DATA,
        x402_expected: await expectedX402({
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      }),
    )

    const payload = await handlers.haven_x402_sign_header({
      payment_required: PAYMENT_REQUIRED,
      x402_binding: signed.data.x402_binding,
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.statusCode).toBe(410)
    expect(payload.paymentId).toBe('pay_x402')
    expect(payload.next_action).toBe(AgentPaymentNextAction.PaymentWindowExpired)
    expect(payload.retry_with_new_quote).toBe(true)
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
    // #3103: the window-expired refusal names no tool (which quote tool depends on the flow) and says why.
    expect(payload.next_tool).toBeUndefined()
    expect(payload.next_tool_omitted_reason).toMatch(/same idempotency_key/)
  })

  it('unwraps the whole x402 object passed as x402_expected, and the binding round-trips', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))

    // Same handoff mistake as the one-shot path, but on the decomposed
    // haven_sign → haven_x402_sign_header flow: pass the whole `x402` wrapper.
    const wrapper = {
      accepted: PAYMENT_REQUIRED.accepts[0],
      resource_url: PAYMENT_REQUIRED.resource.url,
      merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
      funding_to: '0x000000000000000000000000000000000000bEEf',
      expected: await expectedX402(),
    }

    const signed = ok<{ x402_binding: string }>(
      await handlers.haven_sign({ payload_hash: HASH, typed_data: X402_TYPED_DATA, x402_expected: wrapper }),
    )
    const result = ok<{ payment_header: string }>(
      await handlers.haven_x402_sign_header({
        payment_required: PAYMENT_REQUIRED,
        x402_binding: signed.data.x402_binding,
      }),
    )
    expect(result.data.payment_header.length).toBeGreaterThan(0)
  })
})

describe('haven_sign_x402 tool (one-shot funding + header)', () => {
  it('writes two audit rows — one per signing operation — without key or header material', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-signx402-audit-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
      const handlers = createToolHandlers(signer, {
        audit: { auditPath, delegateAddress: signer.delegateAddress },
      })

      const result = ok<{ signature: string; payment_header: string }>(
        await handlers.haven_sign_x402({
          payload_hash: HASH,
          typed_data: X402_TYPED_DATA,
          x402_expected: await expectedX402(),
          payment_required: PAYMENT_REQUIRED,
        }),
      )

      const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
      // Funding-hash signature + merchant-header signature = two entries.
      expect(rows).toHaveLength(2)
      // #3272 (criterion 4): the audit records the digest actually signed —
      // the funding typed data's EIP-712 hash — never the caller's
      // payload_hash argument (a different value).
      expect(JSON.parse(rows[0])).toMatchObject({ tool: 'haven_sign_x402', payload_hash: X402_TYPED_DATA_HASH })
      expect(JSON.parse(rows[1]).tool).toBe('haven_sign_x402')

      const serialized = await readFile(auditPath, 'utf8')
      expect(serialized).not.toContain(TEST_KEY)
      expect(serialized).not.toContain(TEST_KEY.slice(2))
      expect(serialized).not.toContain(result.data.signature)
      expect(serialized).not.toContain(result.data.payment_header)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns PAYMENT_WINDOW_EXPIRED on the one-shot path when expires_at has passed', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))

    const payload = await handlers.haven_sign_x402({
      payload_hash: HASH,
      typed_data: X402_TYPED_DATA,
      x402_expected: await expectedX402({ expires_at: '2000-01-01T00:00:00.000Z' }),
      payment_required: PAYMENT_REQUIRED,
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.retry_with_new_quote).toBe(true)
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
    // #3103: the window-expired refusal names no tool (which quote tool depends on the flow) and says why.
    expect(payload.next_tool).toBeUndefined()
    expect(payload.next_tool_omitted_reason).toMatch(/same idempotency_key/)
  })

  it('unwraps the whole x402 object when passed as x402_expected (common handoff mistake)', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))

    // The agent passes the entire `x402` object from haven_pay_mcp_tool instead
    // of the nested `x402.expected` — the signer should unwrap and sign it.
    const wrapper = {
      accepted: PAYMENT_REQUIRED.accepts[0],
      resource_url: PAYMENT_REQUIRED.resource.url,
      merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
      funding_to: '0x000000000000000000000000000000000000bEEf',
      expected: await expectedX402(),
    }

    const result = ok<{ signature: string; payment_header: string }>(
      await handlers.haven_sign_x402({
        payload_hash: HASH,
        typed_data: X402_TYPED_DATA,
        x402_expected: wrapper,
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    expect(result.data.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(result.data.payment_header).toBeTruthy()
  })

  it('rejects with a clear INVALID_INPUT when x402_expected omits expires_at', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))

    const { expires_at: _omit, ...withoutExpiry } = await expectedX402()
    const payload = await handlers.haven_sign_x402({
      payload_hash: HASH,
      x402_expected: withoutExpiry,
      payment_required: PAYMENT_REQUIRED,
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(payload.message).toContain('expires_at')
  })
})

/**
 * #1476 — `haven_sign`'s raw payload_hash + typed_data fallback must refuse a
 * DELEGATION payload. Whether an erc7710 settlement child got verified used to
 * depend on which tool the caller reached for; the signer's core property
 * cannot rest on a convention.
 */
describe('haven_sign refuses an unbound delegation payload (#1476)', () => {
  const CHILD = JSON.parse(
    JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')),
  )

  it('refuses a settlement child passed with no expected context', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
    const result = await handlers.haven_sign({
      payload_hash: HASH,
      typed_data: CHILD,
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toMatch(/Refusing to sign a delegation payload/)
    // The remedy is named, and it is the path that DOES verify.
    expect(JSON.stringify(result)).toMatch(/payment_id/)
  })

  it('still signs a direct-payment UserOp unbound (#1254 untouched)', async () => {
    // The account validating its OWN operation is not an authority grant, and
    // a raw hash is rejected on-chain there — so this path must keep working.
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
    const result = await handlers.haven_sign({
      payload_hash: HASH,
      typed_data: {
        domain: {
          chainId: 84532,
          name: 'HybridDeleGator',
          version: '1',
          verifyingContract: '0x' + '98'.repeat(20),
        },
        types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
        primaryType: 'PackedUserOperation',
        message: { sender: '0x' + '98'.repeat(20) },
      },
    })
    // Asserting on the REFUSAL rather than on a signature: this test exists to
    // prove the new gate does not catch a UserOp, and whatever else this
    // fixture does downstream is #1254's business, not #1476's.
    expect(JSON.stringify(result)).not.toMatch(/Refusing to sign a delegation payload/)
  })
})

/**
 * #3272 — the unbound branch's allowlist. Every scenario below signed on
 * `origin/dev` before this change (verified by temporarily reverting
 * `tools.ts` — see the PR description's mutation table). Each must now be
 * refused: no signature, no audit entry, structured TYPED_DATA_NOT_ALLOWED
 * (or the pre-existing USEROP_BINDING_MISMATCH / BARE_HASH_REFUSED, when a
 * scenario also fails one of #3271's or #3169's earlier checks).
 */
describe('#3272: haven_sign refuses everything except a bound direct-payment UserOp', () => {
  async function expectNoSignatureNoAudit(
    args: Record<string, unknown>,
  ): Promise<{ code?: string; message?: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3272-allowlist-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, {
        audit: { auditPath, delegateAddress: signer.delegateAddress },
      })
      const result = await handlers.haven_sign(args)
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a refusal')
      expect('signature' in result).toBe(false)
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
      return result
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('refuses the issue-reported probe (an invented domain/primaryType with no shape to verify)', async () => {
    const result = await expectNoSignatureNoAudit({
      payload_hash: `0x${'00'.repeat(31)}01`,
      typed_data: {
        domain: { name: 'HavenSignerKeyProbe', version: '1', chainId: 84532 },
        types: { Probe: [{ name: 'note', type: 'string' }] },
        primaryType: 'Probe',
        message: { note: 'key check, no authority' },
      },
    })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
  })

  it('refuses a delegate USDC TransferWithAuthorization passed as typed_data', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const transfer = {
      domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: { from: signer.delegateAddress, to: '0x00000000000000000000000000000000deadbeef', value: '1000000', validAfter: '0', validBefore: '4102444800', nonce: `0x${'01'.repeat(32)}` },
    }
    const digest = hashTypedData(transfer as Parameters<typeof hashTypedData>[0])
    const result = await expectNoSignatureNoAudit({ payload_hash: digest, typed_data: transfer })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
  })

  it('refuses a USDC Permit passed as typed_data', async () => {
    const permit = {
      domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
      types: {
        Permit: [
          { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: { owner: TEST_DELEGATE_ADDRESS, spender: '0x000000000000000000000000000000000000dEaD', value: '1000000', nonce: '0', deadline: '4102444800' },
    }
    const digest = hashTypedData(permit as Parameters<typeof hashTypedData>[0])
    const result = await expectNoSignatureNoAudit({ payload_hash: digest, typed_data: permit })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
  })

  it('refuses a PackedUserOperation that calls the account itself (self-call, e.g. transferOwnership)', async () => {
    const sender = deriveDelegateAccountAddress(TEST_DELEGATE_ADDRESS)
    const { typedData, payloadHash } = buildBoundDirectUserOp({
      delegate: TEST_DELEGATE_ADDRESS,
      callData: buildSelfCallCallData(sender),
    })
    const result = await expectNoSignatureNoAudit({ payload_hash: payloadHash, typed_data: typedData })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/self-call/)
  })

  it("refuses a PackedUserOperation whose sender/verifyingContract is not THIS signer's delegate account (self-consistent, correct hash)", async () => {
    const otherOwner = '0x1234567890123456789012345678901234567890' as const
    const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: otherOwner })
    // Self-consistent: assertUserOpTypedDataBinding (#3271) passes here — the
    // hash is genuinely correct for this typed data. The #3272 allowlist is
    // what must still refuse it.
    const result = await expectNoSignatureNoAudit({ payload_hash: payloadHash, typed_data: typedData })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/not this signer's own delegate account/)
  })

  it('criterion 2: refuses a self-consistent PackedUserOperation with the correct v0.7 hash for the signer\'s OWN account, but a callData target that is not the DelegationManager', async () => {
    // The exact attack a hash-equality check alone cannot catch (#3271 is
    // necessary, never sufficient): sender is genuinely this signer's own
    // account, the hash genuinely matches — only WHAT it calls is wrong.
    const { typedData, payloadHash } = buildBoundDirectUserOp({
      delegate: TEST_DELEGATE_ADDRESS,
      target: '0x9999999999999999999999999999999999999999',
    })
    const result = await expectNoSignatureNoAudit({ payload_hash: payloadHash, typed_data: typedData })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/DelegationManager/)
  })

  it('criterion (c): refuses a self-consistent, correctly-bound PackedUserOperation scoped to a chain with no pinned delegation contracts', async () => {
    // Self-consistent and otherwise fully bound (own account, own budget
    // redemption) — only the CHAIN is one the delegation rail never runs on
    // (Gnosis, 100; see packages/backend/src/rails/delegation-contracts.ts).
    const { typedData, payloadHash } = buildBoundDirectUserOp({
      delegate: TEST_DELEGATE_ADDRESS,
      chainId: 100,
    })
    const result = await expectNoSignatureNoAudit({ payload_hash: payloadHash, typed_data: typedData })
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/pinned contracts/)
  })

  it('positive control: a real-shaped BOUND UserOp for the signer\'s own account signs, via relay', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer)
    const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS })
    const result = await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect((result.data as { signature: string }).signature).toMatch(/^0x[0-9a-f]+$/i)
  })

  it("positive control: a real-shaped BOUND UserOp for the signer's own account signs, via payment_id fetch", async () => {
    const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS })
    const IDENTITY = { apiKey: 'sk_agent_test_3272', apiUrl: 'https://haven.test' }
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
      signContext: {
        loadIdentity: async () => IDENTITY,
        fetchImpl: (async (url: unknown) => {
          const path = String(url)
          if (path.includes('/x402/')) {
            return new Response(
              JSON.stringify({ error: 'not an x402 payment', error_code: 'sign_context_unavailable' }),
              { status: 409 },
            )
          }
          return new Response(
            JSON.stringify({
              payment_id: 'pay_3272',
              status: 'pending_signature',
              direct_sign_context_version: 1,
              sign_data: { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData },
            }),
            { status: 200 },
          )
        }) as typeof fetch,
      },
    })
    const result = await handlers.haven_sign({ payment_id: 'pay_3272' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect((result.data as { signature: string }).signature).toMatch(/^0x[0-9a-f]+$/i)
  })
})

/**
 * #3272 (B1) — `assertRedeemsOwnBudgetDelegation` decodes the redemption
 * ARGUMENTS, not just the `redeemDelegations` selector. Each test below
 * signed on this branch before that fix (verified by temporarily reverting
 * `tools.ts` — see the PR's mutation table).
 */
describe('#3272 (B1): the redeemDelegations ARGUMENTS are verified, not just the selector', () => {
  const SENDER = deriveDelegateAccountAddress(TEST_DELEGATE_ADDRESS)

  async function expectNoSignatureNoAudit(callData: `0x${string}`): Promise<{ code?: string; message?: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3272-b1-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, {
        audit: { auditPath, delegateAddress: signer.delegateAddress },
      })
      const { typedData, payloadHash } = buildBoundDirectUserOp({
        delegate: TEST_DELEGATE_ADDRESS,
        callData: buildExecuteCallData(
          '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
          0n,
          callData,
        ),
      })
      const result = await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a refusal')
      expect('signature' in result).toBe(false)
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
      return result
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('B1 EXACT REGRESSION: an empty permission context paired with a self-call executes as self-authorised — refused', async () => {
    // The exact live bypass shape: a self-call execution, packed the way
    // ExecutionMode.SingleDefault expects (encodePacked, not ABI-encoded).
    const selfCallSingleExecution = buildSingleExecutionCallData(
      SENDER,
      0n,
      encodeFunctionData({
        abi: [{ type: 'function', name: 'transferOwnership', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [], stateMutability: 'nonpayable' }] as const,
        functionName: 'transferOwnership',
        args: ['0x000000000000000000000000000000000000dEaD'],
      }),
    )
    const redeemCallData = buildEmptyPermissionContextRedemption(selfCallSingleExecution)
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/self-authorised|EMPTY/i)
  })

  it('refuses execute() value !== 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3272-value-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, { audit: { auditPath, delegateAddress: signer.delegateAddress } })
      const { typedData, payloadHash } = buildBoundDirectUserOp({
        delegate: TEST_DELEGATE_ADDRESS,
        callData: buildExecuteCallData(
          '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
          1n,
          buildBoundRedeemDelegationsCallData({ delegate: SENDER }),
        ),
      })
      const result = await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a refusal')
      expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a malformed inner call that is not a well-formed redeemDelegations(bytes[],bytes32[],bytes[])', async () => {
    const result = await expectNoSignatureNoAudit('0xcef6d209deadbeef')
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
  })

  it('refuses an ERC-7579 batch execute(bytes32,bytes) — selector 0xe9ae5c53 — at the OUTER call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3272-erc7579-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, { audit: { auditPath, delegateAddress: signer.delegateAddress } })
      const batchExecuteAbi = [
        { type: 'function', name: 'execute', inputs: [{ name: '_mode', type: 'bytes32' }, { name: '_executionCalldata', type: 'bytes' }], outputs: [], stateMutability: 'payable' },
      ] as const
      const callData = encodeFunctionData({
        abi: batchExecuteAbi,
        functionName: 'execute',
        args: [SINGLE_DEFAULT_MODE, buildBoundRedeemDelegationsCallData({ delegate: SENDER })],
      })
      const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS, callData })
      const result = await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a refusal')
      expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses execute() calldata with trailing bytes appended after a valid encoding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3272-trailing-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, { audit: { auditPath, delegateAddress: signer.delegateAddress } })
      const validCallData = buildExecuteCallData(
        '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
        0n,
        buildBoundRedeemDelegationsCallData({ delegate: SENDER }),
      )
      const withTrailingBytes = (validCallData + 'deadbeef') as `0x${string}`
      const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS, callData: withTrailingBytes })
      const result = await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a refusal')
      expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
      expect(result.message).toMatch(/re-encode/)
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses redeemDelegations calldata with trailing bytes appended after a valid encoding (inner canonical check)', async () => {
    // Distinct from the OUTER execute() trailing-bytes test above: this
    // corrupts the INNER redeemDelegations call specifically, wrapped by an
    // outer execute() that re-encodes canonically around the corrupted
    // bytes — so only `assertRedeemsOwnBudgetDelegation`'s own re-encoding
    // check can catch it.
    const validRedeem = buildBoundRedeemDelegationsCallData({ delegate: SENDER })
    const withTrailingBytes = (validRedeem + 'deadbeef') as `0x${string}`
    const result = await expectNoSignatureNoAudit(withTrailingBytes)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/re-encode/)
  })

  it('refuses a permission context with trailing bytes appended after a valid Delegation[] encoding', async () => {
    const delegation = buildDelegation({ delegate: SENDER, delegator: DEFAULT_DELEGATOR })
    const validContext = buildPermissionContext(delegation)
    const corruptedContext = (validContext + 'deadbeef') as `0x${string}`
    const redeemCallData = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [[corruptedContext], [SINGLE_DEFAULT_MODE], [buildSingleExecutionCallData(SENDER, 0n, '0x')]],
    })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/trailing or non-canonical bytes/)
  })

  it('refuses when the LEAF delegation\'s delegate is not this signer\'s own account (sender IS its own account)', async () => {
    const someoneElse = '0x1234567890123456789012345678901234567890' as const
    const redeemCallData = buildBoundRedeemDelegationsCallData({ delegate: someoneElse })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/not this signer's own account/)
  })

  it('refuses a two-link delegation chain whose leaf is this signer\'s account (Haven emits a single grant)', async () => {
    const leaf = buildDelegation({ delegate: SENDER, delegator: '0x5555555555555555555555555555555555555555' })
    const root = buildDelegation({ delegate: '0x5555555555555555555555555555555555555555', delegator: DEFAULT_DELEGATOR })
    const redeemCallData = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [[buildChainPermissionContext([leaf, root])], [SINGLE_DEFAULT_MODE], [buildSingleExecutionCallData(SENDER, 0n, '0x')]],
    })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/2-link delegation chain/)
  })

  it('refuses when the root delegation\'s delegator IS this signer\'s own account (self-to-self delegation)', async () => {
    const redeemCallData = buildBoundRedeemDelegationsCallData({ delegate: SENDER, delegator: SENDER })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/root delegation granted by this signer/)
  })

  it('refuses mismatched permissionContexts/modes/executionCallDatas array lengths (one context, TWO modes — isolates the length-equality check from the exactly-one check below)', async () => {
    const delegation = buildDelegation({ delegate: SENDER, delegator: DEFAULT_DELEGATOR })
    const permissionContext = buildPermissionContext(delegation)
    const redeemCallData = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [
        [permissionContext],
        [SINGLE_DEFAULT_MODE, SINGLE_DEFAULT_MODE],
        [buildSingleExecutionCallData(SENDER, 0n, '0x')],
      ],
    })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/mismatched or empty argument arrays/)
  })

  it('refuses one context and one mode paired with TWO executions (isolates the executionCallDatas length check)', async () => {
    const delegation = buildDelegation({ delegate: SENDER, delegator: DEFAULT_DELEGATOR })
    const execution = buildSingleExecutionCallData(SENDER, 0n, '0x')
    const redeemCallData = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [[buildPermissionContext(delegation)], [SINGLE_DEFAULT_MODE], [execution, execution]],
    })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/mismatched or empty argument arrays/)
  })

  it('refuses redeeming TWO delegation chains at once — equal-length arrays, but not exactly one', async () => {
    const delegation = buildDelegation({ delegate: SENDER, delegator: DEFAULT_DELEGATOR })
    const permissionContext = buildPermissionContext(delegation)
    const execution = buildSingleExecutionCallData(SENDER, 0n, '0x')
    const redeemCallData = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [
        [permissionContext, permissionContext],
        [SINGLE_DEFAULT_MODE, SINGLE_DEFAULT_MODE],
        [execution, execution],
      ],
    })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/redeems 2 delegation chains at once/)
  })

  it('refuses a non-SingleDefault execution mode', async () => {
    const delegation = buildDelegation({ delegate: SENDER, delegator: DEFAULT_DELEGATOR })
    const permissionContext = buildPermissionContext(delegation)
    const BATCH_DEFAULT_MODE = `0x01${'00'.repeat(31)}` as const
    const redeemCallData = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [[permissionContext], [BATCH_DEFAULT_MODE], [buildSingleExecutionCallData(SENDER, 0n, '0x')]],
    })
    const result = await expectNoSignatureNoAudit(redeemCallData)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/ExecutionMode.SingleDefault/)
  })

  it('N1: refuses a domain.chainId that is a numeric STRING, not a number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3272-string-chainid-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, { audit: { auditPath, delegateAddress: signer.delegateAddress } })
      const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS, chainId: '84532' })
      const result = await handlers.haven_sign({ payload_hash: payloadHash, typed_data: typedData })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a refusal')
      expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
      expect(result.message).toMatch(/not a number/)
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
