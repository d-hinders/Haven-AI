import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildMerchantMcpServer, runWithSettledPayment } from './server.js'
import {
  LEGACY_PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PaymentError,
  type SettledPayment,
  type X402PaymentProcessor,
} from './x402.js'
import {
  CHAIN_ID,
  HOSTED_DEMO_MERCHANT_URLS,
  PRODUCTS,
  formatUsdc,
  isSettlementMethod,
  merchantEnvironmentForChain,
  type ProductId,
  type SettlementMethod,
} from './products.js'
import { invoiceForPayment } from './invoice.js'
import type { Address } from 'viem'

export interface DemoMerchantServerOptions {
  merchantAddress: Address
  baseUrl: string
  paymentProcessor: X402PaymentProcessor
  path?: string
  settlementMethods?: readonly SettlementMethod[]
}

interface MerchantSession {
  server: ReturnType<typeof buildMerchantMcpServer>
  transport: StreamableHTTPServerTransport
}

interface PaymentToolInfo {
  productId: ProductId
  product: (typeof PRODUCTS)[ProductId]
  description: string
  settlementMethod?: SettlementMethod
}

const MAX_BODY_BYTES = 500_000

export function createDemoMerchantServer(options: DemoMerchantServerOptions): Server {
  const path = options.path ?? '/mcp'
  const sessions = new Map<string, MerchantSession>()

  return createServer((req, res) => {
    handle(req, res, { ...options, path }, sessions).catch((err) => {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null,
      })
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<DemoMerchantServerOptions, 'path'>> & DemoMerchantServerOptions,
  sessions: Map<string, MerchantSession>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  applyCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
    writeJson(res, 200, {
      status: 'ok',
      merchant: options.merchantAddress,
      environment: merchantEnvironmentForChain(CHAIN_ID),
      chain_id: CHAIN_ID,
      network: `eip155:${CHAIN_ID}`,
      mcp_url: `${options.baseUrl}${options.path}`,
    })
    return
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/.well-known/haven-demo-merchant')) {
    writeJson(res, 200, buildDiscovery(options))
    return
  }

  if (url.pathname !== options.path) {
    writeJson(res, 404, jsonRpcError(-32601, 'Not found'))
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    writeJson(res, 405, jsonRpcError(-32000, 'Method not allowed'))
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    writeJson(res, 400, jsonRpcError(-32700, err instanceof Error ? err.message : 'Invalid JSON'))
    return
  }

  const paymentToolInfo = extractPaymentToolInfo(body)
  const session = await getSession(req, body, options, sessions)

  let settled: SettledPayment | undefined
  if (paymentToolInfo) {
    const payment = await handlePaymentGate(req, res, options, paymentToolInfo)
    if (!payment) return
    settled = payment
    res.setHeader(PAYMENT_RESPONSE_HEADER, settled.paymentResponseHeader)
    // #956: hand the paying agent the merchant's OWN receipt machine-readably.
    // Base64 keeps the header ASCII-safe; the SDK captures and reports it to
    // Haven, whose reporting feed attaches it next to the payment evidence.
    const receiptInvoice = invoiceForPayment(settled, paymentToolInfo.productId)
    res.setHeader('x-receipt-json', Buffer.from(JSON.stringify(receiptInvoice.json), 'utf8').toString('base64'))
  }

  try {
    await runWithSettledPayment(settled, () => session.transport.handleRequest(req, res, body))
    if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
      sessions.set(session.transport.sessionId, session)
    }
  } finally {
    if (!session.transport.sessionId) {
      await closeSession(session, sessions)
    }
  }
}

async function handlePaymentGate(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<DemoMerchantServerOptions, 'path'>> & DemoMerchantServerOptions,
  paymentToolInfo: PaymentToolInfo,
): Promise<SettledPayment | null> {
  const { productId, product, description, settlementMethod } = paymentToolInfo
  const paymentRequired = options.paymentProcessor.buildPaymentRequired({
    merchantAddress: options.merchantAddress,
    amountUsdc: product.price_usdc,
    resource: `${options.baseUrl}${options.path}`,
    description,
    settlementMethod,
  })
  const paymentHeader = getPaymentHeader(req)

  if (!paymentHeader) {
    writePaymentRequired(res, options, paymentRequired)
    return null
  }

  try {
    return await options.paymentProcessor.verifyAndSettle({
      productId,
      paymentHeader,
      merchantAddress: options.merchantAddress,
      expectedAmount: product.price_usdc,
      paymentRequired,
    })
  } catch (err) {
    writePaymentRequired(
      res,
      options,
      { ...paymentRequired, error: err instanceof PaymentError ? err.message : 'Payment failed' },
    )
    return null
  }
}

async function getSession(
  req: IncomingMessage,
  body: unknown,
  options: Required<Pick<DemoMerchantServerOptions, 'path'>> & DemoMerchantServerOptions,
  sessions: Map<string, MerchantSession>,
): Promise<MerchantSession> {
  const requestedSessionId = firstHeader(req.headers['mcp-session-id'])
  if (requestedSessionId) {
    const existing = sessions.get(requestedSessionId)
    if (existing) return existing
  }

  const stateful = isInitializeRequest(body)
  const server = buildMerchantMcpServer({
    merchantAddress: options.merchantAddress,
    baseUrl: options.baseUrl,
    buildPaymentRequired: options.paymentProcessor.buildPaymentRequired,
    settlementMethods: options.settlementMethods,
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateful ? () => randomUUID() : undefined,
  })
  const session: MerchantSession = { server, transport }

  transport.onclose = () => {
    transport.onclose = undefined
    if (transport.sessionId) sessions.delete(transport.sessionId)
    void server.close()
  }
  await server.connect(transport)

  return session
}

