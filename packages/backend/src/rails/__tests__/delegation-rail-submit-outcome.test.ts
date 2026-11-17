/**
 * #4817 — a lost send answer and the owner-side receipt wait raise the typed
 * outcome-unknown error.
 *
 * Both submit functions are exercised through the REAL rail: the account
 * derivation, the client's prepare step, the send and the receipt wait all
 * run. Two loopback stand-ins answer instead of the chain and the bundler —
 * the chain RPC is the only mocked seam, because the rail builds its public
 * client from `rpcTransport`.
 *
 * The hash criterion is answered by the stand-in itself: it hashes the
 * operation it RECEIVED, so a hash computed from the prepared object rather
 * than from the dispatched request would not match.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction'
import type { Address, Hex } from 'viem'
import {
  bundlerWith,
  chainAnswer,
  receiptAnswer,
  startStandIn,
  TX_HASH,
  type StandIn,
} from './helpers/bundler-stand-in.js'

const CHAIN_ID = 84532
const DELEGATE_OWNER = `0x${'11'.repeat(20)}` as Address
const USDC = `0x${'33'.repeat(20)}` as Address
const RECIPIENT = `0x${'44'.repeat(20)}` as Address
const SIGNATURE = `0x${'ab'.repeat(97)}` as Hex

const { rpcUrlRef } = vi.hoisted(() => ({ rpcUrlRef: { current: '' } }))

// The chain RPC is the one seam mocked: the rail's public client is built from
// `rpcTransport`, and a real node is not part of this test.
vi.mock('../../infra/chain/rpc-transport.js', async () => {
  const { http } = await import('viem')
  return { rpcTransport: () => http(rpcUrlRef.current) }
})

const { createDelegationRail, createTreasuryOps, SubmittedUserOpFailedError } = await import(
  '../delegation-rail.js'
)

/** The 4337 hash of the operation the stand-in RECEIVED. */
const HEX_USER_OPERATION_FIELDS = [
  'nonce',
  'callGasLimit',
  'verificationGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'paymasterVerificationGasLimit',
  'paymasterPostOpGasLimit',
] as const

function hashOfReceivedOperation(operation: Record<string, unknown>): Hex {
  const userOperation: Record<string, unknown> = { ...operation }
  for (const field of HEX_USER_OPERATION_FIELDS) {
    const value = userOperation[field]
    if (typeof value === 'string') userOperation[field] = BigInt(value)
  }
  return getUserOperationHash({
    chainId: CHAIN_ID,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: '0.7',
    userOperation: userOperation as never,
  })
}

function sentOperation(standIn: StandIn): Record<string, unknown> {
  const send = standIn.requests.find((request) => request.method === 'eth_sendUserOperation')
  expect(send, 'the stand-in never received eth_sendUserOperation').toBeDefined()
  return (send!.params as unknown[])[0] as Record<string, unknown>
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let chain: StandIn

beforeAll(async () => {
  chain = await startStandIn(chainAnswer)
  rpcUrlRef.current = chain.url
})

afterAll(async () => {
  await chain.close()
})

async function delegationRail(bundlerUrl: string) {
  return createDelegationRail({
    delegateOwnerAddress: DELEGATE_OWNER,
    chainId: CHAIN_ID,
    bundlerUrl,
  })
}

async function treasuryOps(bundlerUrl: string) {
  return createTreasuryOps({
    ownerAddress: DELEGATE_OWNER,
    chainId: CHAIN_ID,
    bundlerUrl,
    deploySalt: '0x',
  })
}

async function preparedRedemption(bundlerUrl: string) {
  const rail = await delegationRail(bundlerUrl)
  const prepared = await rail.prepareRedemption([], USDC, RECIPIENT, 1n)
  return { rail, prepared }
}

async function preparedCall(bundlerUrl: string) {
  const treasury = await treasuryOps(bundlerUrl)
  const prepared = await treasury.prepareCall(USDC, '0xdeadbeef')
  return { treasury, prepared }
}

// ── submitRedemption ────────────────────────────────────────────────────────

describe('submitRedemption — a lost send answer (#4817)', () => {
  it('a bundler that accepts eth_sendUserOperation and never answers rejects with the typed outcome-unknown error, hashed from the operation it received', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ hang: true }) }))
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      const typed = error as InstanceType<typeof SubmittedUserOpFailedError>
      expect(typed.outcome).toBe('receipt_unconfirmed')
      expect(typed.reverted).toBe(false)
      expect(typed.userOpHash).toBe(hashOfReceivedOperation(sentOperation(bundler)))
    } finally {
      await bundler.close()
    }
  }, 30_000)

  it('a JSON-RPC error answered by the bundler (an AA25 nonce rejection) stays an ordinary pre-send error', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({
          error: { code: -32500, message: 'AA25 invalid account nonce' },
        }),
      }),
    )
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
      expect((error as Error).message).toMatch(/AA25/)
    } finally {
      await bundler.close()
    }
  })

  it.each([429, 401])(
    'an HTTP %i from the bundler with no JSON-RPC body stays an ordinary pre-send error',
    async (status) => {
      const bundler = await startStandIn(
        bundlerWith({
          eth_sendUserOperation: () => ({ httpStatus: status, body: 'rate limited' }),
        }),
      )
      try {
        const { rail, prepared } = await preparedRedemption(bundler.url)
        const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

        expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
      } finally {
        await bundler.close()
      }
    },
  )

  it('a failure in the client prepare step, before the send request, stays an ordinary pre-send error even when it is an HTTP 5xx', async () => {
    // The prepare that builds the object succeeds; every chain read after it
    // fails, so the client's OWN prepare step inside `sendUserOperation` (a
    // fresh deploy check and nonce read) throws a 5xx before the send leaves.
    let failChain = false
    const flakyChain = await startStandIn((request) =>
      failChain ? { httpStatus: 503, body: 'node unavailable' } : chainAnswer(request),
    )
    const previousRpcUrl = rpcUrlRef.current
    rpcUrlRef.current = flakyChain.url
    const bundler = await startStandIn(bundlerWith({}))
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      // A prepared object missing a field forces the client's prepare step to
      // read the chain — and that read is what fails here, before the send.
      delete (prepared.userOperation as Record<string, unknown>).nonce
      failChain = true
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
      // The send never left: the stand-in saw no eth_sendUserOperation.
      expect(bundler.requests.some((request) => request.method === 'eth_sendUserOperation')).toBe(false)
    } finally {
      rpcUrlRef.current = previousRpcUrl
      await bundler.close()
      await flakyChain.close()
    }
  })

  it('an HTTP 5xx on the send itself is the typed outcome-unknown error', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ httpStatus: 502, body: 'bad gateway' }),
      }),
    )
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      const typed = error as InstanceType<typeof SubmittedUserOpFailedError>
      expect(typed.outcome).toBe('receipt_unconfirmed')
      expect(typed.userOpHash).toBe(hashOfReceivedOperation(sentOperation(bundler)))
    } finally {
      await bundler.close()
    }
  })

  it('a body that is not a JSON-RPC answer is the typed outcome-unknown error', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ httpStatus: 200, body: '<html>gateway</html>', contentType: 'text/html' }),
      }),
    )
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      expect((error as InstanceType<typeof SubmittedUserOpFailedError>).outcome).toBe('receipt_unconfirmed')
    } finally {
      await bundler.close()
    }
  })

  it('a connection reset on the send is the typed outcome-unknown error', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ reset: true }) }))
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      expect((error as InstanceType<typeof SubmittedUserOpFailedError>).outcome).toBe('receipt_unconfirmed')
    } finally {
      await bundler.close()
    }
  })
})

