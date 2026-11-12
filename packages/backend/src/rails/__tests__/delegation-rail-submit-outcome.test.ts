/**
 * #4817 — CHARACTERIZATION: what both submit functions do TODAY, pinned before
 * the change.
 *
 * Both submit functions are exercised through the REAL rail: the account
 * derivation, the client's prepare step, the send and the receipt wait all
 * run. Two loopback stand-ins answer instead of the chain and the bundler —
 * the chain RPC is the only mocked seam, because the rail builds its public
 * client from `rpcTransport`.
 *
 * Every case here records the CURRENT reading, including the ones the change
 * is meant to flip: a lost send answer and a receipt-wait throw are ordinary
 * errors today, and `submitCall`'s included-and-reverted case is a plain
 * `Error`. The commit that changes the behaviour updates these expectations;
 * the cases that must NOT change (an explicit bundler rejection, an HTTP 4xx,
 * a prepare-step failure) are pinned here so the change cannot quietly widen
 * the typed error over them.
 */
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { entryPoint07Address } from 'viem/account-abstraction'
import type { Address, Hex } from 'viem'

const CHAIN_ID = 84532
const DELEGATE_OWNER = `0x${'11'.repeat(20)}` as Address
const PAYMASTER = `0x${'22'.repeat(20)}`
const USDC = `0x${'33'.repeat(20)}` as Address
const RECIPIENT = `0x${'44'.repeat(20)}` as Address
const SIGNATURE = `0x${'ab'.repeat(97)}` as Hex
const TX_HASH = `0x${'cd'.repeat(32)}` as Hex

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

// ── The loopback stand-ins ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number
  method: string
  params?: unknown[]
}

type Answer =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { httpStatus: number; body?: string; contentType?: string }
  /** Accept the request and never answer it — the lost-answer case. */
  | { hang: true }
  /** Accept the request and drop the connection — also no answer. */
  | { reset: true }

interface StandIn {
  url: string
  requests: JsonRpcRequest[]
  close: () => Promise<void>
}

async function startStandIn(answer: (request: JsonRpcRequest) => Answer | Promise<Answer>): Promise<StandIn> {
  const requests: JsonRpcRequest[] = []
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      void (async () => {
        let parsed: JsonRpcRequest
        try {
          parsed = JSON.parse(raw) as JsonRpcRequest
        } catch {
          res.writeHead(400).end()
          return
        }
        requests.push(parsed)
        const answered = await answer(parsed)
        if ('hang' in answered) return
        if ('reset' in answered) {
          req.socket.destroy()
          return
        }
        if ('httpStatus' in answered) {
          res.writeHead(answered.httpStatus, { 'Content-Type': answered.contentType ?? 'text/plain' })
          res.end(answered.body ?? '')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, ...answered }))
      })()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const bound = server.address()
  const port = typeof bound === 'object' && bound ? bound.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** The chain answers the rail's account derivation needs, and nothing else. */
function chainAnswer(request: JsonRpcRequest): Answer {
  switch (request.method) {
    case 'eth_chainId':
      return { result: '0x14a34' }
    case 'eth_getCode':
      return { result: '0x' }
    case 'eth_call':
      // EntryPoint.getNonce(address, uint192) — a zero nonce is enough.
      return { result: `0x${'00'.repeat(32)}` }
    case 'eth_blockNumber':
      return { result: '0x1' }
    default:
      return { error: { code: -32601, message: `chain stand-in: ${request.method} not supported` } }
  }
}