async function closeSession(session: MerchantSession, sessions: Map<string, MerchantSession>): Promise<void> {
  if (session.transport.sessionId) sessions.delete(session.transport.sessionId)
  session.transport.onclose = undefined
  await session.transport.close()
  await session.server.close()
}

function getPaymentHeader(req: IncomingMessage): string | undefined {
  return (
    firstHeader(req.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()]) ??
    firstHeader(req.headers[LEGACY_PAYMENT_SIGNATURE_HEADER.toLowerCase()])
  )
}

function writePaymentRequired(
  res: ServerResponse,
  options: DemoMerchantServerOptions,
  paymentRequired: ReturnType<X402PaymentProcessor['buildPaymentRequired']>,
): void {
  res.writeHead(402, {
    'Content-Type': 'application/json',
    [PAYMENT_REQUIRED_HEADER]: options.paymentProcessor.paymentRequiredHeader(paymentRequired),
  })
  res.end(JSON.stringify(paymentRequired))
}

function buildDiscovery(
  options: Required<Pick<DemoMerchantServerOptions, 'path'>> & DemoMerchantServerOptions,
) {
  const environment = merchantEnvironmentForChain(CHAIN_ID)
  const settlementMethods = options.settlementMethods?.length ? [...options.settlementMethods] : ['eip3009']
  return {
    name: 'Haven Demo Merchant',
    environment,
    chain_id: CHAIN_ID,
    network: `eip155:${CHAIN_ID}`,
    mcp_url: `${options.baseUrl}${options.path}`,
    current_base_url: options.baseUrl,
    hosted_urls: {
      dev: `${HOSTED_DEMO_MERCHANT_URLS.dev}${options.path}`,
      prod: `${HOSTED_DEMO_MERCHANT_URLS.prod}${options.path}`,
    },
    routing: {
      dev: {
        chain_id: 84532,
        network: 'eip155:84532',
        mcp_url: `${HOSTED_DEMO_MERCHANT_URLS.dev}${options.path}`,
      },
      prod: {
        chain_id: 8453,
        network: 'eip155:8453',
        mcp_url: `${HOSTED_DEMO_MERCHANT_URLS.prod}${options.path}`,
      },
    },
    settlement_methods: settlementMethods,
    default_settlement_method: settlementMethods.includes('erc7710') ? 'erc7710' : settlementMethods[0],
    products: Object.values(PRODUCTS).map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      price_usdc: formatUsdc(product.price_usdc),
      settlement_methods: product.x402.settlementMethods.filter((method) => settlementMethods.includes(method)),
      default_settlement_method: settlementMethods.includes(product.x402.defaultSettlementMethod)
        ? product.x402.defaultSettlementMethod
        : settlementMethods[0],
      tools: product.category === 'vpn' ? ['buy_vpn'] : ['buy_cloud_storage'],
    })),
  }
}

function extractPaymentToolInfo(body: unknown): PaymentToolInfo | null {
  if (!body || typeof body !== 'object') return null
  const rpc = body as Record<string, unknown>
  if (rpc.method !== 'tools/call') return null

  const params = rpc.params as Record<string, unknown> | undefined
  if (!params || typeof params.name !== 'string') return null

  const toolName = params.name
  const args = (params.arguments as Record<string, unknown> | undefined) ?? {}
  const settlementMethod = isSettlementMethod(args.settlement_method) ? args.settlement_method : undefined

  let productId: ProductId | null = null
  let descriptionSuffix = '1 månads abonnemang'

  if (toolName === 'buy_vpn') {
    const plan = args.plan as string | undefined
    if (plan === 'basic' || plan === 'pro' || plan === 'ultra') {
      productId = `vpn_${plan}` as ProductId
    }
  } else if (toolName === 'buy_cloud_storage') {
    const tier = args.tier as string | undefined
    if (tier === '50gb' || tier === '200gb' || tier === '1tb') {
      productId = `storage_${tier}` as ProductId
      descriptionSuffix = '1 månads lagring'
    }
  }

  if (!productId) return null
  const product = PRODUCTS[productId]
  return { productId, product, description: `${product.name} — ${descriptionSuffix}`, settlementMethod }
}

function isInitializeRequest(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as Record<string, unknown>).method === 'initialize')
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function applyCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    [
      'Authorization',
      'Content-Type',
      'Accept',
      'MCP-Protocol-Version',
      PAYMENT_SIGNATURE_HEADER,
      LEGACY_PAYMENT_SIGNATURE_HEADER,
    ].join(', '),
  )
  res.setHeader('Access-Control-Expose-Headers', `${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_RESPONSE_HEADER}, mcp-session-id`)
  res.setHeader('Access-Control-Max-Age', '86400')
}
