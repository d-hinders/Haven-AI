import type { Page, Route } from '@playwright/test'
import { ACTIVE_SAFE_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY } from '../../src/lib/auth-storage'

export const testSafeAddress = '0x1111111111111111111111111111111111111111'
export const testRecipientAddress = '0x2222222222222222222222222222222222222222'

export const testSafe = {
  id: 'safe-main',
  safe_address: testSafeAddress,
  chain_id: 100,
  name: 'Operations',
  is_default: true,
  created_at: '2026-05-01T10:00:00.000Z',
}

export const testUser = {
  id: 'user-e2e',
  name: 'Ada Lovelace',
  email: 'ada@haven.test',
  wallet_address: null,
  safe_address: testSafeAddress,
  safes: [testSafe],
  currency_preference: 'USD',
  created_at: '2026-05-01T10:00:00.000Z',
}

const testAgent = {
  id: 'agent-e2e',
  name: 'Research agent',
  description: 'Runs paid research with a fixed allowance.',
  delegate_address: '0x3333333333333333333333333333333333333333',
  safe_id: testSafe.id,
  safe_address: testSafeAddress,
  safe_name: testSafe.name,
  api_key_prefix: 'haven_e2e',
  status: 'active',
  created_at: '2026-05-02T10:00:00.000Z',
  allowances: [
    {
      id: 'allowance-e2e',
      agent_id: 'agent-e2e',
      token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      token_symbol: 'USDC',
      allowance_amount: '250000000',
      reset_period_min: 43_200,
    },
  ],
}

const dashboardTransaction = {
  hash: `0x${'ab'.repeat(32)}`,
  type: 'erc20',
  from: testSafeAddress,
  to: testRecipientAddress,
  value: '12500000',
  valueFormatted: '12.50',
  asset: 'USDC',
  decimals: 6,
  direction: 'out',
  timestamp: 1_779_000_000,
  blockNumber: 12_345,
  isError: false,
  tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  tokenSymbol: 'USDC',
  agentId: testAgent.id,
  agentName: testAgent.name,
  chainId: 100,
  safeId: testSafe.id,
  safeAddress: testSafeAddress,
  safeName: testSafe.name,
  source: 'x402',
  x402ResourceUrl: 'https://research.example/report',
  x402MerchantAddress: testRecipientAddress,
}

const balances = [
  {
    symbol: 'USDC',
    address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    balance: '1250000000',
    formatted: '1250',
    decimals: 6,
  },
]

const dashboardOverview = {
  totals: {
    usd: 1250,
    eur: 1138,
  },
  change: {
    available: true,
    usdAmount: 25,
    eurAmount: 23,
    usdPercent: 2.04,
    eurPercent: 2.01,
  },
  metrics: {
    connectedAgents: 1,
    monthlyAgentSpendUsd: 12.5,
    monthlyAgentSpendEur: 11.38,
    successfulTransactions: 3,
    activeAccounts: 1,
  },
  actionableApprovals: 1,
  pendingApprovals: 1,
  onboardingProgress: {
    hasFirstAgentPayment: true,
  },
  agents: [
    {
      id: testAgent.id,
      name: testAgent.name,
      status: testAgent.status,
      safeId: testSafe.id,
      safeName: testSafe.name,
      safeChainId: testSafe.chain_id,
      allowances: [
        {
          tokenSymbol: 'USDC',
          allowanceAmount: '250000000',
          resetPeriodMin: 43_200,
        },
      ],
    },
  ],
  transactions: [dashboardTransaction],
}

const approval = {
  id: 'approval-e2e',
  agent_id: testAgent.id,
  agent_name: testAgent.name,
  safe_address: testSafeAddress,
  chain_id: 100,
  token_symbol: 'USDC',
  token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  to_address: testRecipientAddress,
  amount_raw: '12500000',
  amount_human: '12.50',
  reason: 'Buy the requested research report.',
  source: 'x402',
  x402_resource_url: 'https://research.example/report',
  status: 'pending',
  tx_hash: null,
  reviewed_at: null,
  created_at: '2026-05-03T12:00:00.000Z',
  expires_at: '2026-05-04T12:00:00.000Z',
}

type JsonValue = Record<string, unknown> | unknown[]

async function fulfillJson(route: Route, json: JsonValue, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(json),
  })
}

async function fulfillUnmockedRoute(route: Route, method: string, path: string) {
  await fulfillJson(
    route,
    { error: `Unmocked API route: ${method} ${path}` },
    599,
  )
}

async function mockWalletNoise(page: Page) {
  await page.route(/https:\/\/(api\.web3modal\.org|pulse\.walletconnect\.org)\/.*/, async (route) => {
    await fulfillJson(route, {})
  })
}

