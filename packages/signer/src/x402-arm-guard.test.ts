/**
 * #3281 (epic #3284) — the x402 arm signs exactly two shapes, whatever Haven's
 * binding key declares.
 *
 * Threat model (epic #3284, owner-confirmed): Haven's x402 binding key is
 * UNTRUSTED for the signing decision. Every payload below therefore carries a
 * VALID Haven binding — `typedDataHash` committed, a matching `payer_delegate`
 * (a v3 context), signed by the test binding key — so the refusal can only
 * come from the new shape checks, never from the binding, digest or payer
 * checks that already existed.
 */
import { describe, expect, it } from 'vitest'
import { hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  addressFromKey,
  buildX402ExpectedMessage,
  deriveDelegateAccountAddress,
  HavenTypedDataRefusedError,
  HavenUserOpBindingError,
} from '@haven_ai/sdk'
import { DELEGATION_MANAGER, ROOT_AUTHORITY } from '@haven_ai/sdk/edge'
import {
  buildBoundDirectUserOp,
  buildEmptyPermissionContextRedemption,
  buildExecuteCallData,
  buildFundingLegUserOp,
  buildSelfCallCallData,
} from '@haven_ai/sdk/test-support'
import { createEdgeSigner, type X402ExpectedPayment } from './core.js'
import { createToolHandlers, type ToolPayload } from './tools.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = addressFromKey(KEY) as `0x${string}`
const OWN_ACCOUNT = deriveDelegateAccountAddress(DELEGATE)
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address

