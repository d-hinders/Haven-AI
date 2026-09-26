/**
 * #3283 (epic #3284) — HavenClient.signForData runs the direct-payment
 * allowlist, not only the #3271 binding check.
 *
 * The binding proves a UserOp's typed data and hash agree; the Haven API
 * response supplies both. These tests serve `pay()` payloads a compromised
 * API could send — every one self-consistent, so the binding passes — and
 * assert the SDK signs none of them and posts nothing to `/sign`.
 */
import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, erc20Abi, type Hex } from 'viem'
import { HavenClient } from './client.js'
import { addressFromKey } from './edge-signing.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { EXECUTE_ABI, HavenTypedDataRefusedError, TYPED_DATA_NOT_ALLOWED } from './direct-payment-guard.js'
import { DELEGATION_MANAGER } from './settlement-child.js'
import { REDEEM_DELEGATIONS_ABI } from './redemption-guard.js'
import {
  buildBoundDirectUserOp,
  buildEmptyPermissionContextRedemption,
  buildExecuteCallData,
  buildSelfCallCallData,
} from './test-support/direct-userop.js'

const DELEGATE_KEY = `0x${'01'.repeat(32)}`
const DELEGATE = addressFromKey(DELEGATE_KEY) as `0x${string}`
const OWN_ACCOUNT = deriveDelegateAccountAddress(DELEGATE)

/** A client whose createIntent serves `userOp`, recording whether anything was submitted. */
function serving(userOp: { typedData: unknown; payloadHash: string }) {
  const client = new HavenClient({ baseUrl: 'https://example.invalid', apiKey: 'sk_test', delegateKey: DELEGATE_KEY })
  const submitted: string[] = []
  vi.spyOn(client, 'createIntent').mockResolvedValue({
    paymentId: 'pay_1',
    signData: { hash: userOp.payloadHash, signature_scheme: 'eip712_userop', typed_data: userOp.typedData },
  } as never)
  vi.spyOn(client, 'submitSignature').mockImplementation((async (_id: string, sig: string) => {
    submitted.push(sig)
    return {} as never
  }) as never)
  vi.spyOn(client, 'waitForConfirmation').mockResolvedValue({ status: 'executed' } as never)
  return { client, submitted }
}

/** The single execution's ERC-20 `transfer` recipient (encodePacked(target, value, transfer(to, amount))). */
function transferRecipient(typedData: { message: Record<string, unknown> }): string {
  const { args: executeArgs } = decodeFunctionData({ abi: EXECUTE_ABI, data: typedData.message.callData as Hex })
  const { args } = decodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    data: (executeArgs[0] as { callData: Hex }).callData,
  })
  const body = (args[2] as readonly Hex[])[0].slice(2)
  const { args: transferArgs } = decodeFunctionData({ abi: erc20Abi, data: `0x${body.slice(104)}` as Hex })
  return transferArgs[0] as string
}

const REQUEST = { amount: '1', asset: 'USDC', recipient: '0x98ffBf30459a98FD80fAce18f519967769641F76' } as never

describe('HavenClient.signForData direct-payment allowlist (#3283)', () => {
  it('control: signs and submits the bound shape Haven emits', async () => {
    const userOp = buildBoundDirectUserOp({ delegate: DELEGATE })
    // #3375: this direct payment pays a THIRD party, not the delegate. The
    // funding-leg recipient pin must never reach `pay()`: a direct payment's
    // recipient is the caller's intent, bounded by the budget's caveats.
    expect(transferRecipient(userOp.typedData).toLowerCase()).not.toBe(DELEGATE.toLowerCase())
    const { client, submitted } = serving(userOp)
    await client.pay(REQUEST)
    expect(submitted).toHaveLength(1)
  })

  it('B1: refuses an empty-permission-context redemption carrying a self-call, and submits nothing', async () => {
    // Every earlier check passes: the hash matches, the sender is this key's
    // derived account, the target is the DelegationManager, value 0 — only
    // the empty delegation chain (self-authorised in the DelegationManager)
    // is wrong. Before #3283 this signed.
    const b1 = buildBoundDirectUserOp({
      delegate: DELEGATE,
      callData: buildExecuteCallData(
        DELEGATION_MANAGER as `0x${string}`,
        0n,
        buildEmptyPermissionContextRedemption(buildSelfCallCallData(OWN_ACCOUNT)),
      ),
    })
    expect(b1.sender.toLowerCase()).toBe(OWN_ACCOUNT.toLowerCase())
    const { client, submitted } = serving(b1)
    const attempt = client.pay(REQUEST)
    await expect(attempt).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt).rejects.toThrow(/EMPTY delegation chain/)
    await expect(attempt).rejects.toMatchObject({ code: TYPED_DATA_NOT_ALLOWED })
    expect(submitted).toHaveLength(0)
  })

  it('refuses a direct self-call (execute targeting the account itself)', async () => {
    const { client, submitted } = serving(
      buildBoundDirectUserOp({ delegate: DELEGATE, callData: buildSelfCallCallData(OWN_ACCOUNT) }),
    )
    await expect(client.pay(REQUEST)).rejects.toThrow(/not the DelegationManager/)
    expect(submitted).toHaveLength(0)
  })

  it("refuses a UserOp for an account that is not this key's own", async () => {
    const { client, submitted } = serving(
      buildBoundDirectUserOp({ delegate: '0x2222222222222222222222222222222222222222' }),
    )
    await expect(client.pay(REQUEST)).rejects.toThrow(/not this signer's own delegate account/)
    expect(submitted).toHaveLength(0)
  })

  it('refuses a chain the delegation rail has no pinned contracts on', async () => {
    const { client, submitted } = serving(buildBoundDirectUserOp({ delegate: DELEGATE, chainId: 100 }))
    await expect(client.pay(REQUEST)).rejects.toThrow(/pinned/)
    expect(submitted).toHaveLength(0)
  })
})
