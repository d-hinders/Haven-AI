/**
 * Test harness: a mocked upstream (a local node:http server), a fake Coinbase
 * facilitator and chain reader, a buyer that signs real EIP-3009
 * authorizations, and a proxy started over a temp payments database. No vendor
 * access: nothing here reaches Coinbase or a chain.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { createSIWxPayload, encodeSIWxHeader, type CompleteSIWxInfo } from '@x402/extensions/sign-in-with-x'
import { buildSignedTaxDeclaration, encodeTaxDeclarationHeader } from '@haven_ai/sdk/edge'
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { AuthorizationOutcome, CdpChainReader, CdpFacilitator } from '@haven_ai/merchant-payments'
import { startProxy, type RunningProxy, type StartOverrides } from './main.js'
import type { SiwxChallenge } from './siwx.js'

export const PAY_TO = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' as Address
export const UPSTREAM_KEY = 'sk-upstream-SECRET-0123456789'
export const CDP_SECRET = 'cdp-secret-SECRET-abcdefghij'
export const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address
/** #4898: a Sales key (#4896's prefix), long enough for the log redactor to hold it. */
export const SALES_KEY = 'sk_merchant_test_0123456789abcdef'

export interface SeenRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export interface UpstreamBehaviour {
  status: number
  headers: Record<string, string>
  body: string | Buffer
  /** Never answer: the request hangs until the client goes away. */
  hang?: boolean
  /** Send these headers and `declared` as Content-Length, then end early. */
  truncateAfter?: number
}

export interface MockUpstream {
  url: string
  seen: SeenRequest[]
  behaviour: UpstreamBehaviour
  closedByClient: () => number
  close(): Promise<void>
}

export async function startUpstream(initial?: Partial<UpstreamBehaviour>): Promise<MockUpstream> {
  const seen: SeenRequest[] = []
  let closed = 0
  const mock: MockUpstream = {
    url: '',
    seen,
    behaviour: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'cmpl-1', choices: [{ message: { content: 'hello' } }], usage: { completion_tokens: 5 } }),
      ...initial,
    },
    closedByClient: () => closed,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.on('close', () => {
        if (!res.writableEnded) closed += 1
      })
      const b = mock.behaviour
      if (b.hang) return
      const body = typeof b.body === 'string' ? Buffer.from(b.body) : b.body
      if (b.truncateAfter !== undefined) {
        res.writeHead(b.status, { ...b.headers, 'content-length': String(body.length) })
        res.write(body.subarray(0, b.truncateAfter))
        setTimeout(() => res.destroy(), 5)
        return
      }
      res.writeHead(b.status, { ...b.headers, 'content-length': String(body.length) })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return mock
}

export interface HavenRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export interface HavenBehaviour {
  status: number
  body?: unknown
  headers?: Record<string, string>
  /** Never answer: the reporter's attempt times out. */
  hang?: boolean
  /** Answer after this many ms. */
  delayMs?: number
}

export interface MockHaven {
  url: string
  seen: HavenRequest[]
  behaviour: HavenBehaviour
  close(): Promise<void>
}

/**
 * #4898: a mocked Haven, the `POST /merchant/sales` route (#4897). It records
 * every request and answers with `behaviour`, so a test can make Haven accept,
 * refuse, hang or be unreachable without reaching the real API.
 */
export async function startHaven(initial?: Partial<HavenBehaviour>): Promise<MockHaven> {
  const seen: HavenRequest[] = []
  const mock: MockHaven = {
    url: '',
    seen,
    behaviour: { status: 201, body: { sale: { id: 'sale-1' } }, ...initial },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const behaviour = mock.behaviour
      if (behaviour.hang) return
      const answer = (): void => {
        const text = JSON.stringify(behaviour.body ?? {})
        res.writeHead(behaviour.status, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
          ...behaviour.headers,
        })
        res.end(text)
      }
      if (behaviour.delayMs !== undefined) setTimeout(answer, behaviour.delayMs)
      else answer()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return mock
}

export class FakeFacilitator implements CdpFacilitator {
  verifyCalls = 0
  settleCalls = 0
  events: string[] = []
  verifyResult: VerifyResponse | Error = { isValid: true }
  settleResult: SettleResponse | Error | (() => Promise<SettleResponse>) = {
    success: true,
    transaction: `0x${'1'.repeat(64)}`,
    network: 'eip155:84532',
  }

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1
    this.events.push('verify')
    if (this.verifyResult instanceof Error) throw this.verifyResult
    return this.verifyResult
  }

  async settle(): Promise<SettleResponse> {
    this.settleCalls += 1
    this.events.push('settle')
    const result = this.settleResult
    if (result instanceof Error) throw result
    if (typeof result === 'function') return result()
    return result
  }
}

