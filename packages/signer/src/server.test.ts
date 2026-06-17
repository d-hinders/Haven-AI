import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { privateKeyToAccount } from 'viem/accounts'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  buildX402ExpectedMessage,
  verifySignature,
} from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'
import { buildSignerMcpServer, resolveEdgeSigner, runSignerConsentGate } from './server.js'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'
import { computeSignerConsentHash, type SignerConsentInput } from './consent.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const HASH = '0x' + 'cd'.repeat(32)
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

async function expectedX402(overrides: Partial<typeof EXPECTED_X402_BASE> = {}) {
  const expected = { ...EXPECTED_X402_BASE, ...overrides }
  const message = buildX402ExpectedMessage({
    paymentId: expected.payment_id,
    payloadHash: expected.payload_hash,
    resourceUrl: expected.resource_url,
    merchantTo: expected.merchant_to,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
    expiresAt: expected.expires_at,
  })
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...expected,
    auth: {
      version: 1 as const,
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
    const signer = await resolveEdgeSigner({ delegateKey: TEST_KEY })
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
      safeAddress: '0x000000000000000000000000000000000000Cafe',
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
      safeAddress: credentials.safeAddress,
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
})

describe('haven_sign tool', () => {
  it('returns a signature that recovers to the delegate, and emits no key', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer)

    const result = ok<{ signature: string }>(await handlers.haven_sign({ payload_hash: HASH }))

    expect(verifySignature(HASH, result.data.signature, signer.delegateAddress)).toBe(true)
    // Custody: the output is only the signature — never the key.
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
    expect(JSON.stringify(result)).not.toContain(TEST_KEY.slice(2))
  })

  it('rejects a malformed payload_hash without throwing', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
    const payload = await handlers.haven_sign({ payload_hash: 'nope' })
    expect(payload.success).toBe(false)
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
          safeAddress: '0x000000000000000000000000000000000000Cafe',
          chainId: 100,
        },
      })

      const result = ok<{ signature: string }>(await handlers.haven_sign({ payload_hash: HASH }))
      const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
      expect(rows).toHaveLength(1)

      const entry = JSON.parse(rows[0])
      expect(entry).toMatchObject({
        version: 1,
        tool: 'haven_sign',
        payload_hash: HASH,
        delegate_address: signer.delegateAddress,
        safe_address: '0x000000000000000000000000000000000000Cafe',
        chain_id: 100,
      })
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

  it('rejects a merchant header when expected context is missing or mismatched', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))
    const missing = await handlers.haven_x402_sign_header({ payment_required: PAYMENT_REQUIRED })
    expect(missing.success).toBe(false)

    const signed = ok<{ x402_binding: string }>(
      await handlers.haven_sign({
        payload_hash: HASH,
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
          x402_expected: await expectedX402(),
          payment_required: PAYMENT_REQUIRED,
        }),
      )

      const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
      // Funding-hash signature + merchant-header signature = two entries.
      expect(rows).toHaveLength(2)
      expect(JSON.parse(rows[0])).toMatchObject({ tool: 'haven_sign_x402', payload_hash: HASH })
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
      x402_expected: await expectedX402({ expires_at: '2000-01-01T00:00:00.000Z' }),
      payment_required: PAYMENT_REQUIRED,
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.retry_with_new_quote).toBe(true)
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
  })
})