export async function mockHavenApi(page: Page) {
  await mockWalletNoise(page)

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/, '')
    const method = request.method()

    if (method === 'POST' && path === '/auth/login') {
      await fulfillJson(route, { token: 'e2e-token', user: testUser })
      return
    }

    if (method === 'POST' && path === '/auth/signup') {
      await fulfillJson(route, { token: 'e2e-token', user: testUser })
      return
    }

    if (method === 'GET' && path === '/auth/me') {
      await fulfillJson(route, testUser)
      return
    }

    if (method === 'GET' && path === '/passkeys') {
      await fulfillJson(route, { passkeys: [] })
      return
    }

    if (method === 'GET' && path === '/dashboard/overview') {
      await fulfillJson(route, dashboardOverview)
      return
    }

    if (method === 'GET' && path === '/agents') {
      await fulfillJson(route, { agents: [testAgent] })
      return
    }

    if (method === 'GET' && path === '/contacts') {
      await fulfillJson(route, {
        contacts: [
          {
            id: 'contact-e2e',
            name: 'Research vendor',
            address: testRecipientAddress,
            created_at: '2026-05-02T10:00:00.000Z',
          },
        ],
      })
      return
    }

    if (method === 'GET' && path === '/agent-activity/feed') {
      await fulfillJson(route, { activity: [] })
      return
    }

    if (method === 'GET' && path.startsWith('/portfolio/')) {
      await fulfillJson(route, {
        totalUsd: 1250,
        totalEur: 1138,
        breakdown: [
          {
            symbol: 'USDC',
            balance: '1250000000',
            formatted: '1250',
            usdValue: 1250,
            eurValue: 1138,
          },
        ],
      })
      return
    }

    if (method === 'GET' && path.startsWith('/balances/')) {
      await fulfillJson(route, { balances })
      return
    }

    if (method === 'GET' && path.startsWith('/transactions/')) {
      await fulfillJson(route, {
        transactions: [dashboardTransaction],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      })
      return
    }

    if (method === 'GET' && path === `/safe/${testSafeAddress}/details`) {
      await fulfillJson(route, {
        address: testSafeAddress,
        owners: ['0x4444444444444444444444444444444444444444'],
        threshold: 1,
        nonce: 7,
      })
      return
    }

    if (method === 'GET' && path === '/approvals') {
      await fulfillJson(route, {
        approvals: [approval],
        // Dashboard reads actionable_count first, while older callers may
        // still fall back to pending_count.
        actionable_count: 1,
        pending_count: 1,
      })
      return
    }

    if (method === 'GET' && path === '/user/owners') {
      await fulfillJson(route, {
        owners: [],
        partialFailure: false,
        failedSafeIds: [],
      })
      return
    }

    await fulfillUnmockedRoute(route, method, path)
  })
}

export async function seedAuthenticatedSession(page: Page) {
  await page.addInitScript(
    ({ tokenKey, activeSafeKey }) => {
      window.localStorage.setItem(tokenKey, 'e2e-token')
      window.localStorage.setItem(activeSafeKey, 'safe-main')
    },
    {
      tokenKey: AUTH_TOKEN_STORAGE_KEY,
      activeSafeKey: ACTIVE_SAFE_STORAGE_KEY,
    },
  )
}

const ignoredBrowserErrorPatterns = [
  /walletconnect/i,
  /wagmi/i,
  /web3modal/i,
  /reown/i,
  /failed to load resource.*\.well-known/i,
]

export function collectBrowserErrors(page: Page) {
  const errors: string[] = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location()
      errors.push(location.url ? `${message.text()} (${location.url})` : message.text())
    }
  })

  page.on('pageerror', (error) => {
    errors.push(error.message)
  })

  return errors
}

export function unexpectedBrowserErrors(errors: string[]) {
  return errors.filter(
    (error) => !ignoredBrowserErrorPatterns.some((pattern) => pattern.test(error)),
  )
}

export async function dismissMobileSidebar(page: Page) {
  const viewport = page.viewportSize()
  if (!viewport || viewport.width >= 1024) return

  const closeButton = page.getByRole('button', { name: 'Close sidebar' })
  if (await closeButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeButton.click({ force: true })
    await page.getByRole('button', { name: 'Open sidebar' }).waitFor({ state: 'visible' })
  }
}

export async function expectNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const documentWidth = document.documentElement.clientWidth
    const scrollWidth = document.documentElement.scrollWidth
    const bodyScrollWidth = document.body.scrollWidth

    return {
      documentWidth,
      scrollWidth,
      bodyScrollWidth,
      hasOverflow: scrollWidth > documentWidth + 1 || bodyScrollWidth > documentWidth + 1,
    }
  })
}
