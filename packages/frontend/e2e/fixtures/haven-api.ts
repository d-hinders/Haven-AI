import type { Page, Route } from '@playwright/test'
import { ACTIVE_SAFE_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY } from '../../src/lib/auth-storage'

export const testSafeAddress = '0x1111111111111111111111111111111111111111'
export const testRecipientAddress = '0x2222222222222222222222222222222222222222'

export const testSafe = {
  id: 'safe-main',
  safe_address: testSafeAddress,
  chain_id: 8453,
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

export const testAgent = {
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

export const dashboardTransaction = {
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
  chainId: 8453,
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

export const dashboardOverview = {
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

export const testApproval = {
  id: 'approval-e2e',
  agent_id: testAgent.id,
  agent_name: testAgent.name,
  safe_address: testSafeAddress,
  chain_id: 8453,
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
  let connectAgent2SetupCreated = false
  let connectAgent2StatusReads = 0

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

    if (method === 'POST' && path === '/agent-connection-setups') {
      connectAgent2SetupCreated = true
      await fulfillJson(route, {
        setup_id: 'setup-e2e',
        status: 'awaiting_connection',
        setup_token: 'hv_setup_e2e123',
        expires_at: '2099-01-01T00:00:00.000Z',
        connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_e2e123 --api https://api.haven.example --ack-local-tools --runtime claude-code',
        setup_prompt: [
          'Please connect this workspace to Haven.',
          '',
          'I approve running this exact Haven setup command. It may download and execute the published npm package @haven_ai/connect@alpha, connect to Haven at https://api.haven.example, write local Haven credential files under ~/.haven, and update the local agent MCP config when supported.',
          '',
          'Run this exact command:',
          '',
          'npx -y @haven_ai/connect@alpha --setup hv_setup_e2e123 --api https://api.haven.example --ack-local-tools --runtime claude-code',
          '',
          'Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.',
          '',
          'The Haven connector generates the signing key locally and sends Haven only the public signing address plus proof.',
          '',
          'If you are orchestrating this setup programmatically, the connector also supports a --json mode: one machine-readable, secret-free result object on stdout, progress on stderr. Appending --json is the ONLY permitted change to the command above.',
          '',
          'When the connector finishes, tell me to return to Haven to approve the budget.',
        ].join('\n'),
      }, 201)
      return
    }

    if (method === 'GET' && path === '/agent-connection-setups/setup-e2e') {
      connectAgent2StatusReads += 1
      const connectedLocal = connectAgent2SetupCreated && connectAgent2StatusReads > 1
      await fulfillJson(route, {
        setup_id: 'setup-e2e',
        agent_id: connectedLocal ? 'agent-connect-agent-e2e' : null,
        status: connectedLocal ? 'connected_local' : 'awaiting_connection',
        expires_at: '2099-01-01T00:00:00.000Z',
        agent: { name: 'Research Agent', description: null },
        haven_wallet: {
          id: testSafe.id,
          name: testSafe.name,
          address: testSafeAddress,
          chain_id: 8453,
          network: 'Base',
        },
        agent_budget: [{
          id: 'budget-connect-agent-e2e',
          token_address: '0x0000000000000000000000000000000000000000',
          token_symbol: 'ETH',
          allowance_amount: '10000000000000000000',
          reset_period_min: 1440,
        }],
        delegate_address: connectedLocal
          ? '0x3333333333333333333333333333333333333333'
          : null,
        api_key_prefix: connectedLocal ? 'sk_agent_abc' : null,
        runtime: 'claude-code',
        connector: { connector_version: '0.1.2', environment_label: 'Local workspace' },
        install_status: {
          runtime_mcp_mode: 'local_stdio',
          hosted_mcp_configured: false,
          local_signer_configured: true,
          local_mcp_configured: true,
          credential_files_written: true,
          local_mcp_acknowledged: true,
          activation_command_available: false,
          restart_required: true,
          probe_result: 'local_stdio_mcp_ready',
        },
        approval: { status: 'pending_approval', safe_tx_hash: null, tx_hash: null },
      })
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

    // Transaction history page filter options. Must be checked before the
    // `/transactions/` catch-all below, which it would otherwise match.
    if (method === 'GET' && path === '/transactions/filters') {
      await fulfillJson(route, {
        safes: [
          { id: testSafe.id, name: testSafe.name, address: testSafeAddress, chainId: 8453 },
        ],
        agents: [{ id: testAgent.id, name: testAgent.name, status: testAgent.status }],
        tokens: [
          { key: '8453:0xddafbb505ad214d7b80b1f830fccc89b60fb7a83', symbol: 'USDC', address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83', chainId: 8453, isNative: false },
        ],
      })
      return
    }

    // Transaction history feed (TransactionsClient). Exact `/transactions`
    // path with a query string — distinct from the dashboard's per-safe
    // `/transactions/{id}` reads handled by the catch-all below.
    if (method === 'GET' && path === '/transactions') {
      await fulfillJson(route, {
        transactions: [dashboardTransaction],
        total: 1,
        offset: 0,
        limit: 25,
        hasMore: false,
        partialFailure: false,
        failedSafeIds: [],
      })
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
        approvals: [testApproval],
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
  // On-chain allowance reads fire when the Safe module config page opens;
  // in E2E there is no real blockchain provider, so these contract calls
  // return empty data. They do not affect the UI flows under test.
  /Failed to fetch on-chain allowances/i,
  /ContractFunctionExecutionError/i,
  /isModuleEnabled/i,
  // Vercel's live-feedback toolbar (vercel.live) is injected only on Preview
  // deployments and trips a REPORT-ONLY CSP notice when it frames itself.
  // Preview-only tooling noise, never present in prod. Match both together so
  // a real (enforced) CSP violation from our own app still fails the smoke.
  /report-only content security policy.*vercel\.live|vercel\.live.*report-only content security policy/is,
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
    // No `{ force: true }` (#1749). It used to be required, and that was the
    // undiagnosed symptom: `force` skips the actionability check, and the
    // check this helper was failing is the hit-test — TopBar's `z-[100]`
    // covered the toggle's `z-[60]`, so the real user gesture was impossible
    // on every authenticated route below `lg`. Keeping the plain click makes
    // this helper the regression canary: if the layering breaks again, every
    // mobile e2e test fails here with "intercepts pointer events" instead of
    // quietly forcing its way through.
    await closeButton.click()
    await page.getByRole('button', { name: 'Open sidebar' }).waitFor({ state: 'visible' })
  }
}

/**
 * Horizontal overflow, measured on BOTH scroll boxes that can hold it.
 *
 * ## Why there are two metrics (#1771)
 *
 * This helper used to compare the document alone —
 * `documentElement.scrollWidth` / `body.scrollWidth` against
 * `documentElement.clientWidth`. Inside the authenticated shell that
 * comparison **cannot fail**. `(authenticated)/layout.tsx` wraps everything in
 * `overflow-hidden` twice (the `flex h-screen … overflow-hidden` root and the
 * `flex-1 flex flex-col min-w-0 overflow-hidden` column), so overflowing
 * content is CLIPPED: it never grows the document, and the old metric reported
 * a clean fit while content sat unreachable past the bezel.
 *
 * That is worse than no check, because it gets cited as evidence. It was found
 * only by mutation — #1768 shipped a deliberate `w-[120vw]` on `/dashboard`
 * and CI run 32542736317 went green, with the overflow assertion explicitly
 * passing.
 *
 * So the document metric is kept — it is the ONLY one that works on
 * unauthenticated pages like `/login`, which have no shell and no
 * `#main-content` — and the content-region metric is added beside it.
 * `<main id="main-content">` is `overflow-y-auto`, which computes `overflow-x`
 * to `auto`, so it is a real scroll box: comparing its own `scrollWidth`
 * against its own `clientWidth` sees exactly what the shell was hiding.
 *
 * `hasOverflow` is the UNION, so every existing
 * `toMatchObject({ hasOverflow: false })` call site starts gating for real
 * without changing shape. The two booleans are also returned separately for a
 * caller that needs to say which one it means.
 *
 * ## Assert `contentRegionFound` on authenticated routes
 *
 * When `#main-content` is absent the content metric degrades to `false` — the
 * silent no-op that this whole helper exists to prevent. It cannot tell on its
 * own whether a page SHOULD have a content region, so authenticated call sites
 * pass `{ hasOverflow: false, contentRegionFound: true }` and make the no-op
 * path loud. `/login` legitimately has no content region and asserts only
 * `hasOverflow`.
 *
 * ## Known blind spot: `position: fixed` overlays
 *
 * Neither metric sees overflow INSIDE a fixed-position modal. A fixed element
 * is laid out against the viewport, so it contributes to neither the
 * document's scrollable overflow nor `<main>`'s — and an ancestor's
 * `overflow-hidden` does not clip it either. Measured, not assumed (#1771).
 * Call sites that open a dialog before asserting are therefore measuring the
 * page BEHIND the dialog, which is still a real assertion but not a check on
 * the dialog's own layout. Tracked separately rather than widened here.
 */
export async function expectNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const documentWidth = document.documentElement.clientWidth
    const scrollWidth = document.documentElement.scrollWidth
    const bodyScrollWidth = document.body.scrollWidth
    const documentOverflows =
      scrollWidth > documentWidth + 1 || bodyScrollWidth > documentWidth + 1

    const main = document.getElementById('main-content')
    // 1px of tolerance for sub-pixel layout rounding. A real overflow is far
    // larger — the three measured so far were the #1768 mutation, #1772's
    // transactions table, and this helper's own mutation proof, all ~100px+.
    const contentOverflowBy = main ? main.scrollWidth - main.clientWidth : 0
    const contentOverflows = contentOverflowBy > 1

    return {
      documentWidth,
      scrollWidth,
      bodyScrollWidth,
      documentOverflows,
      contentRegionFound: Boolean(main),
      contentScrollWidth: main ? main.scrollWidth : null,
      contentClientWidth: main ? main.clientWidth : null,
      contentOverflowBy,
      contentOverflows,
      hasOverflow: documentOverflows || contentOverflows,
    }
  })
}