const GAS_PRICE = { maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00' }

/** The bundler answers a prepare needs, and nothing else. */
function bundlerAnswer(request: JsonRpcRequest): Answer {
  switch (request.method) {
    case 'pimlico_getUserOperationGasPrice':
      return { result: { slow: GAS_PRICE, standard: GAS_PRICE, fast: GAS_PRICE } }
    case 'pm_getPaymasterStubData':
    case 'pm_getPaymasterData':
      return {
        result: {
          paymaster: PAYMASTER,
          paymasterData: '0x',
          paymasterVerificationGasLimit: '0x7530',
          paymasterPostOpGasLimit: '0x2710',
        },
      }
    case 'eth_estimateUserOperationGas':
      return {
        result: {
          callGasLimit: '0x186a0',
          verificationGasLimit: '0x30d40',
          preVerificationGas: '0xc350',
          paymasterVerificationGasLimit: '0x7530',
          paymasterPostOpGasLimit: '0x2710',
        },
      }
    default:
      return { error: { code: -32601, message: `bundler stand-in: ${request.method} not supported` } }
  }
}

function bundlerWith(
  overrides: Partial<Record<string, (request: JsonRpcRequest) => Answer>>,
): (request: JsonRpcRequest) => Answer {
  return (request) => overrides[request.method]?.(request) ?? bundlerAnswer(request)
}

/** A receipt the rail's `waitForUserOperationReceipt` accepts. */
function receiptAnswer(success: boolean): Answer {
  return {
    result: {
      userOpHash: `0x${'ee'.repeat(32)}`,
      entryPoint: entryPoint07Address,
      sender: `0x${'55'.repeat(20)}`,
      nonce: '0x0',
      paymaster: PAYMASTER,
      actualGasCost: '0x2710',
      actualGasUsed: '0x5208',
      success,
      logs: [],
      receipt: {
        transactionHash: TX_HASH,
        blockNumber: '0x1',
        blockHash: `0x${'ff'.repeat(32)}`,
        status: success ? '0x1' : '0x0',
        gasUsed: '0x5208',
        cumulativeGasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        logs: [],
        logsBloom: '0x',
        transactionIndex: '0x0',
        type: '0x2',
        from: `0x${'55'.repeat(20)}`,
        to: entryPoint07Address,
      },
    },
  }
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

describe('submitRedemption — today (#4817 characterization)', () => {
  it('a bundler that accepts eth_sendUserOperation and never answers rejects with an ORDINARY error, not the typed one', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ hang: true }) }))
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
      expect((error as Error).message).toMatch(/took too long to respond/)
    } finally {
      await bundler.close()
    }
  }, 30_000)

  it('a JSON-RPC error answered by the bundler (an AA25 nonce rejection) is an ordinary error', async () => {
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

      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
      expect((error as Error).message).toMatch(/AA25/)
    } finally {
      await bundler.close()
    }
  })

  it.each([429, 401])('an HTTP %i from the bundler with no JSON-RPC body is an ordinary error', async (status) => {
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
  })

  it('a failure in the client prepare step, before the send request, is an ordinary error', async () => {
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
      expect(bundler.requests.some((request) => request.method === 'eth_sendUserOperation')).toBe(false)
    } finally {
      rpcUrlRef.current = previousRpcUrl
      await bundler.close()
      await flakyChain.close()
    }
  })

  it('an HTTP 5xx on the send itself is an ordinary error today', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ httpStatus: 502, body: 'bad gateway' }),
      }),
    )
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
    } finally {
      await bundler.close()
    }
  })

  it('a body that is not a JSON-RPC answer is an ordinary error today', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ httpStatus: 200, body: '<html>gateway</html>', contentType: 'text/html' }),
      }),
    )
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
    } finally {
      await bundler.close()
    }
  })

  it('a connection reset on the send is an ordinary error today', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ reset: true }) }))
    try {
      const { rail, prepared } = await preparedRedemption(bundler.url)
      const error = await rail.submitRedemption(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
    } finally {
      await bundler.close()
    }
  })
})

// ── submitCall ──────────────────────────────────────────────────────────────

describe('submitCall — today (#4817 characterization)', () => {
  it('a send that is never answered rejects with an ORDINARY error, not the typed one', async () => {
    const bundler = await startStandIn(bundlerWith({ eth_sendUserOperation: () => ({ hang: true }) }))
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const error = await treasury.submitCall(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
    } finally {
      await bundler.close()
    }
  }, 30_000)

  it('a receipt wait that throws rejects with an ORDINARY error today', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ result: `0x${'77'.repeat(32)}` }),
        eth_getUserOperationReceipt: () => ({ error: { code: -32000, message: 'receipt index unavailable' } }),
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

  it('a receipt that says the op landed and reverted rejects with a PLAIN Error today', async () => {
    const bundler = await startStandIn(
      bundlerWith({
        eth_sendUserOperation: () => ({ result: `0x${'77'.repeat(32)}` }),
        eth_getUserOperationReceipt: () => receiptAnswer(false),
      }),
    )
    try {
      const { treasury, prepared } = await preparedCall(bundler.url)
      const error = await treasury.submitCall(prepared, SIGNATURE).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SubmittedUserOpFailedError)
      expect((error as Error).message).toBe('treasury UserOp included but reverted')
    } finally {
      await bundler.close()
    }
  })

  it('a send answered with a JSON-RPC error is an ordinary error', async () => {
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

  it('a successful send and receipt returns the result', async () => {
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