// ── submitCall ──────────────────────────────────────────────────────────────

describe('submitCall — a lost send answer and the owner-side receipt wait (#4817)', () => {
  it('a send that is never answered rejects with the typed outcome-unknown error, hashed from the operation the bundler received', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ hang: true }) }))
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const error = await treasury.submitCall(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      const typed = error as InstanceType<typeof SubmittedUserOpFailedError>
      expect(typed.outcome).toBe('receipt_unconfirmed')
      expect(typed.userOpHash).toBe(hashOfReceivedOperation(sentOperation(bundler)))
    } finally {
      await bundler.close()
    }
  }, 30_000)

  it('a receipt wait that throws rejects with the typed outcome-unknown error carrying the hash the send returned', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ result: `0x${'77'.repeat(32)}` }),
        eth_getUserOperationReceipt: () => ({ error: { code: -32000, message: 'receipt index unavailable' } }),
      }),
    )
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const error = await treasury.submitCall(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      const typed = error as InstanceType<typeof SubmittedUserOpFailedError>
      expect(typed.outcome).toBe('receipt_unconfirmed')
      expect(typed.userOpHash).toBe(`0x${'77'.repeat(32)}`)
    } finally {
      await bundler.close()
    }
  })

  it('a receipt that says the op landed and reverted rejects with the typed included_reverted variant', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ result: `0x${'77'.repeat(32)}` }),
        eth_getUserOperationReceipt: () => receiptAnswer(false),
      }),
    )
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const error = await treasury.submitCall(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(SubmittedUserOpFailedError)
      const typed = error as InstanceType<typeof SubmittedUserOpFailedError>
      expect(typed.outcome).toBe('included_reverted')
      expect(typed.reverted).toBe(true)
      expect(typed.userOpHash).toBe(`0x${'77'.repeat(32)}`)
      expect(typed.actualGasCost).toBe(10_000n)
    } finally {
      await bundler.close()
    }
  })

  it('a send answered with a JSON-RPC error stays an ordinary pre-send error', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ error: { code: -32500, message: 'AA25 invalid account nonce' } }),
      }),
    )
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const error = await treasury.submitCall(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
    } finally {
      await bundler.close()
    }
  })

  it('a successful send and receipt still returns the result', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ result: `0x${'77'.repeat(32)}` }),
        eth_getUserOperationReceipt: () => receiptAnswer(true),
      }),
    )
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const result = await treasury.submitCall(prepared, SIGNATURE)

      expect(result.userOpHash).toBe(`0x${'77'.repeat(32)}`)
      expect(result.txHash).toBe(TX_HASH)
      expect(result.actualGasCost).toBe(10_000n)
    } finally {
      await bundler.close()
    }
  })
})