const QUOTE = {
  paymentId: 'pay_x402_guard',
  resourceUrl: 'https://merchant.test/paid',
  merchantTo: '0x000000000000000000000000000000000000dEaD',
  amount: '1000000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
  network: 'base',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

/** A VALID v3 Haven binding over `typedData`: digest committed, payer = this signer. */
async function bound(typedData: unknown, payloadHash: string) {
  const context = {
    ...QUOTE,
    payloadHash,
    typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
    payerDelegate: DELEGATE.toLowerCase(),
    payerAgentId: 'agent_guard',
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: { version: 3 as const, message, signature: await account.signMessage({ message }), signer: account.address },
  }
}

/** The same context in the snake_case wire shape `haven_sign` accepts as `x402_expected`. */
function wire(expected: Awaited<ReturnType<typeof bound>>) {
  return {
    payment_id: expected.paymentId,
    payload_hash: expected.payloadHash,
    resource_url: expected.resourceUrl,
    merchant_to: expected.merchantTo,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
    expires_at: expected.expiresAt,
    typed_data_hash: expected.typedDataHash,
    payer_delegate: expected.payerDelegate,
    payer_agent_id: expected.payerAgentId,
    auth: expected.auth,
  }
}

function signer() {
  return createEdgeSigner(KEY, { x402BindingSigner: BINDING_SIGNER, agentId: 'agent_guard' })
}

const REAL_FUNDING = () => buildFundingLegUserOp({ delegate: DELEGATE, asset: QUOTE.asset as `0x${string}`, amount: QUOTE.amount, chainId: 8453 })

describe('x402 arm: the funding leg (#3281)', () => {
  it('control: the real funding-leg shape signs, recoverable to the delegate', async () => {
    const funding = REAL_FUNDING()
    const expected = await bound(funding.typedData, funding.payloadHash)
    const result = await signer().signX402FundingTypedData(funding.typedData as never, expected as unknown as X402ExpectedPayment)
    const recovered = await recoverTypedDataAddress({
      ...(funding.typedData as unknown as Parameters<typeof recoverTypedDataAddress>[0]),
      signature: result.signature as `0x${string}`,
    })
    expect(recovered.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })

  it('criterion 2: refuses a B1-shaped funding UserOp (empty permission context + self-call) that Haven validly bound', async () => {
    // Every pre-#3281 check passes: v3 context, digest committed, payer is
    // this signer, and the UserOp hash matches payloadHash. Only the shape is
    // wrong — before #3281 this signed and captured the delegate account.
    const b1 = buildBoundDirectUserOp({
      delegate: DELEGATE,
      chainId: 8453,
      callData: buildExecuteCallData(
        DELEGATION_MANAGER as `0x${string}`,
        0n,
        buildEmptyPermissionContextRedemption(buildSelfCallCallData(OWN_ACCOUNT)),
      ),
    })
    const expected = await bound(b1.typedData, b1.payloadHash)
    const attempt = () =>
      signer().signX402FundingTypedData(b1.typedData as never, expected as unknown as X402ExpectedPayment)
    await expect(attempt()).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt()).rejects.toThrow(/EMPTY delegation chain/)
  })

  it('criterion 2: refuses a validly bound non-UserOp payload (a delegate-EOA TransferWithAuthorization)', async () => {
    const tfa = {
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: QUOTE.asset },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: DELEGATE,
        to: '0x000000000000000000000000000000000000bad1',
        value: '1000000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: `0x${'00'.repeat(32)}`,
      },
    }
    const expected = await bound(tfa, `0x${'cd'.repeat(32)}`)
    const attempt = () => signer().signX402FundingTypedData(tfa as never, expected as unknown as X402ExpectedPayment)
    await expect(attempt()).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt()).rejects.toThrow(/x402 arm signs only/)
  })

  it('criterion 2: refuses a validly bound USDC Permit on the x402 arm', async () => {
    const permit = {
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: QUOTE.asset },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: DELEGATE,
        spender: '0x000000000000000000000000000000000000bad1',
        value: (2n ** 256n - 1n).toString(),
        nonce: '0',
        deadline: '99999999999',
      },
    }
    const expected = await bound(permit, `0x${'cd'.repeat(32)}`)
    const attempt = () => signer().signX402FundingTypedData(permit as never, expected as unknown as X402ExpectedPayment)
    await expect(attempt()).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt()).rejects.toThrow(/x402 arm signs only/)
  })

  it('criterion 5: refuses a funding leg that pays anyone but this signer\'s own delegate EOA', async () => {
    const funding = buildFundingLegUserOp({
      delegate: DELEGATE,
      asset: QUOTE.asset as `0x${string}`,
      amount: QUOTE.amount,
      chainId: 8453,
      recipient: '0x000000000000000000000000000000000000bad1',
    })
    const expected = await bound(funding.typedData, funding.payloadHash)
    await expect(
      signer().signX402FundingTypedData(funding.typedData as never, expected as unknown as X402ExpectedPayment),
    ).rejects.toThrow(/not this agent's own delegate wallet/)
  })

  it('criterion 5: refuses a funding leg moving more than the quoted amount', async () => {
    const funding = buildFundingLegUserOp({ delegate: DELEGATE, asset: QUOTE.asset as `0x${string}`, amount: '5000000', chainId: 8453 })
    const expected = await bound(funding.typedData, funding.payloadHash)
    await expect(
      signer().signX402FundingTypedData(funding.typedData as never, expected as unknown as X402ExpectedPayment),
    ).rejects.toThrow(/not the quoted amount/)
  })

  it('criterion 1: a UserOp whose hash is not the declared payloadHash is refused by the #3271 binding', async () => {
    const funding = REAL_FUNDING()
    const expected = await bound(funding.typedData, `0x${'cd'.repeat(32)}`)
    const attempt = () =>
      signer().signX402FundingTypedData(funding.typedData as never, expected as unknown as X402ExpectedPayment)
    await expect(attempt()).rejects.toBeInstanceOf(HavenUserOpBindingError)
    await expect(attempt()).rejects.toThrow(/does not match its payload_hash/)
  })

  it('tool layer: haven_sign answers the structured TYPED_DATA_NOT_ALLOWED refusal, not a bare SIGNING_ERROR', async () => {
    const tfaLike = {
      domain: { name: 'HavenX402Funding', version: '1', chainId: 8453, verifyingContract: `0x${'11'.repeat(20)}` },
      types: { Funding: [{ name: 'note', type: 'string' }] },
      primaryType: 'Funding',
      message: { note: 'an arbitrary payload Haven validly bound' },
    }
    const expected = await bound(tfaLike, `0x${'cd'.repeat(32)}`)
    const handlers = createToolHandlers(signer())
    const result = (await handlers.haven_sign({
      payload_hash: expected.payloadHash,
      typed_data: tfaLike,
      x402_expected: wire(expected),
    } as never)) as ToolPayload & { code?: string; next_action?: string }
    expect(result.success).toBe(false)
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.next_action).toBe('stop_and_tell_user')
  })
})