export class FakeChain implements CdpChainReader {
  used = new Set<string>()
  outcome: AuthorizationOutcome | null = null
  readError = false
  reads = 0
  searches = 0

  async authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
    this.reads += 1
    if (this.readError) throw new Error('rpc down')
    return this.used.has(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`)
  }

  async findAuthorizationOutcome(): Promise<AuthorizationOutcome | null> {
    this.searches += 1
    return this.outcome
  }

  markUsed(payer: Address, nonce: Hex): void {
    this.used.add(`${payer.toLowerCase()}:${nonce.toLowerCase()}`)
  }
}

export interface ProductFixture {
  id: string
  route: string
  price: string
  description: string
  model?: string
  output_token_cap?: number
  name?: string
  input_example?: unknown
  input_schema?: unknown
  output_example?: unknown
}

export const CHAT_PRODUCT: ProductFixture = {
  id: 'chat-sol-1k',
  name: 'Chat, 1,000 output tokens',
  route: 'POST /v3/compat/chat/completions',
  model: 'openai/gpt-6-sol',
  price: '10000',
  output_token_cap: 1000,
  description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
}
export const PLAIN_PRODUCT: ProductFixture = {
  id: 'lookup',
  route: 'GET /v1/lookup',
  price: '20000',
  description: 'One lookup.',
}
export const OTHER_PRODUCT: ProductFixture = {
  id: 'other',
  route: 'GET /v1/other',
  // The SAME price as PLAIN_PRODUCT, so only the payment's resource tells the two apart.
  price: '20000',
  description: 'Another lookup at the same price.',
}

export interface Harness {
  dir: string
  upstream: MockUpstream
  facilitator: FakeFacilitator
  chain: FakeChain
  env: Record<string, string>
  proxy: RunningProxy
  logs: Record<string, unknown>[]
  base: string
  restart(overrides?: StartOverrides, envChanges?: Record<string, string>): Promise<void>
  stop(): Promise<void>
}

export async function startHarness(options: {
  products?: ProductFixture[]
  env?: Record<string, string>
  upstream?: Partial<UpstreamBehaviour>
  overrides?: StartOverrides
  dir?: string
} = {}): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'paywall-proxy-'))
  const upstream = await startUpstream(options.upstream)
  const facilitator = new FakeFacilitator()
  const chain = new FakeChain()
  const productsFile = join(dir, 'products.json')
  writeFileSync(productsFile, JSON.stringify({ version: 1, products: options.products ?? [CHAT_PRODUCT, PLAIN_PRODUCT, OTHER_PRODUCT] }))
  const env: Record<string, string> = {
    NETWORK: 'eip155:84532',
    PAY_TO,
    OPERATOR_NAME: 'Test operator',
    ENDPOINT_NAME: 'Test endpoint',
    ENDPOINT_DESCRIPTION: 'A test endpoint that sells calls.',
    PRODUCTS_FILE: productsFile,
    PAYMENTS_DB: join(dir, 'payments.sqlite'),
    UPSTREAM_BASE_URL: upstream.url,
    UPSTREAM_API_KEY: UPSTREAM_KEY,
    CDP_API_KEY_ID: 'cdp-key-id',
    CDP_API_KEY_SECRET: CDP_SECRET,
    RPC_URL: 'http://127.0.0.1:1',
    PORT: '0',
    HOST: '127.0.0.1',
    ...options.env,
  }
  const logs: Record<string, unknown>[] = []
  const harness = {
    dir,
    upstream,
    facilitator,
    chain,
    env,
    logs,
  } as Harness
  const overridesFor = (overrides?: StartOverrides): StartOverrides => ({
    cdp: { facilitator, chain },
    log: (event, fields) => {
      logs.push({ event, ...fields })
    },
    settleResolveMs: 40,
    settlePollMs: 5,
    // Every test calls from 127.0.0.1: the per-IP limits are raised here and driven at their real values in limits tests.
    limits: { unpaidBurst: 10_000, unpaidPerMinute: 600_000, unpaidConcurrentPerIp: 10_000, upstreamSlotWaitMs: 200 },
    ...options.overrides,
    ...overrides,
  })
  harness.proxy = await startProxy(env, overridesFor())
  harness.base = `http://127.0.0.1:${harness.proxy.port}`
  harness.restart = async (overrides, envChanges) => {
    await harness.proxy.close()
    Object.assign(env, envChanges)
    harness.proxy = await startProxy(env, overridesFor(overrides))
    harness.base = `http://127.0.0.1:${harness.proxy.port}`
  }
  harness.stop = async () => {
    await harness.proxy.close().catch(() => undefined)
    await upstream.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return harness
}

// ---- the buyer -----------------------------------------------------------

export interface Buyer {
  address: Address
  /** Fetch a challenge, then sign a payment for it. */
  pay(h: Pick<Harness, 'base'>, path: string, init: RequestInit & { amountOverride?: string; validBeforeOffset?: number; resourceUrl?: string; omitResource?: boolean }): Promise<{ header: string; payload: PaymentPayload; challenge: PaymentRequired }>
  /**
   * Answer the proxy's SIGN-IN-WITH-X challenge with the payer key, through the
   * reference client (`@x402/extensions`), which Haven's signer matches byte
   * for byte.
   */
  signIn(challenge: SiwxChallenge, url: string): Promise<string>
  /**
   * #4913: a buyer's signed tax declaration, base64url in the
   * `X-Tax-Declaration` header, signed by the same key that signs the payment.
   */
  signTaxDeclaration(content: { jurisdiction: string; taxId: string; taxableStatus?: string; validUntil?: number }): string
}

export async function signInAs(account: ReturnType<typeof privateKeyToAccount>, challenge: SiwxChallenge, url: string): Promise<string> {
  const info = { ...challenge.info, chainId: challenge.supportedChains[0]!.chainId, type: 'eip191' } as CompleteSIWxInfo
  return encodeSIWxHeader(await createSIWxPayload(info, account, url))
}

export function newBuyer(): Buyer {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    signIn: (challenge, url) => signInAs(account, challenge, url),
    signTaxDeclaration: (content) =>
      encodeTaxDeclarationHeader(
        buildSignedTaxDeclaration({
          content: {
            version: 'x402-tax-1',
            jurisdiction: content.jurisdiction,
            taxableStatus: content.taxableStatus ?? 'TAXABLE_PERSON',
            taxId: content.taxId,
            validUntil: content.validUntil ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
          },
          network: 'eip155:84532',
          delegateKey: privateKey,
        }),
      ),
    async pay(h, path, init) {
      const { amountOverride, validBeforeOffset, resourceUrl, omitResource, ...fetchInit } = init
      const unpaid = await fetch(`${h.base}${path}`, fetchInit)
      const challenge = (await unpaid.json()) as PaymentRequired
      const accepted: PaymentRequirements = challenge.accepts[0]!
      const now = Math.floor(Date.now() / 1000)
      const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex
      const authorization = {
        from: account.address,
        to: accepted.payTo as Address,
        value: amountOverride ?? accepted.amount,
        validAfter: String(now - 60),
        validBefore: String(now + (validBeforeOffset ?? 300)),
        nonce,
      }
      const signature = await account.signTypedData({
        domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: SEPOLIA_USDC },
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
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce,
        },
      })
      const payload: PaymentPayload = {
        x402Version: 2,
        ...(omitResource ? {} : { resource: { ...challenge.resource, url: resourceUrl ?? challenge.resource.url } }),
        accepted,
        payload: { authorization, signature },
      }
      return { header: encodePaymentSignatureHeader(payload), payload, challenge }
    },
  }
}

export const CHAT_BODY = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5000 })
export const CHAT_PATH = '/v3/compat/chat/completions'

export function chatRequest(extra: Record<string, string> = {}, body: string = CHAT_BODY): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body }
}

/** Send a request with a raw node:http client, so the test can abort it mid-flight. */
export function rawRequest(
  base: string,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): { req: ReturnType<typeof httpRequest>; done: Promise<{ status: number; text: string }> } {
  const url = new URL(path, base)
  let resolveDone: (value: { status: number; text: string }) => void
  let rejectDone: (reason: unknown) => void
  const done = new Promise<{ status: number; text: string }>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const req = httpRequest(url, { method: init.method, headers: init.headers }, (res) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => resolveDone({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', (err) => rejectDone(err))
  if (init.body) req.write(init.body)
  req.end()
  return { req, done }
}

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}
