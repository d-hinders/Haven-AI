/**
 * #4817 — loopback stand-ins for the delegation rail's two network seams.
 *
 * The rail talks to a chain RPC (its public client) and a bundler (prepare,
 * paymaster, send, receipt). Both are plain JSON-RPC over HTTP, so a real
 * `node:http` server on 127.0.0.1 answers them and the rail's own code runs
 * unmodified — no module mocking beyond the `rpcTransport` seam that builds
 * the public client.
 *
 * The point of a stand-in rather than a mock is the failure SHAPE: a bundler
 * that accepts `eth_sendUserOperation` and never answers, one that answers
 * with a JSON-RPC error, one that answers HTTP 4xx/5xx, one that returns a
 * body that is not JSON-RPC, and one that drops the connection are five
 * different transport outcomes that a `vi.fn()` cannot produce.
 */
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { entryPoint07Address } from 'viem/account-abstraction'

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: number
  method: string
  params?: unknown[]
}

export type Answer =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { httpStatus: number; body?: string; contentType?: string }
  /** Accept the request and never answer it — the lost-answer case. */
  | { hang: true }
  /** Accept the request and drop the connection — also no answer. */
  | { reset: true }

export interface StandIn {
  url: string
  requests: JsonRpcRequest[]
  close: () => Promise<void>
}

export async function startStandIn(
  answer: (request: JsonRpcRequest) => Answer | Promise<Answer>,
): Promise<StandIn> {
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
export function chainAnswer(request: JsonRpcRequest): Answer {
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

export const PAYMASTER = `0x${'22'.repeat(20)}`
export const TX_HASH = `0x${'cd'.repeat(32)}`

const GAS_PRICE = { maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00' }

/** The bundler answers a prepare needs, and nothing else. */
export function bundlerAnswer(request: JsonRpcRequest): Answer {
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

export function bundlerWith(
  overrides: Partial<Record<string, (request: JsonRpcRequest) => Answer>>,
): (request: JsonRpcRequest) => Answer {
  return (request) => overrides[request.method]?.(request) ?? bundlerAnswer(request)
}

/** A receipt the rail's `waitForUserOperationReceipt` accepts. */
export function receiptAnswer(success: boolean): Answer {
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