describe('x402 arm: the settlement child (#3281 criterion 8)', () => {
  const CHILD_QUOTE = {
    merchantTo: '0x3333333333333333333333333333333333333333',
    amount: '1000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    network: 'eip155:84532',
  }
  function ownChild() {
    const td = JSON.parse(
      JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')),
    )
    td.message.delegator = OWN_ACCOUNT
    return td
  }
  async function boundChild(td: unknown) {
    const context = {
      ...QUOTE,
      ...CHILD_QUOTE,
      payloadHash: `0x${'ab'.repeat(32)}`,
      typedDataHash: hashTypedData(td as Parameters<typeof hashTypedData>[0]),
      payerDelegate: DELEGATE.toLowerCase(),
      payerAgentId: 'agent_guard',
    }
    const message = buildX402ExpectedMessage(context)
    const account = privateKeyToAccount(BINDING_KEY)
    return {
      ...context,
      auth: { version: 3 as const, message, signature: await account.signMessage({ message }), signer: account.address },
    }
  }
  // The fixture's expiry is a fixed timestamp; the verifier reads Date.now().
  const inWindow = <T>(fn: () => Promise<T>) => {
    const real = Date.now
    Date.now = () => (0x6a80709b - 60) * 1000
    return fn().finally(() => {
      Date.now = real
    })
  }

  it('control: the real child, re-delegated from this signer\'s own account, signs', async () => {
    const td = ownChild()
    const expected = await boundChild(td)
    await inWindow(async () => {
      const result = await signer().signX402FundingTypedData(td as never, expected as unknown as X402ExpectedPayment)
      expect(result.signature).toMatch(/^0x[0-9a-f]+$/i)
    })
  })

  it('refuses a ROOT-authority, caveat-free child Haven validly bound (signer-side capture test)', async () => {
    const td = ownChild()
    td.message.authority = ROOT_AUTHORITY
    td.message.caveats = []
    const expected = await boundChild(td)
    await inWindow(async () => {
      await expect(
        signer().signX402FundingTypedData(td as never, expected as unknown as X402ExpectedPayment),
      ).rejects.toThrow(/ROOT delegation/)
    })
  })

  it('tool layer: a ROOT child through haven_sign is TYPED_DATA_NOT_ALLOWED, and nothing is audited', async () => {
    const td = ownChild()
    td.message.authority = ROOT_AUTHORITY
    td.message.caveats = []
    const expected = await boundChild(td)
    const dir = await mkdtemp(join(tmpdir(), 'x402-arm-guard-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      await inWindow(async () => {
        const handlers = createToolHandlers(signer(), {
          audit: { auditPath, delegateAddress: DELEGATE, accountAddress: OWN_ACCOUNT, chainId: 84532 },
        })
        const result = (await handlers.haven_sign({
          payload_hash: expected.payloadHash,
          typed_data: td,
          x402_expected: wire(expected as never),
        } as never)) as ToolPayload & { code?: string; next_action?: string; message?: string }
        expect(result.success).toBe(false)
        expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
        expect(result.next_action).toBe('stop_and_tell_user')
        expect(result.message).toMatch(/ROOT delegation/)
      })
      // Nothing was signed, so nothing was audited (criterion 1).
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a MALFORMED child (truncated caveat terms) is a structured refusal, not an unknown error', async () => {
    const td = ownChild()
    const transfer = td.message.caveats.find(
      (c: { enforcer: string }) => c.enforcer.toLowerCase() === '0xf100b0819427117ecf76ed94b358b1a5b5c6d2fc',
    )
    transfer.terms = transfer.terms.slice(0, 2 + 40) // token only, amount word missing
    const expected = await boundChild(td)
    await inWindow(async () => {
      const handlers = createToolHandlers(signer())
      const result = (await handlers.haven_sign({
        payload_hash: expected.payloadHash,
        typed_data: td,
        x402_expected: wire(expected as never),
      } as never)) as ToolPayload & { code?: string; message?: string }
      expect(result.success).toBe(false)
      expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
      expect(result.message).toMatch(/malformed/)
    })
  })

  it("refuses a child delegated by an account other than this signer's own", async () => {
    const td = ownChild()
    td.message.delegator = '0x1111111111111111111111111111111111111111'
    const expected = await boundChild(td)
    await inWindow(async () => {
      await expect(
        signer().signX402FundingTypedData(td as never, expected as unknown as X402ExpectedPayment),
      ).rejects.toThrow(/delegated by an account other than this agent's own/)
    })
  })
})
