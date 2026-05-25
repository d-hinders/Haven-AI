import { readFile, writeFile } from 'node:fs/promises'
import {
  HavenClient,
  HavenPaymentStateError,
  type X402ResumeState,
} from '@haven_ai/sdk'

const mcpUrl = process.env.MCP_URL
const apiKey = process.env.HAVEN_API_KEY
const delegateKey = process.env.HAVEN_DELEGATE_KEY
const baseUrl = process.env.HAVEN_API_URL
const maxUsd = Number(process.env.MAX_X402_USD ?? '0.05')
const resumeFile = process.env.HAVEN_X402_RESUME_FILE ?? '.haven-x402-resume.json'
const resumePaymentId = process.env.HAVEN_RESUME_PAYMENT_ID

if (!mcpUrl) throw new Error('MCP_URL is required')
if (!apiKey) throw new Error('HAVEN_API_KEY is required')
if (!delegateKey) throw new Error('HAVEN_DELEGATE_KEY is required')

const haven = new HavenClient({ apiKey, delegateKey, baseUrl })

async function initializeMcpSession(): Promise<string> {
  const response = await fetch(mcpUrl!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'haven-x402-mcp-example',
          version: '1.0.0',
        },
      },
    }),
  })

  const sessionId = response.headers.get('mcp-session-id')
  if (!sessionId) {
    throw new Error('MCP initialize response did not include mcp-session-id')
  }

  return sessionId
}

function paidToolCallInit(sessionId: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'paid-call-1',
      method: 'tools/call',
      params: {
        name: process.env.MCP_TOOL ?? 'paid_tool',
        arguments: process.env.MCP_TOOL_ARGS
          ? JSON.parse(process.env.MCP_TOOL_ARGS)
          : {},
      },
    }),
  }
}

function capturedRequest(url: string, init: RequestInit): X402ResumeState['request'] {
  return {
    url,
    method: init.method ?? 'GET',
    headers: Array.from(new Headers(init.headers).entries()),
    body: typeof init.body === 'string' ? init.body : undefined,
  }
}

async function printResponse(response: Response): Promise<void> {
  console.log('HTTP', response.status, response.statusText)
  console.log(await response.text())
}

async function resumeFromSavedState(): Promise<void> {
  const state = JSON.parse(await readFile(resumeFile, 'utf8')) as X402ResumeState
  const response = await haven.resumeX402Payment(state)
  await printResponse(response)
}

async function resumeFromPaymentId(paymentId: string): Promise<void> {
  const state = await haven.getResumeState(paymentId)
  if (state.rail !== 'x402') {
    throw new Error(`Payment ${paymentId} is ${state.rail}; this example resumes x402 payments only.`)
  }

  const sessionId = await initializeMcpSession()
  const request = paidToolCallInit(sessionId)
  state.request = capturedRequest(mcpUrl!, request)
  state.url = state.request.url

  const response = await haven.resumeX402Payment(state)
  await printResponse(response)
}

async function quoteAndPay(): Promise<void> {
  const sessionId = await initializeMcpSession()
  const request = paidToolCallInit(sessionId)
  const idempotencyKey = process.env.HAVEN_X402_IDEMPOTENCY_KEY ?? `mcp:${sessionId}:paid-call-1`

  const quote = await haven.quoteX402(mcpUrl!, request, { idempotencyKey })
  console.log('Quote', {
    amount: quote.amount,
    token: quote.token,
    network: quote.network,
    merchantAddress: quote.merchantAddress,
    resourceUrl: quote.resourceUrl,
  })

  if (Number(quote.amount) > maxUsd) {
    throw new Error(`Quote ${quote.amount} ${quote.token} is above cap ${maxUsd}`)
  }

  try {
    const response = await haven.payX402Quote(quote)
    await printResponse(response)
  } catch (err) {
    if (err instanceof HavenPaymentStateError && err.resumeState) {
      await writeFile(resumeFile, JSON.stringify(err.resumeState, null, 2))
      console.error(`Waiting for user approval in Haven. Resume state saved to ${resumeFile}.`)
      console.error(`After approval, rerun with HAVEN_RESUME_PAYMENT_ID=${err.resumeState.paymentId}.`)
      console.error(`The local file fallback is still available with HAVEN_X402_RESUME=1.`)
      return
    }

    throw err
  }
}

if (resumePaymentId) {
  await resumeFromPaymentId(resumePaymentId)
} else if (process.env.HAVEN_X402_RESUME === '1') {
  await resumeFromSavedState()
} else {
  await quoteAndPay()
}
