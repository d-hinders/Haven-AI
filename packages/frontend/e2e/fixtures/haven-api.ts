import type { Page, Route } from '@playwright/test'
import { AUTH_TOKEN_STORAGE_KEY } from '../../src/lib/auth-storage'
import {
  ampersendDemoApi,
  ampersendOffers,
  bergetAi,
  havenDemoStore,
  havenDemoStoreOffers,
  marketplaceMerchants,
} from './marketplace'

export const testSafeAddress = '0x1111111111111111111111111111111111111111'
export const testRecipientAddress = '0x2222222222222222222222222222222222222222'

/**
 * The shared account — on the LIVE delegation rail (#2264, epic #1440).
 *
 * It carried no `account_type` at all until #2264, and `railOf` reads
 * anything-but-`delegator_hybrid` as the legacy Safe rail (the retired custody
 * page's rail helper, deleted with the page itself in #3024), so every spec
 * in this suite rendered the app as it looks for a **retired-rail** user.
 * `browser_smoke` and `design_visual` were
 * therefore pinning the pixel-and-DOM behaviour of a configuration that answers
 * HTTP 410 in production (#1986): green, and true about nobody.
 *
 * The default is now the live rail and the shared fixture carries NO opt-down:
 * #2264 made the legacy shape explicit, and #2459 deleted it — `legacySafe`
 * and the opt-down page helper built on it — once #2413 removed the last
 * caller and the list queries stopped serving legacy accounts altogether. A
 * spec that wants a retired-rail page today has nothing to opt down TO — the
 * state does not exist on the wire.
 *
 * The value is `'legacy_safe'` / `'delegator_hybrid'` and never `null` or
 * absent: migration `041_hybrid_accounts.ts` declared the column
 * `VARCHAR(32) NOT NULL DEFAULT 'safe'` with `CHECK (account_type IN
 * ('safe','delegator_hybrid'))`, so an absent value is not a state the
 * backend can serve (#2202). `085_account_type_legacy_safe.ts` (#2912) later
 * renamed the retired value to `'legacy_safe'` and tightened the CHECK to
 * `('legacy_safe','delegator_hybrid')` — the historical migration text above
 * is unchanged (migrations are immutable), but the value this fixture
 * exercises is the CURRENT one.
 */
export const testSafe = {
  id: 'safe-main',
  account_address: testSafeAddress,
  chain_id: 8453,
  name: 'Operations',
  is_default: true,
  account_type: 'delegator_hybrid',
  created_at: '2026-05-01T10:00:00.000Z',
}

export const testUser = {
  id: 'user-e2e',
  name: 'Ada Lovelace',
  email: 'ada@haven.test',
  wallet_address: null,
  account_address: testSafeAddress,
  accounts: [testSafe],
  currency_preference: 'USD',
  created_at: '2026-05-01T10:00:00.000Z',
}

/**
 * The SEK user (#3127, finding 8): the served DEFAULT, and the state every
 * new signup lands in (migration 091 made the column default 'SEK' and
 * migrated the inherited 'USD' rows to NULL). The shared `testUser` stays
 * 'USD' — every existing spec and baseline is pinned to its render — while
 * `serveSekUser` (below) overlays `/auth/me` with this row for the specs
 * that photograph the SEK render. Same id, account, token; ONLY the
 * currency preference differs, so the two sessions photograph the same
 * product at one setting.
 */
export const testUserSek = {
  ...testUser,
  currency_preference: 'SEK',
} as const

/**
 * The currency preference of the user this page's fixture session is serving
 * (#4166). The backend strikes serve-time amounts (`approxAmount`) in the
 * user's `currency_preference`, but the fixture pinned `approxCurrency:
 * 'SEK'` onto rows served to the `currency_preference: 'USD'` session — so
 * every USD page photographed rows in kr (the
 * `balance-freshness-account-detail-desktop.png` defect). The auth handlers
 * set this from the user they answer (`mockHavenApi` → `testUser`, the SEK
 * overlay → `testUserSek`), and the row builders below strike at serve time.
 * Set at fixture-registration time, which is per-page: Playwright workers run
 * tests sequentially, so the value never races.
 */
let servedCurrencyPreference: 'USD' | 'EUR' | 'SEK' = 'USD'

/**
 * The fixture's rate story (#3824): 1 USDC ≈ $1 (the USD peg — `totals.usd`
 * prices USDC at par), ≈ €0.92, ≈ 10.76 kr (the same story `totals.sek`
 * tells). Serve-time amounts are struck from the token amount with the
 * served user's rate.
 */
const FIXTURE_USDC_RATES: Record<'USD' | 'EUR' | 'SEK', number> = {
  USD: 1,
  EUR: 0.92,
  SEK: 10.76,
}

/**
 * A fixture row's serve-time fields (#3824), struck in the SERVED user's
 * currency (#4166) — the backend's documented behaviour the fixture used to
 * contradict. `usdcBase` is the token amount the row's story prices.
 */
function serveTimeApprox(usdcBase: number): {
  approxAmount: string
  approxCurrency: 'USD' | 'EUR' | 'SEK'
} {
  return {
    approxAmount: (usdcBase * FIXTURE_USDC_RATES[servedCurrencyPreference]).toFixed(4),
    approxCurrency: servedCurrencyPreference,
  }
}

/** `serveTimeApprox` for the agent-activity wire's snake_case row (#4166). */
function serveTimeApproxSnake(usdcBase: number): {
  approx_amount: string
  approx_currency: 'USD' | 'EUR' | 'SEK'
} {
  const strike = serveTimeApprox(usdcBase)
  return { approx_amount: strike.approxAmount, approx_currency: strike.approxCurrency }
}

/** Re-strike a camelCase row's serve-time fields in the served currency. */
function withServedApprox<T extends object>(
  row: T,
  usdcBase: number,
): T & { approxAmount: string; approxCurrency: 'USD' | 'EUR' | 'SEK' } {
  return { ...row, ...serveTimeApprox(usdcBase) }
}

export const testAgent = {
  id: 'agent-e2e',
  name: 'Research agent',
  description: 'Runs paid research with a fixed allowance.',
  delegate_address: '0x3333333333333333333333333333333333333333',
  account_id: testSafe.id,
  account_address: testSafeAddress,
  account_name: testSafe.name,
  account_chain_id: testSafe.chain_id,
  api_key_prefix: 'haven_e2e',
  status: 'active' as const,
  // #2264: the agent's rail marker. It is not an `agents` column — every
  // agent-row read selects it as `us.account_type` off the joined `user_safes`
  // row (`infra/repositories/agents.ts`), so it must agree with `testSafe`,
  // which this agent names via `account_id` — one account answers one value,
  // and since #2459 there is no opt-down shape left to disagree with.
  account_type: 'delegator_hybrid',
  created_at: '2026-05-02T10:00:00.000Z',
  // #3167: labels ride on every agent read. The e2e default agent carries
  // none — the label UI's own e2e coverage labels it explicitly.
  labels: [],
  // #3164: placement on the agents read. The default agent sits at the top
  // level, outside every organization.
  organization_id: null,
  // #3426: the owner's per-agent x402 tax declaration opt-in, default OFF —
  // the same fact the e2e default agent must carry (the fixture is
  // schema-checked against `ApiSchema<'Agent'>`, so the new required boolean
  // cannot be dropped silently here).
  tax_declaration_enabled: false,
  // #4429: the stored display colour (1..6), assigned by the database on
  // insert. DISPLAY ONLY — the fixture is schema-checked against
  // `ApiSchema<'Agent'>`, so the new required field cannot be dropped here.
  avatar_tint: 1,
  // #2264: the DERIVED delegation-budget projection, which is what fills this
  // array on the live rail (`rails/delegation-budget-view.ts`): 250 USDC per
  // 30 days, `allowance_amount` HUMAN-formatted and `reset_period_min` in
  // minutes. It used to be `'250000000'` — atomic units, the AllowanceModule
  // row shape — which `GET /agents` cannot emit for a `delegator_hybrid` agent
  // and, since #2020 retired the allowance read surface, cannot emit for a
  // legacy one either (`routes/agents.ts` returns `[]` there).
  allowances: [
    {
      // The derived row's `id` IS the delegation row's id
      // (`deriveDelegationBudgets` maps `row.id` straight through), so the two
      // must be the SAME literal — see the `/agents/:id/delegations` handler.
      id: 'delegation-e2e',
      agent_id: 'agent-e2e',
      token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      token_symbol: 'USDC',
      allowance_amount: '250.000000',
      reset_period_min: 43_200,
    },
  ],
  // #3988: the received-grant data rides on every Agent read now. The
  // Research agent holds an open grant from the Watcher agent (the same
  // direction the dashboard fixture states), but its OWN budget is positive,
  // so the card still renders its allowance rows — the received line only
  // takes over for a holder with no (or zero-capped) own budgets.
  receivedSubBudgets: [
    { parent_agent_id: 'agent-e2e-watcher', parent_agent_name: 'Watcher agent', open: true },
  ],
}

/**
 * #3988: a grant HOLDER — no budget of its own, an open received sub-budget
 * from the Research agent. The state the /agents card used to read "No
 * budget" for. Specs opt in by seeding it (`seedAgents`) or routing its id;
 * the shared `GET /agents` answer keeps returning only `testAgent`, so the
 * resting agent-panel captures stay untouched.
 */
export const grantHolderAgent = {
  ...testAgent,
  id: 'agent-e2e-grantholder',
  name: 'Grant holder agent',
  description: 'Spends through a budget another agent granted it.',
  allowances: [],
  receivedSubBudgets: [
    { parent_agent_id: testAgent.id, parent_agent_name: testAgent.name, open: true },
  ],
}

/**
 * #3988: the tree the fixture DELEGATOR issues to the grant holder — the
 * issuer-side "Sub-agent budgets" section of the same card, so both sides of
 * the table photograph. Returned ONLY for `subBudgetTreeAgent.id`; every
 * other agent keeps the empty `trees: []` the card renders nothing for.
 */
export const subBudgetTreeAgent = {
  ...testAgent,
  id: 'agent-e2e-delegator',
  name: 'Delegating agent',
}

export const subBudgetTreeFixture = [
  {
    parent_child_sub_budget: {
      id: 'tree-e2e-parent-child',
      agent_id: subBudgetTreeAgent.id,
      parent_agent_id: subBudgetTreeAgent.id,
      parent_sub_budget_id: null,
      chain_id: 84532,
      token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      recipient_address: null,
      parent_delegation_hash: `0x${'4d'.repeat(32)}`,
      delegation_hash: `0x${'51'.repeat(32)}`,
      label: null,
      period_amount_atomic: '100000000',
      status: 'open',
      expires_at: Math.floor(Date.UTC(2027, 4, 2) / 1000),
      is_expired: false,
      is_live: true,
      created_at: '2026-09-01T10:00:00.000Z',
      opened_at: '2026-09-01T10:00:00.000Z',
      closed_at: null,
      close_tx_hash: null,
    },
    grants: [
      {
        id: 'tree-e2e-grant',
        agent_id: grantHolderAgent.id,
        parent_agent_id: subBudgetTreeAgent.id,
        parent_sub_budget_id: 'tree-e2e-parent-child',
        chain_id: 84532,
        token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
        recipient_address: null,
        parent_delegation_hash: `0x${'51'.repeat(32)}`,
        delegation_hash: `0x${'52'.repeat(32)}`,
        label: null,
        period_amount_atomic: '25000000',
        status: 'open',
        expires_at: Math.floor(Date.UTC(2027, 4, 2) / 1000),
        is_expired: false,
        is_live: true,
        created_at: '2026-09-01T10:00:00.000Z',
        opened_at: '2026-09-01T10:00:00.000Z',
        closed_at: null,
        close_tx_hash: null,
      },
    ],
  },
]

/** #3988: the grants the fixture grant holder RECEIVES (`parent_agent_name` joined). */
export const receivedGrantsFixture = [
  {
    id: 'received-e2e-grant',
    agent_id: grantHolderAgent.id,
    parent_agent_id: testAgent.id,
    parent_agent_name: testAgent.name,
    parent_sub_budget_id: 'tree-e2e-parent-child',
    chain_id: 84532,
    token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    recipient_address: null,
    parent_delegation_hash: `0x${'51'.repeat(32)}`,
    delegation_hash: `0x${'53'.repeat(32)}`,
    label: null,
    period_amount_atomic: '25000000',
    status: 'open',
    expires_at: Math.floor(Date.UTC(2027, 4, 2) / 1000),
    is_expired: false,
    is_live: true,
    created_at: '2026-09-01T10:00:00.000Z',
    opened_at: '2026-09-01T10:00:00.000Z',
    closed_at: null,
    close_tx_hash: null,
  },
]

export const dashboardTransaction = {
  hash: `0x${'ab'.repeat(32)}`,
  // #3763: the two EIP-3009 legs, named. `hash` stays the FUNDING hash — the
  // transaction that left the account, which the drawer's footer links
  // (#4267); the recorded settlement — the transaction the MERCHANT names —
  // has its own "Settlement transaction" row under Technical details, and the
  // drawer's Details read "Settlement: Settled (verified)" (#4320), matched
  // by the sweep standard's derived payment nonce.
  fundingTxHash: `0x${'ab'.repeat(32)}`,
  settlementTxHash: `0x${'22'.repeat(32)}`,
  settlementScheme: 'eip3009' as const,
  settlementTracking: 'verified' as const,
  settlementProof: 'nonce' as const,
  type: 'erc20' as const,
  from: testSafeAddress,
  to: testRecipientAddress,
  value: '12500000',
  valueFormatted: '12.50',
  // #3824: the serve-time amount for a row without book-time fiat — struck
  // in the SERVED user's currency (#4166): the USD session this fixture
  // serves by default prices 12.50 USDC at par, the SEK overlay at the
  // fixture's ~10.76 kr/USD story (the same story `totals.sek` tells).
  // `convertedAmount` stays absent on this row: the two provenances never
  // ride together. The `/transactions` handler re-strikes per served user.
  approxAmount: '12.5000',
  approxCurrency: 'USD' as const,
  asset: 'USDC',
  decimals: 6,
  direction: 'out' as const,
  timestamp: 1_779_000_000,
  blockNumber: 12_345,
  isError: false,
  tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  tokenSymbol: 'USDC',
  agentId: testAgent.id,
  agentName: testAgent.name,
  chainId: 8453,
  accountId: testSafe.id,
  accountAddress: testSafeAddress,
  accountName: testSafe.name,
  source: 'x402',
  x402ResourceUrl: 'https://research.example/report',
  x402MerchantAddress: testRecipientAddress,
  // #2870: the payment-intent id the accounting badge is keyed on, and the
  // badge's own object. Carried on the row itself so the fixture-shape parity
  // test (`fixture-shape-parity.test.ts`) sees the same keys the screenshot
  // dataset has. Rendered only by `/transactions` (ledger row + drawer); the
  // dashboard's recent-transactions preview reads neither key, so its
  // baseline is unchanged.
  paymentId: 'pay-research-1',
  accounting: {
    provider: 'fortnox',
    status: 'pushed' as const,
    externalRef: 'fortnox:supplierinvoice:11',
    error: null,
  },
}

/**
 * #3763: the OTHER eip3009 state — a synthesized x402 payment with NO
 * recorded settlement. The drawer reads "Settlement: Not tracked" (#4320) —
 * no hash is recorded and no source can produce one — with what the record
 * proves (never a promise the merchant confirmed it, never "failed"), and
 * links the funding leg as the account's transaction (#4267). Served as the SECOND `/transactions` row so the
 * regenerated baselines photograph both states' rows; every other route that
 * serves `dashboardTransaction` alone is unchanged.
 */
export const x402UnrecordedSettlementTransaction = {
  hash: `0x${'cd'.repeat(32)}`,
  fundingTxHash: `0x${'cd'.repeat(32)}`,
  settlementTxHash: null,
  settlementScheme: 'eip3009' as const,
  settlementTracking: 'untracked' as const,
  settlementProof: null,
  type: 'erc20' as const,
  from: testSafeAddress,
  to: testRecipientAddress,
  value: '1000000',
  valueFormatted: '1.00',
  // #3824: serve-time amount, same rule and rate story as `dashboardTransaction`
  // — struck per served user (#4166); the const carries the USD strike.
  approxAmount: '1.0000',
  approxCurrency: 'USD' as const,
  asset: 'USDC',
  decimals: 6,
  direction: 'out' as const,
  timestamp: 1_778_900_000,
  // #3129: a synthesized x402 row never carries a block number — null, not 0.
  blockNumber: null,
  isError: false,
  tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  tokenSymbol: 'USDC',
  agentId: testAgent.id,
  agentName: testAgent.name,
  chainId: 8453,
  accountId: testSafe.id,
  accountAddress: testSafeAddress,
  accountName: testSafe.name,
  source: 'x402',
  x402ResourceUrl: 'https://api.example.dev/datasets',
  x402MerchantAddress: testRecipientAddress,
  paymentId: 'pay-research-2',
  confirmedAt: '2026-05-16T01:13:20.000Z',
  timestampSource: 'confirmed_at' as const,
  paymentProofStatus: 'payment_confirmed',
  paymentFlowStatus: 'confirming_merchant',
  paymentAttentionReason: null,
  initiatedBy: 'agent' as const,
}

/**
 * #4312: the states the shared feed never serves — a deposit, a delegate
 * sweep, a failed payment and a row on a chain the registry does not know —
 * plus the overlay that serves them. The detail-panel polish spec
 * (transactions-detail-polish.spec.ts) measures geometry A–E on panels the
 * default fixture cannot open; the overlay registers AFTER `mockHavenApi`
 * (later routes win) and replaces ONLY `GET /transactions`.
 */
export const depositTransaction = {
  hash: `0x${'bd'.repeat(32)}`,
  type: 'erc20' as const,
  // An unnamed outside sender: the one-line header case (kindLabel === title,
  // "Deposit"), which is what criterion A measures.
  from: '0x7777777777777777777777777777777777777777',
  to: testSafeAddress,
  value: '5000000',
  valueFormatted: '5.00',
  // Serve-time strike in the served session's currency (the #3824/#4166
  // convention); these rows are only served to the default USD session.
  approxAmount: '5.0000',
  approxCurrency: 'USD' as const,
  asset: 'USDC',
  decimals: 6,
  direction: 'in' as const,
  timestamp: 1_778_800_000,
  blockNumber: 42,
  isError: false,
  tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  tokenSymbol: 'USDC',
  chainId: 8453,
  accountId: testSafe.id,
  accountAddress: testSafeAddress,
  accountName: testSafe.name,
}

export const sweepTransaction = {
  hash: `0x${'71'.repeat(32)}`,
  type: 'erc20' as const,
  // The delegate's wallet is the source of a returned allowance.
  from: '0x3333333333333333333333333333333333333333',
  to: testSafeAddress,
  value: '2000000',
  valueFormatted: '2.00',
  approxAmount: '2.0000',
  approxCurrency: 'USD' as const,
  asset: 'USDC',
  decimals: 6,
  direction: 'in' as const,
  activityType: 'delegate_sweep' as const,
  agentName: 'Atlas',
  timestamp: 1_778_700_000,
  blockNumber: 41,
  isError: false,
  tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  tokenSymbol: 'USDC',
  chainId: 8453,
  accountId: testSafe.id,
  accountAddress: testSafeAddress,
  accountName: testSafe.name,
}

export const failedTransaction = {
  hash: `0x${'f0'.repeat(32)}`,
  type: 'erc20' as const,
  from: testSafeAddress,
  to: '0x8888888888888888888888888888888888888888',
  value: '500000',
  valueFormatted: '0.50',
  approxAmount: '0.5000',
  approxCurrency: 'USD' as const,
  asset: 'USDC',
  decimals: 6,
  direction: 'out' as const,
  // A recorded owner attempt that failed on-chain: the headline keeps its
  // sign ("-$0.50", #4312 F) in the danger tone, beside the Failed badge and
  // the on-chain callout.
  initiatedBy: 'human' as const,
  isError: true,
  timestamp: 1_778_600_000,
  blockNumber: 40,
  tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  tokenSymbol: 'USDC',
  chainId: 8453,
  accountId: testSafe.id,
  accountAddress: testSafeAddress,
  accountName: testSafe.name,
}

export const unknownChainTransaction = {
  hash: `0x${'97'.repeat(32)}`,
  type: 'erc20' as const,
  from: testSafeAddress,
  to: '0x8888888888888888888888888888888888888888',
  value: '2500000',
  valueFormatted: '2.50',
  approxAmount: '2.5000',
  approxCurrency: 'USD' as const,
  asset: 'USDC',
  decimals: 6,
  direction: 'out' as const,
  isError: false,
  timestamp: 1_778_500_000,
  blockNumber: 39,
  // 999999 is in no registry: every Technical details row keeps its copy
  // button and drops its explorer link (criterion D's unknown-chain panel).
  chainId: 999_999,
  accountId: testSafe.id,
  accountAddress: testSafeAddress,
  accountName: testSafe.name,
  paymentId: 'pay-unknown-chain-1',
  // A supplied value is only the fallback where the chain has no explorer;
  // null hides the footer outright for this panel.
  explorerUrl: null,
}

/**
 * Overlay `GET /transactions` with a bespoke row list (#4312). Register AFTER
 * `mockHavenApi` (later routes win); every other read falls through to the
 * shared fixture untouched.
 */
export async function serveTransactions(page: Page, transactions: unknown[]) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/transactions') {
      await route.fulfill({
        json: {
          transactions,
          total: transactions.length,
          offset: 0,
          limit: 25,
          hasMore: false,
          partialFailure: false,
          failedAccountIds: [],
          truncated: false,
        },
      })
      return
    }
    await route.fallback()
  })
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
    // #3127 (finding 8): the SEK figures the served default renders. The
    // dashboard reads `totals.sek ?? 0`; without this key a SEK user's
    // baseline photographed `0,00 kr`. ~10.76 SEK/USD, the same story the
    // USD/EUR pair tells (1250 → 1138 EUR).
    sek: 13450,
  },
  change: {
    available: true,
    usdAmount: 25,
    eurAmount: 23,
    usdPercent: 2.04,
    eurPercent: 2.01,
    // #3127 (finding 8): a real SEK swing, so the hero's change line renders
    // and the baseline photographs it. NOT the pre-migration-090 `null` —
    // that unavailable state has its own characterization coverage in
    // `DashboardClient.test.tsx`; the baseline here pins the ordinary
    // post-backfill render.
    sekAmount: 30,
    sekPercent: 0.2,
  },
  // #3807: the metrics block is gone with the four KPI tiles — the SEK
  // spend figure the old "Monthly agent spend" tile read now lives in
  // `spend.d30.net.sek` (the same #3803 net definition the analytics page
  // uses), and the visual spec pins it there.
  // #2120: 0, matching `routes/dashboard.ts:84`, which hardcodes both to 0 —
  // the approval queue died with the AllowanceModule rail and its table is
  // dropped (#2055). A seeded 1 fabricated a count no backend can emit. The
  // "no approvals affordance" absence assertions keep their teeth in
  // `DashboardClient.test.tsx`, which feeds the component a non-zero value
  // deliberately, as a labelled adversarial probe rather than a shared seed.
  actionableApprovals: 0,
  pendingApprovals: 0,
  onboardingProgress: {
    hasFirstAgentPayment: true,
  },
  // #3803: the agentCount tiles read this — every preview agent is counted,
  // by status, including the pending ones the old LIMIT 6 preview dropped.
  // #3809: the three listed agents are 1 active, 1 paused, 1 pending — the
  // total must agree with `agents` or the section's "View all N agents"
  // footer would promise an agent the list does not carry.
  agentCount: {
    active: 1,
    paused: 1,
    pending_approval: 1,
  },
  // #3803: TWO accounts (mainnet + testnet) so the account rows render both
  // the mainnet USDC balance story and a testnet pace story.
  accounts: [
    {
      accountId: testSafe.id,
      chainId: 8453,
      isTestnet: false,
      usdcBalanceAtomic: '1250000000',
      usdcDecimals: 6,
      usdcBalanceFreshness: { status: 'stale' as const, asOf: '2026-10-09T10:00:00.000Z' },
      funded: true,
      needs_backup_recommendation: false,
      usdcPace7dAtomic: '6250000',
    },
    {
      accountId: 'safe-sepolia',
      chainId: 84532,
      isTestnet: true,
      usdcBalanceAtomic: '50000000',
      usdcDecimals: 6,
      funded: true,
      needs_backup_recommendation: false,
      usdcPace7dAtomic: '1000000',
    },
  ],
  // #3803: today's rate per BUDGET token, in the viewer's preferred currency
  // (testUser is USD). Null means "the price read failed" — the client shows
  // the caption without a rate, never a fake 0.
  spotRates: { USDC: 1 },
  // #3803: the 7/30-day block. scope 'mainnet' because the user HAS a
  // mainnet account; d30 carries the larger triple so the two tiles differ.
  spend: {
    scope: 'mainnet' as const,
    d7: {
      gross: { usd: 18.5, eur: 16.84, sek: 199.1 },
      net: { usd: 11.1, eur: 10.1, sek: 119.46 },
      approx: false,
      payments: 6,
      distinctMerchants: 3,
      budgetStops: 1,
    },
    d30: {
      gross: { usd: 74.0, eur: 67.34, sek: 796.4 },
      net: { usd: 48.1, eur: 43.77, sek: 517.66 },
      approx: true,
      // #4165: what the server now sends for re-priced USDC — dollars in USD
      // (no ≈), converted in EUR and SEK.
      approxByCurrency: { usd: false, eur: true, sek: true },
      unpricedByCurrency: { usd: false, eur: false, sek: false },
      payments: 21,
      distinctMerchants: 5,
      budgetStops: 3,
    },
    topMerchant7d: {
      key: 'research.example',
      x402ResourceUrl: 'https://research.example/report',
      to: testRecipientAddress,
      merchantName: null,
    },
    failedIntents7d: 1,
    // #4324: the latest recorded step of any failed intent in the window (sent when there is one).
    lastFailedIntentAt: '2026-10-08T14:20:00.000Z',
    // 30 days, most recent last — days WITHOUT a snapshot are ABSENT from the
    // real wire; the harness generates a dense series so a gap never renders.
    balance_by_day: Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 8, 10 + i))
      return {
        snapshotDate: day.toISOString().slice(0, 10),
        totalUsd: 1225 + i * 1.25,
        totalEur: 1113.8 + i * 1.14,
        totalSek: i % 7 === 0 ? null : 13170 + i * 13.45,
      }
    }),
  },
  agents: [
    {
      id: testAgent.id,
      name: testAgent.name,
      status: testAgent.status,
      // #4429: the stored display colour (1..6). DISPLAY ONLY.
      avatarTint: 1,
      accountId: testSafe.id,
      accountName: testSafe.name,
      accountChainId: testSafe.chain_id, budgetEndedAt: null,
      // #2264: same derived projection as `testAgent.allowances`, in the
      // dashboard route's camelCase wire shape (`routes/dashboard.ts`).
      allowances: [
        {
          tokenSymbol: 'USDC',
          allowanceAmount: '250.000000',
          resetPeriodMin: 43_200,
        },
      ],
      // #3803: the full budget view beside the frozen mirror above —
      // identity, raw budget, and the LIVE window the client renders as
      // "resets in …". Two agents carry budgets with MIXED periods.
      // #3809: the windows are pinned to the VISUAL HARNESS's frozen clock
      // (FROZEN_NOW 2026-09-01T12:00Z in product-routes.visual.spec.ts) — a
      // live budget renders its meter "in each budget's own period", so the
      // dates must be around THAT instant, not the day the fixture was
      // written, or the baseline photographs not-started rows.
      budgets: [
        {
          id: '9d1f4c0a-0000-4000-8000-000000000001',
          delegationHash: `0x${'11'.repeat(32)}`,
          chainId: 8453,
          tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
          tokenSymbol: 'USDC',
          decimals: 6,
          budgetAtomic: '250000000',
          periodSeconds: 86_400,
          startDate: '2026-08-20T10:00:00.000Z',
          expiresAt: '2027-08-20T10:00:00.000Z',
          periodEnd: '2026-09-02T10:00:00.000Z',
        },
      ],
      receivedSubBudgets: [],
      stats: {
        d7: {
          gross: { usd: 12.5, eur: 11.38, sek: 134.5 },
          net: { usd: 7.5, eur: 6.83, sek: 80.7 },
          approx: false,
          payments: 4,
          // #4324: d7 carries the latest refusal time of each non-empty bucket.
          refusals: { budget: 1, expired: 0, scope: 0, failed: 0, haven: 0, lastBudgetAt: '2026-10-08T11:05:00.000Z' },
        },
        d30: {
          gross: { usd: 50.0, eur: 45.5, sek: 538.0 },
          net: { usd: 32.5, eur: 29.58, sek: 349.7 },
          approx: true,
          approxByCurrency: { usd: false, eur: true, sek: true },
          unpricedByCurrency: { usd: false, eur: false, sek: false },
          payments: 14,
          refusals: { budget: 2, expired: 0, scope: 1, failed: 1, haven: 0 },
        },
        lastPaymentAt: '2026-10-09T09:41:00.000Z',
        lastCounterparty: {
          source: 'x402',
          x402ResourceUrl: 'https://research.example/report',
          to: testRecipientAddress,
          merchantName: null,
        },
      },
    },
    {
      id: 'agent-e2e-watcher',
      name: 'Watcher agent',
      status: 'paused' as const,
      // #4429: the stored display colour (1..6). DISPLAY ONLY.
      avatarTint: 2,
      accountId: testSafe.id,
      accountName: testSafe.name,
      accountChainId: testSafe.chain_id, budgetEndedAt: null,
      allowances: [],
      budgets: [
        {
          id: '9d1f4c0a-0000-4000-8000-000000000002',
          delegationHash: `0x${'22'.repeat(32)}`,
          chainId: 8453,
          tokenAddress: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
          tokenSymbol: 'USDC',
          decimals: 6,
          budgetAtomic: '50000000',
          // Mixed periods: a WEEKLY budget beside the daily one above.
          // #3809: window dates pinned around the frozen clock (see above).
          periodSeconds: 604_800,
          startDate: '2026-08-27T10:00:00.000Z',
          expiresAt: '2027-08-27T10:00:00.000Z',
          periodEnd: '2026-09-03T10:00:00.000Z',
        },
      ],
      receivedSubBudgets: [
        { parentAgentId: testAgent.id, parentAgentName: testAgent.name, open: true },
      ],
      stats: {
        d7: {
          gross: { usd: 6.0, eur: 5.46, sek: 64.6 },
          net: { usd: 3.6, eur: 3.28, sek: 38.76 },
          approx: false,
          payments: 2,
          refusals: {
            budget: 0,
            expired: 0,
            scope: 0,
            failed: 1,
            haven: 1,
            lastFailedAt: '2026-10-07T16:40:00.000Z',
            lastHavenAt: '2026-10-07T17:15:00.000Z',
          },
        },
        d30: {
          gross: { usd: 24.0, eur: 21.84, sek: 258.4 },
          net: { usd: 15.6, eur: 14.2, sek: 167.96 },
          approx: false,
          payments: 7,
          refusals: { budget: 1, expired: 0, scope: 0, failed: 1, haven: 2 },
        },
        lastPaymentAt: '2026-10-07T18:02:00.000Z',
        lastCounterparty: {
          source: 'api',
          x402ResourceUrl: null,
          to: testRecipientAddress,
          merchantName: 'Example Shop AB',
        },
      },
    },
    {
      // #3803: a pending agent — carries NO budgets (nothing delegated yet)
      // but DOES carry its connection setup status, so the client can offer
      // "Finish setup" instead of a bare spinner.
      id: 'agent-e2e-pending',
      name: 'Connecting agent',
      status: 'pending_approval' as const,
      // #4429: the stored display colour (1..6). DISPLAY ONLY.
      avatarTint: 3,
      accountId: 'safe-sepolia',
      accountName: 'Showcase account',
      accountChainId: 84532, budgetEndedAt: null,
      setupStatus: 'awaiting_connection',
      allowances: [],
      budgets: [],
      receivedSubBudgets: [],
      stats: {
        d7: {
          gross: { usd: 0, eur: 0, sek: 0 },
          net: { usd: 0, eur: 0, sek: 0 },
          approx: false,
          payments: 0,
          refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 },
        },
        d30: {
          gross: { usd: 0, eur: 0, sek: 0 },
          net: { usd: 0, eur: 0, sek: 0 },
          approx: false,
          payments: 0,
          refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 },
        },
        lastPaymentAt: null,
        lastCounterparty: null,
      },
    },
  ],
  // #3858: the former 5-row `transactions` preview is gone from the wire —
  // the dashboard reads the grouped-activity rows below.
  // #3824: the grouped-activity rows the redesigned dashboard renders. One
  // group: the fixture's one confirmed x402 payment, keyed agent + token +
  // merchant + local day + outcome. approx (serve-time) rather than
  // converted (book-time) — the row has no book-time fiat. `latestAt` is the
  // row's timestamp (1_779_000_000) as ISO 8601.
  activity: [
    {
      count: 1,
      sumAtomic: '12500000',
      tokenSymbol: 'USDC',
      decimals: 6,
      latestAt: new Date(1_779_000_000 * 1000).toISOString(),
      agentId: testAgent.id,
      agentName: testAgent.name,
      source: 'x402',
      x402ResourceUrl: 'https://research.example/report',
      to: testRecipientAddress,
      merchantName: null,
      activityType: null,
      direction: 'out' as const,
      status: 'confirmed' as const,
      // #3824: the serve-time strike, per served user (#4166) — the handler
      // re-strikes; the const carries the USD session's figures.
      approxAmount: '12.5000',
      approxCurrency: 'USD' as const,
    },
  ],
  // #3944: the two empty-state facts. The fixture renders activity rows, so
  // `hasOlderActivity` is false; `activityWindowDays` mirrors the backend's
  // ACTIVITY_WINDOW_DAYS. `activityWindowStart` (#3975) is the rolling
  // window's start instant — 7×24h before the row's timestamp, so the rows
  // sit inside it and no heading reads partial.
  hasOlderActivity: false,
  activityWindowDays: 7,
  activityWindowStart: new Date((1_779_000_000 - 7 * 86_400) * 1000).toISOString(),
}

/**
 * `GET /dashboard/budget-remaining` (#3804) — the cached, display-only
 * budget-remaining read. THREE rows: two KNOWN (fromChain, amounts
 * populated, a sub-budget attribution line) wired to the overview fixture's
 * OWN delegation hashes (#3809 — the agents section meters the overview's
 * budgets through these reads, so the harness photographs a real meter on
 * both budgeted agents: the daily one at 92%, the weekly paused one at 40%)
 * and one UNKNOWN (`remaining_from_chain: false`, `remaining_atomic`/
 * `used_atomic`/`read_at` null — never "0 left", never the full budget).
 * Read/period instants sit around the visual harness's frozen clock
 * (2026-09-01T12:00Z). The screenshot harness and any spec seeding the
 * dashboard spread this same shape.
 */
export const dashboardBudgetRemaining = {
  budgets: [
    {
      agent_id: testAgent.id,
      chain_id: 8453,
      delegation_hash: `0x${'11'.repeat(32)}`,
      token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      token_symbol: 'USDC',
      token_decimals: 6,
      budget_atomic: '250000000',
      read_at: '2026-09-01T11:00:00.000Z',
      period_end: '2026-09-02T10:00:00.000Z',
      remaining_atomic: '20000000',
      remaining_from_chain: true,
      used_atomic: '230000000',
      sub_budget_spend: [
        { agent_id: '33333333-3333-4333-8333-333333333333', spent_atomic: '250000' },
      ],
    },
    {
      agent_id: 'agent-e2e-watcher',
      chain_id: 8453,
      delegation_hash: `0x${'22'.repeat(32)}`,
      token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      token_symbol: 'USDC',
      token_decimals: 6,
      budget_atomic: '50000000',
      read_at: '2026-09-01T11:00:00.000Z',
      period_end: '2026-09-03T10:00:00.000Z',
      remaining_atomic: '30000000',
      remaining_from_chain: true,
      used_atomic: '20000000',
      sub_budget_spend: [],
    },
    {
      agent_id: '44444444-4444-4444-8444-444444444444',
      chain_id: 84532,
      delegation_hash: `0x${'d'.repeat(64)}`,
      token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      token_symbol: 'USDC',
      token_decimals: 6,
      budget_atomic: '2000000',
      read_at: null,
      period_end: '2026-10-10T00:00:00.000Z',
      remaining_atomic: null,
      remaining_from_chain: false,
      used_atomic: null,
      sub_budget_spend: [],
    },
  ],
}

/**
 * Accounting connections (#2868, backend #2862–#2867). `GET
 * /accounting/providers` lists Fortnox live and the three coming-soon
 * providers; the connection row is exported so a spec can seed any of the
 * five states with a spread (`{ ...accountingConnection, status: '…' }`).
 * The screenshot harness carries the same shapes — `fixture-shape-parity`
 * holds the two together.
 */
export const accountingProvider = {
  id: 'fortnox',
  displayName: 'Fortnox',
  authKind: 'oauth2' as const,
  capabilities: { attachments: true, verify: true, revoke: true, companyInfo: true },
  availability: 'live' as const,
  requiredScopes: ['bookkeeping', 'companyinformation', 'archive'],
  configured: true,
}

export const accountingProviders = [
  accountingProvider,
  // #3017: Accounted is live over a pasted API key — the registry's real shape.
  {
    ...accountingProvider,
    id: 'accounted',
    displayName: 'Accounted',
    authKind: 'api_key' as const,
    capabilities: { attachments: false, verify: false, revoke: false, companyInfo: true },
    availability: 'live' as const,
    requiredScopes: [],
    configured: true,
  },
  ...['Light', 'Igdrasil'].map((displayName) => ({
    ...accountingProvider,
    id: displayName.toLowerCase(),
    displayName,
    capabilities: { attachments: false, verify: false, revoke: false, companyInfo: false },
    availability: 'coming_soon' as const,
    requiredScopes: [],
    configured: false,
  })),
]

export const accountingConnection = {
  provider: 'fortnox',
  displayName: 'Fortnox',
  authKind: 'oauth2' as const,
  status: 'connected' as const,
  statusReason: null,
  isActiveDestination: true,
  feedFrom: '2026-05-01T10:00:00.000Z',
  grantedScope: 'bookkeeping companyinformation archive',
  missingScopes: [] as string[],
  tokenExpiresAt: '2026-05-01T11:00:00.000Z',
  externalCompanyId: '1234567',
  externalCompanyName: 'Ada Lovelace AB',
  baseCurrency: 'SEK',
  lastPushAt: '2026-05-02T09:15:00.000Z',
  lastError: null,
  connectedAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T09:15:00.000Z',
  settings: { suggestedAccount: '6540', autoFeed: true },
}

/**
 * `GET /accounting/feed/status` (#2903 review): the `/accounting` feed page
 * renders NOTHING unless `hosted && flagEnabled`, so a harness without this
 * answer has no evidence of that page at all. Ready, entitled, connected to
 * the company above, with one pushed row and one retryable failure so both
 * chips render. The screenshot harness carries the same shape —
 * `fixture-shape-parity` holds the two together.
 */
export const accountingFeedSync = {
  id: '9d1f4c0a-6b2e-4f3a-9c8d-1e2f3a4b5c6d',
  user_id: '11111111-1111-4111-8111-111111111111',
  provider: 'fortnox',
  payment_id: 'pay_01HZX8KQ4M2N3P5R7T9V1W3Y5A',
  external_ref: 'fortnox:supplierinvoice:1042',
  status: 'pushed' as const,
  error: null as string | null,
  attempts: 1,
  created_at: '2026-05-02T09:15:00.000Z',
  updated_at: '2026-05-02T09:15:00.000Z',
}

export const accountingFeedStatus = {
  hosted: true,
  // #2869: `enabled` is the flag's name on the wire; `flagEnabled` is the
  // same boolean under the older name, and both are in the spec's `required`.
  enabled: true,
  flagEnabled: true,
  liveSyncReady: true,
  entitled: true,
  entitlementMode: 'all' as const,
  available: true,
  connected: true,
  companyName: accountingConnection.externalCompanyName as string | null,
  // #2869: the destination row the summary line and the sidebar badge read.
  destination: {
    provider: accountingConnection.provider,
    displayName: accountingConnection.displayName,
    status: accountingConnection.status as
      | 'connected' | 'needs_reauthorisation' | 'revoked_at_provider' | 'scope_missing' | 'disconnected',
    companyName: accountingConnection.externalCompanyName as string | null,
    lastPushAt: accountingConnection.lastPushAt as string | null,
  } as Record<string, unknown> | null,
  missingScopes: [] as string[],
  syncs: [
    accountingFeedSync,
    {
      ...accountingFeedSync,
      id: '2a7c9e1b-3d5f-4a6c-8e0b-2f4d6a8c0e1f',
      payment_id: 'pay_01HZX8M0R6S8U0W2Y4A6C8E0G2',
      external_ref: null,
      status: 'failed' as const,
      error: 'Fortnox answered 503 — will retry',
      attempts: 2,
      created_at: '2026-05-03T11:00:00.000Z',
      updated_at: '2026-05-03T11:05:00.000Z',
    },
  ],
  counts: { pending: 0, failed: 1, exhausted: 0 },
}

/**
 * The two OFF states of the feed (#2869), as spreads off the ready answer
 * above — `hosted && !enabled` is Coming soon, `!hosted` is "not available
 * on self-hosted", and the dashboard must never show one for the other.
 */
export const accountingFeedComingSoon = {
  ...accountingFeedStatus,
  enabled: false,
  flagEnabled: false,
  liveSyncReady: false,
  entitled: false,
  available: false,
  connected: false,
  companyName: null,
  destination: null,
  syncs: [] as typeof accountingFeedStatus.syncs,
  counts: { pending: 0, failed: 0, exhausted: 0 },
}

export const accountingFeedSelfHosted = { ...accountingFeedComingSoon, hosted: false }

/**
 * The ATTENTION state (#2869 design review): the destination's sign-in has
 * expired — still the destination, cannot push — and the retry sweep has
 * given up on three rows (`counts.exhausted`, #2866). This is what raises
 * the attention summary on `/accounting`, the inline "Stopped retrying"
 * explanation, and the sidebar dot. `connected` is false: it means an active
 * `connected` destination, which a dead grant is not.
 */
export const accountingFeedAttention = {
  ...accountingFeedStatus,
  connected: false,
  companyName: null,
  destination: {
    ...(accountingFeedStatus.destination as Record<string, unknown>),
    status: 'needs_reauthorisation' as const,
    companyName: null,
    lastPushAt: null,
  } as Record<string, unknown> | null,
  counts: { pending: 0, failed: 1, exhausted: 3 },
}

type JsonValue = Record<string, unknown> | unknown[] | null

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
      servedCurrencyPreference = testUser.currency_preference as 'USD' | 'EUR' | 'SEK'
      await fulfillJson(route, { token: 'e2e-token', user: testUser })
      return
    }

    if (method === 'POST' && path === '/auth/signup') {
      servedCurrencyPreference = testUser.currency_preference as 'USD' | 'EUR' | 'SEK'
      await fulfillJson(route, { token: 'e2e-token', user: testUser })
      return
    }

    if (method === 'GET' && path === '/auth/me') {
      servedCurrencyPreference = testUser.currency_preference as 'USD' | 'EUR' | 'SEK'
      await fulfillJson(route, testUser)
      return
    }

    if (method === 'GET' && path === '/passkeys') {
      await fulfillJson(route, { passkeys: [] })
      return
    }

    if (method === 'GET' && path === '/dashboard/overview') {
      await fulfillJson(route, {
        ...dashboardOverview,
        // #4166: the grouped-activity rows' serve-time strike follows the
        // served user's currency, like every other approx-valued row.
        activity: dashboardOverview.activity.map((group) => withServedApprox(group, 12.5)),
      })
      return
    }

    // #3808: `DashboardClient` mounts `useBudgetRemaining`, which reads
    // `GET /dashboard/budget-remaining` on every dashboard render. The
    // #3804 fixture default is the same two-row shape the API serves (one
    // KNOWN row, one UNKNOWN row) — without a handler here the read falls
    // through to `fulfillUnmockedRoute` → 599 and `unexpectedBrowserErrors`
    // fails every dashboard-rendering spec.
    if (method === 'GET' && path === '/dashboard/budget-remaining') {
      await fulfillJson(route, dashboardBudgetRemaining)
      return
    }

    // #3813: `DashboardClient` mounts `useAttentionDismissals`, which reads
    // `GET /user/attention-dismissals` on every dashboard render. The e2e
    // default session holds no dismissals, so every "Needs attention" item renders
    // exactly as the baselines captured it; specs that need a dismissed
    // item seed this route explicitly. The write is accepted and echoed in
    // the stored shape (never re-read in the same fixture run).
    if (method === 'GET' && path === '/user/attention-dismissals') {
      await fulfillJson(route, { dismissals: [] })
      return
    }
    if (method === 'POST' && path === '/user/attention-dismissals') {
      const body = route.request().postDataJSON() as {
        item_kind: string
        account_id?: string
        agent_id?: string
        period_end?: string
      }
      // #4324: the stored shape carries the acknowledgement time, and the
      // firing budget's period end on a `budget-usage` row.
      await fulfillJson(route, {
        id: '00000000-0000-4000-8000-000000000000',
        item_kind: body.item_kind,
        account_id: body.account_id ?? null,
        agent_id: body.agent_id ?? null,
        created_at: '2026-10-09T00:00:00.000Z',
        acknowledged_at: '2026-10-09T00:00:00.000Z',
        acknowledged_period_end: body.period_end ?? null,
      })
      return
    }

    if (method === 'GET' && path === '/agents') {
      await fulfillJson(route, { agents: [testAgent] })
      return
    }

    // #3164: the org tree read behind the /agents panel. The e2e default
    // session holds no organizations, so the tree does not render and the
    // committed resting-state baselines stay valid; specs that seed orgs
    // route this explicitly.
    if (method === 'GET' && path === '/organizations') {
      await fulfillJson(route, { organizations: [] })
      return
    }

    // #3079: the marketplace grid and merchant page.
    if (method === 'GET' && path === '/merchants') {
      await fulfillJson(route, { merchants: marketplaceMerchants })
      return
    }
    if (method === 'GET' && path === `/merchants/${ampersendDemoApi.slug}`) {
      await fulfillJson(route, { merchant: ampersendDemoApi, offers: ampersendOffers })
      return
    }
    if (method === 'GET' && path === `/merchants/${havenDemoStore.slug}`) {
      await fulfillJson(route, { merchant: havenDemoStore, offers: havenDemoStoreOffers })
      return
    }
    if (method === 'GET' && path === `/merchants/${bergetAi.slug}`) {
      await fulfillJson(route, { merchant: bergetAi, offers: [] })
      return
    }
    // #3331: the owner's merchant-locked budgets for a merchant page. Empty by
    // default — without this the catch-all below 404s it and every merchant
    // page renders the budgets-read error row.
    if (method === 'GET' && /^\/merchants\/[^/]+\/budgets$/.test(path)) {
      await fulfillJson(route, { budgets: [] })
      return
    }
    if (method === 'GET' && path.startsWith('/merchants/')) {
      await fulfillJson(route, { error: 'Merchant not found' }, 404)
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
          'I approve running this exact Haven connector command. It may download and execute the published npm package @haven_ai/connect@alpha, connect to Haven at https://api.haven.example, write local Haven credential files under ~/.haven, and update the local agent MCP config when supported.',
          '',
          'Run this exact command:',
          '',
          'npx -y @haven_ai/connect@alpha --setup hv_setup_e2e123 --api https://api.haven.example --ack-local-tools --runtime claude-code',
          '',
          'Network access is expected: this command downloads the npm package and contacts the Haven API, so if your environment is sandboxed, run it with network access enabled or request network access escalation; that changes the execution environment, not the command, and is not a command modification.',
          '',
          'Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.',
          '',
          'The Haven connector generates the signing key locally and sends Haven only the public signing address plus proof.',
          '',
          'If you are an AI agent running this command yourself rather than a human pasting it, you should append --json: the connector then emits one machine-readable, secret-free result object on stdout with progress on stderr, and returns promptly instead of blocking while it waits for the budget approval.',
          "When a --json outcome reports approval.required: true, your first action must be to relay the approval instruction to me in your own reply — if the outcome carries approval.url, give me that link; otherwise tell me to return to Haven and approve this agent's budget — before verifying the connection, restarting anything, or any other step. Never build that link yourself: relay the one the outcome gave you or none at all. Any restart the outcome asks for is a separate instruction to give me afterwards, once the approval is done.",
          'If the connector refuses with wiring_collision, this machine is already wired to a different agent: relay that refusal to me with the superseded_agent_ids and suggested_name it carries, and let me choose whether to replace the existing wiring or add this agent alongside it. Never pick for me by adding --replace or --name yourself.',
          'Only three changes to the command above are permitted, and no others: appending --json; re-running it once with --runtime <name> added, only if the connector refuses because it could not determine the agent runtime, naming the harness you are running in and using one of the values that refusal lists; and re-running it once with the one flag I chose added, only after I have answered a wiring_collision relay — --name <the suggested_name or a name I gave> to add alongside, or --replace to replace — keeping any change already made. If that re-run is refused too, relay the refusal to me and stop. Never invent a runtime name and never change anything else.',
          '',
          // #2486: kept line-for-line equal to the backend's `buildSetupPrompt`
          // by a parity test in packages/backend/src/routes/__tests__/
          // agent-connection-setups.test.ts — edit the backend first.
          "If you ran the command without --json, the connector waits for the approval itself and prints its next steps when it finishes: relay the budget-approval instruction to me — the approval link if those steps printed one, otherwise that you need to return to Haven and approve this agent's budget — only if those printed next steps still ask for it. If they report the budget as already approved, there is nothing for me to approve.",
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
        // #2120: `approval.status` is `agent_connection_setups.approval_status`,
        // which the backend only ever writes as 'not_started' | 'submitted' |
        // 'proposed' | 'confirmed'. 'pending_approval' is the AGENT status and
        // was never a value of this field.
        approval: { status: 'not_started', safe_tx_hash: null, tx_hash: null },
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
        // #3127 (finding 8): the portfolio hook reads `totalSek ?? 0`, and
        // /accounts + /accounts/[id] price their cards from it under the
        // served default. One token worth the whole portfolio, so the row's
        // `sekValue` IS the total — the same identity the USD/EUR pair has.
        totalSek: 13450,
        breakdown: [
          {
            symbol: 'USDC',
            balance: '1250000000',
            formatted: '1250',
            usdValue: 1250,
            eurValue: 1138,
            sekValue: 13450,
          },
        ],
        // #4021: the card footer's "Last payment {relative}". Pinned to
        // `testSafe.created_at` so the frozen clock produces the same
        // "4mo ago" the old caption did — a capture must not drift on a
        // calendar boundary.
        lastOutgoingAt: '2026-05-01T10:00:00.000Z',
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
        accounts: [
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
    // #3763: two rows, one per eip3009 settlement state (recorded on the
    // first, not recorded on the second) so the regenerated baselines carry
    // visible changes for both.
    if (method === 'GET' && path === '/transactions') {
      await fulfillJson(route, {
        // #4166: the serve-time strike follows the served user's currency.
        transactions: [
          withServedApprox(dashboardTransaction, 12.5),
          withServedApprox(x402UnrecordedSettlementTransaction, 1),
        ],
        total: 2,
        offset: 0,
        limit: 25,
        hasMore: false,
        partialFailure: false,
        failedAccountIds: [],
        // Required since #2882. `false` is the honest default here: the
        // fixture serves one transaction, well inside the explorer window.
        truncated: false,
      })
      return
    }

    if (method === 'GET' && path.startsWith('/transactions/')) {
      await fulfillJson(route, {
        // #4166: the serve-time strike follows the served user's currency.
        transactions: [withServedApprox(dashboardTransaction, 12.5)],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      })
      return
    }

    // #2264: the delegation rail's own per-agent reads, reached for the first
    // time when the shared account stopped being a legacy Safe.
    //
    // `GET /agents/:id/delegations` is the agent's real spend authority — the
    // rows `rails/delegation-budget-view.ts` projects into `agent.allowances`.
    // `testAgent` gets the delegation its projection describes (250 USDC per
    // 30 days), so the two cannot disagree; any OTHER agent id is one the
    // connect flow just created, which by construction has no delegation until
    // the budget is granted, so it gets an empty list rather than a 599.
    // #3329: the budget card reads the agent's open task budgets next to its
    // delegations (`useTaskBudgets`). No fixture agent has opened one, so every
    // agent gets the empty list the API returns in that state — the card
    // renders unchanged, and the read is no longer an "Unmocked API route"
    // that `unexpectedBrowserErrors` fails the mobile agent-detail spec on.
    if (method === 'GET' && path.startsWith('/agents/') && path.endsWith('/task-budgets')) {
      await fulfillJson(route, { task_budgets: [] })
      return
    }
    // #3330/#3988: the budget card reads the sub-budget trees the agent ISSUES
    // (`useSubBudgetTrees`) AND the grants the agent RECEIVES
    // (`useReceivedSubBudgets`). The DELEGATING fixture agent gets its real
    // tree so the issuer side of the card photographs; the grant holder gets
    // its received list; every other agent gets the empty answers the card
    // renders nothing for — the reads are no longer an "Unmocked API route"
    // that `unexpectedBrowserErrors` fails the mobile agent-detail spec on.
    if (method === 'GET' && path.startsWith('/agents/') && path.endsWith('/sub-budgets/tree')) {
      const issuerId = path.split('/')[2]
      await fulfillJson(route, {
        trees: issuerId === subBudgetTreeAgent.id ? subBudgetTreeFixture : [],
      })
      return
    }
    if (method === 'GET' && path.startsWith('/agents/') && path.endsWith('/sub-budgets/received')) {
      const holderId = path.split('/')[2]
      await fulfillJson(route, {
        agent_id: holderId,
        received: holderId === grantHolderAgent.id ? receivedGrantsFixture : [],
      })
      return
    }
    if (method === 'GET' && path.startsWith('/agents/') && path.endsWith('/delegations')) {
      // #3693 (corrected body): the remaining-this-period fields travel ONLY
      // when the caller asks (?include=remaining) — fixture parity with the
      // route's opt-in contract.
      const includeRemaining = url.searchParams.get('include') === 'remaining'
      const forTestAgent = path === `/agents/${testAgent.id}/delegations`
      const rows = forTestAgent
        ? [
            {
              id: 'delegation-e2e',
              chain_id: testSafe.chain_id,
              token_address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
              recipient_address: null,
              delegation_hash: `0x${'4d'.repeat(32)}`,
              version: 1,
              status: 'active',
              // #3922: the server's budget-view liveness (active, unexpired).
              is_live: true,
              budget_atomic: '250000000',
              period_seconds: 43_200 * 60,
              // #3806: the wire carries `start_date` as a Unix-seconds digit
              // string (the driver decodes the BIGINT), never ISO.
              start_date: '1777716000',
              expires_at: Math.floor(Date.UTC(2027, 4, 2) / 1000),
              created_at: '2026-05-02T10:00:00.000Z',
            },
          ]
        : []
      await fulfillJson(route, {
        delegations: includeRemaining
          ? rows.map((r) => ({
              ...r,
              // The fixture's single row is active: a mid-period read with the
              // budget mostly intact, refilling one period after start_date.
              ...(r.status === 'active'
                ? { remaining_atomic: '187500000', remaining_from_chain: true, period_end: new Date(Number(r.start_date) * 1000 + r.period_seconds * 1000).toISOString() }
                : { remaining_atomic: null, remaining_from_chain: null, period_end: null }),
            }))
          : rows,
      })
      return
    }

    // The agent-scoped twin of the account signer set (#888). Same account, so
    // the same answer as `/accounts/hybrid/:address/signers` below — a device
    // that can sign here can sign there.
    if (method === 'GET' && path.startsWith('/agents/') && path.endsWith('/account-signers')) {
      await fulfillJson(route, {
        account_address: testSafeAddress,
        chain_id: testSafe.chain_id,
        owner_address: null,
        passkeys: [
          {
            key_id: `0x${'11'.repeat(32)}`,
            x: '0x1',
            y: '0x2',
            created_at: '2026-05-01T10:00:00.000Z',
          },
        ],
      })
      return
    }

    // #2264: the delegation rail's OWN signer-set read. The shared fixture had
    // no handler for it, because until #2264 every spec rendered as a legacy
    // Safe user and nothing on that rail calls it — so `browser_smoke` reached
    // this route for the first time when the default flipped, and got the 599
    // "Unmocked API route" that `unexpectedBrowserErrors` correctly failed on
    // in 17 tests. One passkey and no EOA owner: the pure-passkey account
    // epic #836 made the ordinary shape, and the state `useAccountSigners`
    // needs before any signing path is offered.
    if (
      method === 'GET' &&
      path.startsWith('/accounts/hybrid/') &&
      path.endsWith('/signers')
    ) {
      await fulfillJson(route, {
        account_address: testSafeAddress,
        chain_id: testSafe.chain_id,
        owner_address: null,
        passkeys: [
          {
            key_id: `0x${'11'.repeat(32)}`,
            x: '0x1',
            y: '0x2',
            created_at: '2026-05-01T10:00:00.000Z',
          },
        ],
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

    // No `/approvals` handler: #1989 deleted the route and #2055 deregistered
    // the backend endpoint. A mock for a dead endpoint intercepts nothing and
    // reads as coverage of a flow that cannot happen (#1993).

    if (method === 'GET' && path === '/accounting/providers') {
      await fulfillJson(route, { providers: accountingProviders })
      return
    }

    if (method === 'GET' && path === '/accounting/connections') {
      await fulfillJson(route, { connections: [accountingConnection] })
      return
    }

    if (method === 'GET' && path === '/accounting/feed/status') {
      await fulfillJson(route, accountingFeedStatus)
      return
    }

    // #3332: 404 is the DEFAULT (feature off) — the same status a real
    // deployment answers with `HAVEN_OWNER_COMPANY_DETAILS` unset. A spec
    // that needs the flag "on" (empty or filled) overrides this route
    // itself, same convention as every other fixture override in this file.
    if (method === 'GET' && path === '/user/company-details') {
      await fulfillJson(route, { error: 'Not found' }, 404)
      return
    }

    // #3825: Settings → Signers lists the user's signers once each. Same
    // account and same single passkey as `/accounts/hybrid/:address/signers`
    // and the agent-scoped twin above, so every read of "who can approve" tells
    // one story; no browser wallet, because the fixture account has no EOA
    // owner. Without this answer `/settings` hits the 599 unmocked-route gate.
    if (method === 'GET' && path === '/user/signers') {
      await fulfillJson(route, {
        signers: [
          {
            kind: 'passkey',
            key_id: `0x${'11'.repeat(32)}`,
            created_at: '2026-05-01T10:00:00.000Z',
            accounts: [
              {
                account_id: testSafe.id,
                account_address: testSafeAddress,
                account_name: testSafe.name,
                chain_id: testSafe.chain_id,
              },
            ],
          },
        ],
      })
      return
    }

    if (method === 'GET' && path === '/user/owners') {
      await fulfillJson(route, {
        owners: [],
        partialFailure: false,
        failedAccountIds: [],
      })
      return
    }

    await fulfillUnmockedRoute(route, method, path)
  })
}

/**
 * Overlay `/auth/me` (and only it) with the SEK user (#3127, finding 8).
 *
 * The fixture's login/signup handlers always answer `testUser`
 * (`currency_preference: 'USD'`), so every existing spec and baseline
 * photographs the USD render. SEK is the SERVED DEFAULT (migration 091), and
 * nothing rendered it — the green visual-regression and browser-smoke ticks
 * were statements about the unchanged USD session. Registering this AFTER
 * `mockHavenApi` (later routes win) answers `GET /auth/me` with
 * `testUserSek` — same id, same account, only the currency preference
 * differs — so a spec can photograph the SEK render of the same product.
 * Everything else falls through to the shared fixture untouched.
 */
export async function serveSekUser(page: Page) {
  // #4166: the SEK session's rows are struck in SEK — the served user's
  // preference, per the auth answer below.
  servedCurrencyPreference = testUserSek.currency_preference
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/auth/me') {
      servedCurrencyPreference = testUserSek.currency_preference
      await fulfillJson(route, testUserSek)
      return
    }
    await route.fallback()
  })
}

/**
 * Overlay `/auth/me` (and only it) with the re-chained account (#3483, #4094).
 *
 * The Receive dialog's layout is a function of the SELECTED ACCOUNT's chain
 * (`ReceiveDialog.tsx`, the #3478 gate carried over: faucet on a testnet
 * account, onramp on a mainnet one), but the shared `testSafe` is pinned to
 * 8453 for every other
 * spec and baseline — so a spec that needs a different chain overlays
 * `/auth/me` with a one-field-splice of it rather than mutating the shared
 * object. The dashboard reads only `/auth/me` for the account list
 * (`DashboardClient.tsx` → `user?.accounts`), yet BOTH safe-serving shapes
 * stay consistent by construction: this derives from `testSafe` itself, so
 * `/user/safes` cannot disagree about whether the account HAS a chain (the
 * trap `add-funds-unresolved-chain` documents in `scripts/screenshot.mjs`).
 *
 * `chainId` may be `undefined`, which serves the account WITHOUT `chain_id` —
 * the unresolved-chain state (the refusal copy, no network named). Register
 * AFTER `mockHavenApi` (later-registered routes win); everything else falls
 * through to the shared fixture untouched.
 */
export async function serveAddFundsAccount(page: Page, chainId?: number) {
  const account = chainId === undefined ? { ...testSafe, chain_id: undefined } : { ...testSafe, chain_id: chainId }
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/auth/me') {
      await fulfillJson(route, { ...testUser, accounts: [account] })
      return
    }
    await route.fallback()
  })
}

/**
 * Overlay `/auth/me` with TWO accounts and price them DIFFERENTLY (#4021) —
 * the two-or-more-account grid baseline, and the #2225 rule that every
 * account row carries distinct data so a baseline cannot pass with the same
 * card painted twice. The second account derives from `testSafe` (one-field
 * splices, never a mutation of the shared object), its address is its own,
 * and `/portfolio/` for THAT address answers its own envelope; every other
 * read falls through to the shared fixture. Register AFTER `mockHavenApi`
 * (later routes win).
 */
export async function serveTwoAccounts(page: Page) {
  const second = {
    ...testSafe,
    id: 'safe-second',
    account_address: '0x4444444444444444444444444444444444444444',
    name: 'Imported Safe',
    is_default: false,
    created_at: '2026-04-20T10:00:00.000Z',
  }
  const secondAddress = second.account_address.toLowerCase()
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/auth/me') {
      await fulfillJson(route, { ...testUser, accounts: [testSafe, second] })
      return
    }
    if (request.method() === 'GET' && path.toLowerCase() === `/portfolio/${secondAddress}`) {
      await fulfillJson(route, {
        totalUsd: 480,
        totalEur: 438,
        totalSek: 5165,
        breakdown: [
          {
            symbol: 'USDC',
            balance: '300000000',
            formatted: '300.00',
            usdValue: 300,
            eurValue: 274,
            sekValue: 3230,
          },
          {
            symbol: 'ETH',
            balance: '60000000000000000',
            formatted: '0.06',
            usdValue: 180,
            eurValue: 164,
            sekValue: 1935,
          },
        ],
        // Distinct from the first account's: the grid baseline must show two
        // different footers, not one card twice.
        lastOutgoingAt: '2026-08-15T10:00:00.000Z',
      })
      return
    }
    await route.fallback()
  })
}

/**
 * Serve one feed-status answer over the shared fixture (#2869), so a spec can
 * render `/accounting` and the sidebar in a chosen flag state. Registered
 * AFTER `mockHavenApi` (later routes win) and scoped to that one read —
 * everything else keeps falling through.
 */
export async function serveAccountingFeedStatus(page: Page, status: unknown) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() === 'GET' && path === '/accounting/feed/status') {
      await fulfillJson(route, status as JsonValue)
      return
    }
    await route.fallback()
  })
}

/**
 * Serve the shared account's signer set as OWNER-ONLY: one EOA owner, zero
 * enrolled passkeys (#2284, the #2068 shape).
 *
 * This is a LIVE-RAIL configuration, not a fixture invention — the rule
 * `injected-wallet.ts` states (a fixture must not reach a state the product
 * cannot) is met on three counts:
 *
 *  1. `POST /accounts/hybrid { owner_address }` with no `passkeys` provisions
 *     exactly this account (`routes/hybrid-accounts.ts` requires at least one
 *     of the two, and #1153 made a single signer permitted); the delegation
 *     pilot script `packages/qa-agent/src/pilot/provision-hybrid.ts` does so
 *     as its first step, and `rails/hybrid-account-config.ts` treats an
 *     owner-only set as a deployable signer config.
 *  2. It is reachable from the dashboard's own passkey onboarding too:
 *     `add_owner` then `remove_passkey` — the `remove_passkey` floor in
 *     `rails/hybrid-signer-actions.ts` refuses only when the passkey is the
 *     LAST signer (`passkeys.length === 1 && !ownerAddress`).
 *  3. It is `account_type = 'delegator_hybrid'` / `execution_rail =
 *     'delegation'`, so it SPENDS: the retired rail's 410s (#1986) do not
 *     apply, and the owner EOA signs budget grants and revokes (#828).
 *
 * What it does to `WalletButton`: with no passkey in the set, neither passkey
 * branch can fire (`useActiveSigner` resolves `delegator_passkey` only for a
 * non-empty set — signer.test.ts › "owner-only hybrid set: the connected OWNER
 * wallet resolves as the EOA signer (#2068)"), so a connected wallet on a
 * supported chain reaches the connected-EOA branch. WHICH label that branch
 * carries is `useAccountOperationGate`'s call: the named owner connected renders
 * the truncated address; any other wallet renders "Wrong wallet" (#2073).
 * `ownerAddress` is therefore the caller's decision, made explicit.
 *
 * Both signer-set reads move together — the account-scoped one `AuthContext`
 * hydrates from and the agent-scoped twin (#888) — for the reason the shared
 * handlers give: same account, same answer. Register AFTER `mockHavenApi`
 * (later-registered routes win); everything else falls back to the shared
 * fixture. `wallet-signer-offering.spec.ts` uses it for the owner-match /
 * "Switch wallet" states on the account page (#2073, #3825). The collapsed
 * WalletButton pixel spec that once shared it was removed with the top-bar
 * pill (#3825); the single encoding stays so any future consumer cannot drift
 * the way #2264 found two fixtures drifting.
 */
export async function serveOwnerOnlyHybridSigners(page: Page, ownerAddress: string) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() !== 'GET') return route.fallback()

    const isAccountRead = path.startsWith('/accounts/hybrid/') && path.endsWith('/signers')
    const isAgentRead = path.startsWith('/agents/') && path.endsWith('/account-signers')
    if (!isAccountRead && !isAgentRead) return route.fallback()

    await fulfillJson(route, {
      account_address: testSafeAddress,
      chain_id: testSafe.chain_id,
      owner_address: ownerAddress,
      passkeys: [],
    })
  })
}

/**
 * Flesh out `/agents/:id` for an agent id that IS in the shared list but has
 * no detail-page handlers of its own (#2733).
 *
 * The shared fixture serves the agent DETAIL page's reads fully only for the
 * list it was seeded around: `GET /agents/:id/passport` and
 * `GET /agents/:id/delegate-balance` fall through to `fulfillUnmockedRoute`
 * (a 599 that the visual gate fails on), and there is no
 * `GET /agents/:id/activity|stats` handler at all — the page renders
 * "No activity yet" because `useAgentActivity` swallows the failure rather
 * than because the fixture answered it. `serveAgentDetailResponses` overlays
 * exactly those four reads, AFTER `mockHavenApi` (later-registered routes
 * win), so a baseline of `/agents/<id>` photographs a fully-answered screen:
 *
 *  - a delegate balance with recoverable USDC, the shape that renders the
 *    recoverable-funds banner (the #2194 incident state);
 *  - an anchored passport (#1072), the richer of the two passport states;
 *  - one confirmed x402 payment and one read-only MCP tool call, so the
 *    activity table and the audit-trail panel both render content;
 *  - the dashboard-overview stats the Spending hero's Last 30 days reads
 *    (#4260), told as ONE story with those rows (#4283): the payment is the
 *    hero's last payment (same merchant host, same time, an amount inside the
 *    30-day total), and the agent carries an MCP last-seen 80 minutes before
 *    the harness clock, so the header reads "Last activity 1h ago".
 *  - the company-details read the #3426 toggle fires at mount, so the census
 *    above is not re-failed by it (see the handler below).
 *
 * Scoped deliberately: everything else keeps falling back to the shared
 * fixture, so the agents LIST and every unrelated surface are untouched.
 */
export async function serveAgentDetailResponses(
  page: Page,
  agentId: string,
  // #3506: the shared list's other agent is also named "Research agent", so a
  // spec that shows BOTH names side by side (the sub-budget modal) can give
  // it a distinct one. Default unchanged, so no other baseline moves.
  options: {
    otherAgentName?: string
    // #3549: revoke the researched agent while it still holds its ACTIVE
    // delegation — the half-revoked state #3542 describes, reachable whenever
    // a credential is revoked before its budget (`POST /revoke` flips status
    // only). No archived override: archiving needs no live budget.
    agentOverrides?: { status?: 'revoked' }
    // #3988: pass an array to research a grant HOLDER — the agent's own
    // allowances empty out and its received grants ride on the list read
    // (the shared sub-budgets/received handler answers the detail fetch).
    receivedSubBudgets?: Array<{ parent_agent_id: string; parent_agent_name: string; open: boolean }>
  } = {},
) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    // #4229: the kinded activity read is filterable — the fixture needs the
    // query string, not just the path.
    const activityQuery = new URL(request.url()).searchParams
    if (request.method() !== 'GET') return route.fallback()

    if (path === '/agents') {
      // The detail page resolves its agent from the LIST read
      // (`AgentDetailClient` finds the id in `useAgents()`), and the shared
      // fixture seeds that list with `agent-e2e` only — an overlay answering
      // the detail reads but not the list would render the not-found branch.
      // Extend the list with the researched agent rather than replace it, so
      // the connect-flow rows the shared list exists for are untouched.
      await fulfillJson(route, {
        agents: [
          options.otherAgentName ? { ...testAgent, name: options.otherAgentName } : testAgent,
          {
            ...testAgent,
            id: agentId,
            created_at: '2026-05-02T10:00:00.000Z',
            // #4283: the header's "Last activity" reads MCP last-seen; a
            // server name with it keeps the Settings tab's Connection row
            // coherent (AgentSettingsTab). 80 minutes before the harness clock (renders "1h ago").
            mcp_server_name: 'haven-research',
            mcp_last_seen_at: '2026-09-01T10:40:00.000Z',
            ...options.agentOverrides,
            // #3988: a spec can research a grant HOLDER — no own budget, an
            // open received grant (default: the ordinary budgeted agent).
            // The spread keeps the literal under the `allowances: [` key the
            // fixture-shape-parity test classifies it by.
            allowances: [
              ...(options.receivedSubBudgets !== undefined
                ? []
                : [
                    {
                      id: 'dlg-e2e-1',
                      agent_id: agentId,
                      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                      token_symbol: 'USDC',
                      allowance_amount: '250.000000',
                      reset_period_min: 10_080,
                    },
                  ]),
            ],
            receivedSubBudgets: options.receivedSubBudgets ?? [],
          },
        ],
      })
      return
    }

    if (path === `/agents/${agentId}/delegate-balance`) {
      await fulfillJson(route, {
        delegate_address: '0x3333333333333333333333333333333333333333',
        account_address: testSafeAddress,
        chain_id: testSafe.chain_id,
        eth: '0',
        eth_atomic: '0',
        usdc: '8.00',
        usdc_atomic: '8000000',
        usdc_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        sweep_min_usdc: '0.01',
      })
      return
    }

    if (path === `/agents/${agentId}/passport`) {
      await fulfillJson(route, {
        passport: {
          status: 'anchored',
          assurance_level: 0,
          attestation_uid: `0x${'22'.repeat(32)}`,
          tx_hash: `0x${'c3'.repeat(32)}`,
          chain_id: testSafe.chain_id,
          attempts: 1,
          last_error: null,
          requested_at: '2026-06-02T10:05:00.000Z',
          anchored_at: '2026-06-02T10:05:12.000Z',
        },
        standing: {
          agentId,
          standing: 'active',
          anchor: 'anchored',
          attestationUid: `0x${'22'.repeat(32)}`,
          chainLagging: false,
          revocationConfirmedAt: null,
        },
      })
      return
    }

    if (path === `/agents/${agentId}/delegations`) {
      // One ACTIVE delegation — the spend authority row the budget card and
      // the page summary both read. 250.00 USDC per week, recipient-pinned,
      // mirroring the screenshot harness's `dlg-1` shape so both capture
      // paths describe the same authority.
      await fulfillJson(route, {
        delegations: [
          {
            id: 'dlg-e2e-1',
            chain_id: testSafe.chain_id,
            token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            recipient_address: testRecipientAddress,
            delegation_hash: `0x${'4d'.repeat(32)}`,
            version: 1,
            status: 'active',
            is_live: true,
            budget_atomic: '250000000',
            period_seconds: 604_800,
            // #3806: Unix-seconds digit string on the wire, never ISO.
            start_date: '1780394400',
            expires_at: Math.floor(Date.UTC(2027, 5, 2) / 1000),
            created_at: '2026-06-02T10:00:00.000Z',
          },
        ],
      })
      return
    }

    if (path === `/agent-activity/${agentId}/activity`) {
      // #4229: the kinded read is pageable and filterable, so the fixture
      // honours kind, status and offset — a filtered capture never bakes in
      // mixed or unfiltered rows. Omitting kind serves the legacy merged
      // list, unchanged. (from/to/q/paymentId are not fixture inputs; the
      // capture suite never passes them.)
      const activityKind = activityQuery.get('kind')
      if (activityKind) {
        const activityStatus = activityQuery.get('status')
        const activityOffset = Number(activityQuery.get('offset')) || 0
        const paymentRow = {
          type: 'payment',
          id: 'pay-e2e-1',
          agent_id: agentId,
          agent_name: testAgent.name,
          token: 'USDC',
          token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount_raw: '50000',
          amount: '0.05',
          // #3824: the serve-time amount at the served user's rate in their
          // preference (#4166) — the USD session prices it at par. #4283: the
          // hero's last payment (research.example, 2026-08-31T09:40Z), small
          // enough to sit inside its 30-day total.
          ...serveTimeApproxSnake(0.05),
          to: testRecipientAddress,
          reason: null,
          status: 'confirmed',
          tx_hash: `0x${'a1'.repeat(32)}`,
          source: 'x402',
          x402_resource_url: 'https://research.example/report',
          x402_merchant_address: testRecipientAddress,
          chain_id: testSafe.chain_id,
          account_id: testSafe.id,
          account_address: testSafeAddress,
          account_name: testSafe.name,
          explorer_url: `https://sepolia.basescan.org/tx/0x${'a1'.repeat(32)}`,
          confirmed_at: '2026-08-31T09:40:00.000Z',
          payment_proof_status: 'payment_confirmed',
          payment_flow_status: 'confirming_merchant',
          payment_attention_reason: null,
          created_at: '2026-08-31T09:38:00.000Z',
        }
        const toolCallRow = {
          type: 'mcp_tool_call',
          id: 'call-e2e-1',
          agent_id: agentId,
          agent_name: testAgent.name,
          tool_name: 'haven_pay_x402_quote',
          payment_id: 'pay-e2e-1',
          result_status: 'ok',
          next_action: 'settle',
          error_code: null,
          status_code: 200,
          created_at: '2026-08-31T09:37:00.000Z',
        }
        const refusalRow = {
          // #4323: the refusal population — the fixture serves one refused
          // attempt so the Refused facet's capture has a row to show. Atomic
          // on the wire; the serve-time triple is the fixture's priced view.
          type: 'refusal',
          id: 'refusal-e2e-1',
          created_at: '2026-08-31T09:36:00.000Z',
          amount: '25000',
          token_symbol: 'USDC',
          chain_id: testSafe.chain_id,
          merchant_to: testRecipientAddress,
          resource_url: 'https://research.example/report',
          reason: 'delegation_budget_exceeded',
          attempts: 2,
          approx_amount_usd: '0.0250',
          approx_amount_eur: null,
          approx_amount_sek: null,
        }
        const paymentStatuses = new Set(['sent', 'pending', 'failed', 'needs_attention'])
        const rows: Array<Record<string, any>> =
          activityKind === 'payments'
            ? [paymentRow]
            : activityKind === 'refusals'
              ? [refusalRow]
              : [toolCallRow]
        const filtered = rows.filter((row) => {
          if (!activityStatus) return true
          if (activityKind === 'refusals') return activityStatus === 'refused'
          if (activityKind === 'tool_calls') return row.result_status === activityStatus
          if (!paymentStatuses.has(activityStatus)) return true
          if (activityStatus === 'sent') return row.status === 'confirmed'
          if (activityStatus === 'pending') return row.status === 'pending_signature' || row.status === 'submitted'
          if (activityStatus === 'failed') return row.status === 'failed'
          return row.payment_attention_reason != null
        })
        const page = filtered.slice(activityOffset)
        const body: Record<string, unknown> = {
          activity: page,
          total: filtered.length,
          hasMore: activityOffset + page.length < filtered.length,
        }
        // The summary-line count ignores the status filter (same contract as
        // the route), so it is stable while the status selection flips.
        if (activityKind === 'tool_calls') {
          body.counts = { error: rows.filter((row) => row.result_status === 'error').length }
        }
        await fulfillJson(route, body)
        return
      }
      await fulfillJson(route, {
        activity: [
          {
            type: 'payment',
            id: 'pay-e2e-1',
            agent_id: agentId,
            agent_name: testAgent.name,
            token: 'USDC',
            token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount_raw: '50000',
            amount: '0.05',
            // #3824: the serve-time amount at the served user's rate in their
            // preference (#4166) — the USD session prices it at par. #4283: the
            // hero's last payment (research.example, 2026-08-31T09:40Z), small
            // enough to sit inside its 30-day total.
            ...serveTimeApproxSnake(0.05),
            to: testRecipientAddress,
            reason: null,
            status: 'confirmed',
            tx_hash: `0x${'a1'.repeat(32)}`,
            source: 'x402',
            x402_resource_url: 'https://research.example/report',
            x402_merchant_address: testRecipientAddress,
            chain_id: testSafe.chain_id,
            account_id: testSafe.id,
            account_address: testSafeAddress,
            account_name: testSafe.name,
            explorer_url: `https://sepolia.basescan.org/tx/0x${'a1'.repeat(32)}`,
            confirmed_at: '2026-08-31T09:40:00.000Z',
            payment_proof_status: 'payment_confirmed',
            payment_flow_status: 'confirming_merchant',
            payment_attention_reason: null,
            created_at: '2026-08-31T09:38:00.000Z',
          },
          {
            type: 'mcp_tool_call',
            id: 'call-e2e-1',
            agent_id: agentId,
            agent_name: testAgent.name,
            tool_name: 'haven_pay_x402_quote',
            payment_id: 'pay-e2e-1',
            result_status: 'ok',
            next_action: 'settle',
            error_code: null,
            status_code: 200,
            created_at: '2026-08-31T09:37:00.000Z',
          },
        ],
      })
      return
    }

    if (path === `/agent-activity/${agentId}/stats`) {
      await fulfillJson(route, {
        all_time: [{ token: 'USDC', total_spent: '0.05', tx_count: 1 }],
        today: [{ token: 'USDC', total_spent: '0.00', tx_count: 0 }],
        pending_approvals: 0,
      })
      return
    }

    // #3426: AgentDetailClient now mounts TaxDeclarationToggle, whose
    // useCompanyDetails read fires on every agent-detail page. The shared
    // fixture DOES answer this route — 404 { error: 'Not found' }, the
    // flag-gated default (#3332) — and that answer is correct everywhere a
    // spec photographs the flag-off state. But a 404 response still makes
    // Chromium log `Failed to load resource: ... 404` as a console error,
    // and `agent-detail.mobile.spec.ts` counts unmocked API noise by census
    // (`unexpectedBrowserErrors`), so the branch's own mount-time read
    // failed that spec deterministically. A fulfilled 404 cannot silence
    // the browser's own log line, so this overlay answers the route's OTHER
    // documented state instead: 200 `null` — "flag on, nothing saved"
    // (`routes/owner-company-details.ts`), which `useCompanyDetails` maps
    // to `'empty'`. The toggle renders null for `'empty'` exactly as it
    // does for `'off'` (`details.vies_status !== 'valid'`), so the page is
    // unchanged and no baseline moves; the read just stops being API noise.
    // Scoped HERE, not in `mockHavenApi`, so `/settings` — where
    // `settings-company-details.visual.spec.ts` pins the empty and filled
    // forms and the shared fixture's 404 hides the card — keeps its state.
    if (path === '/user/company-details') {
      await fulfillJson(route, null)
      return
    }

    // #4260: the agent Spending hero's right half (Last 30 days) renders
    // only from the overview's per-agent stats, and the shared overview
    // lists no researched agent — so no capture showed it. Served HERE and
    // not in the shared `dashboardOverview`, whose agents list every
    // dashboard baseline photographs. Ages are pinned against the visual
    // harness's frozen clock (2026-09-01T12:00Z): "1d ago".
    if (path === '/dashboard/overview') {
      await fulfillJson(route, {
        ...dashboardOverview,
        activity: dashboardOverview.activity.map((group) => withServedApprox(group, 12.5)),
        // A spec that researches a shared-overview agent (`agent-e2e`) keeps
        // one row per id: the researched agent replaces, never duplicates.
        agents: [
          ...dashboardOverview.agents.filter((agent) => agent.id !== agentId),
          {
            ...dashboardOverview.agents[0],
            id: agentId,
            stats: {
              ...dashboardOverview.agents[0].stats,
              d30: {
                ...dashboardOverview.agents[0].stats.d30,
                // #4274: gross and net differ, so the refreshed
                // agent-detail-research-* baseline proves the hero reads the
                // net window (1.05), not the gross one (1.42) it used to.
                gross: { usd: 1.42, eur: 1.29, sek: 15.28 },
                net: { usd: 1.05, eur: 0.95, sek: 11.3 },
                payments: 48,
              },
              lastPaymentAt: '2026-08-31T09:40:00.000Z',
            },
          },
        ],
      })
      return
    }

    return route.fallback()
  })
}

export async function seedAuthenticatedSession(page: Page) {
  await page.addInitScript(
    ({ tokenKey }) => {
      window.localStorage.setItem(tokenKey, 'e2e-token')
    },
    {
      tokenKey: AUTH_TOKEN_STORAGE_KEY,
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

  /**
   * #4053: the phone More menu is a bottom sheet that exists in the DOM only
   * while it is open (`[data-more-sheet]`), and it opens only on a tap — every
   * mount starts closed, and widening past `lg` closes it. So "is it open" is
   * a presence check with nothing to settle: no geometry, no animation, no
   * viewport-derived label to race (the #2902 failure mode of the drawer
   * this replaced, whose open/closed state was a function of the viewport).
   *
   * Closed: nothing to dismiss — and nothing is clicked, so a closed sheet
   * can never be toggled OPEN by this helper.
   */
  const sheet = page.locator('[data-more-sheet]')
  if ((await sheet.count()) === 0) return

  // Open: dismiss it with the real control — since #4058 the sheet's own ✕,
  // which carries `Close sidebar` (the sheet covers the bar, and the More
  // cell is only ever `Open sidebar`). A plain click — no `{ force: true }`
  // (#1749) — keeps this helper a regression canary for the sheet's way out
  // being covered: mobile e2e fails here with "intercepts pointer events".
  // Bounded at 10 s.
  await page.getByRole('button', { name: 'Close sidebar' }).click({ timeout: 10_000 })
  await sheet.waitFor({ state: 'detached', timeout: 10_000 })
}

/**
 * Navigate to the receive dialog and return its locator (#1797).
 *
 * Shared because two specs now open it — `dashboard.spec.ts` at 1280 and
 * `receive-modal.mobile.spec.ts` at 393 — and the *navigation* to a screen is
 * not viewport-dependent, so a second hand-written copy would only create room
 * for the two to drift on how the dialog is reached.
 *
 * Note what this deliberately does NOT share: the MEASUREMENT and its
 * assertions. Those stay written out at each call site, because #1779's rule
 * is that one shared reference frame every suite trusts is itself the defect —
 * two independent measurements can disagree, one cannot. Getting to the screen
 * is not a measurement, so it is not covered by that rule; folding
 * `measureDialogOverflow` in here would be.
 *
 * `dismissMobileSidebar` no-ops at or above `lg`, so this is correct at both
 * viewports without a branch.
 */
/**
 * Waits for the phone More sheet (#4053) to finish opening.
 *
 * The sheet slides up on a 200ms enter animation, and a moving element is
 * "visible" to Playwright from its first frame, so geometry read on
 * visibility lands on a part-way sheet. The sheet says when it has arrived:
 * `data-state="open"` is set on its own `animationend` (or on the next frame
 * under reduced motion, with a timeout backstop), and `opening` before that.
 *
 * The name says `Open` because that is all it waits for — call it after a tap
 * on More, never to confirm a dismissal.
 */
export async function waitForDrawerOpen(page: Page) {
  await page.locator('[data-more-sheet][data-state="open"]').waitFor({ state: 'visible', timeout: 10_000 })
}

export async function openReceiveDialog(page: Page) {
  await page.goto('/dashboard')
  await dismissMobileSidebar(page)
  // #4094: the money card's actions are "Receive" (primary) and "Send"; both
  // funding verbs — the old "Add funds" and "Deposit address" — merged into
  // the one Receive dialog. Pin to the first exact match in DOM order.
  await page
    .getByRole('button', { name: /^Receive$/ })
    .first()
    .click()

  const modal = page.getByRole('dialog', { name: 'Receive' })
  await modal.waitFor({ state: 'visible' })
  return modal
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
 * content never grows the document and the old metric reported a clean fit.
 *
 * That is worse than no check, because it gets cited as evidence. It was found
 * only by mutation — #1768 shipped a deliberate `w-[120vw]` on `/dashboard`
 * and CI run 32542736317 went green, with the overflow assertion explicitly
 * passing.
 *
 * So the document metric is kept — it is the ONLY one that works on
 * unauthenticated pages like `/login`, which have no shell and no
 * `#main-content` — and the content-region metric is added beside it.
 *
 * ## What each metric actually means — they are DIFFERENT defects
 *
 * Do not collapse these two into "content is off-screen"; the next person
 * debugging a failure needs to know which one fired.
 *
 * - `documentOverflows` — something escaped the page box itself. Where the
 *   ancestors are `overflow-hidden` (the authenticated shell) this means the
 *   content really is CLIPPED and unreachable, with no scrollbar anywhere.
 *
 * - `contentOverflows` — `<main id="main-content">` is wider than its own box.
 *   `<main>` is `overflow-y-auto`, and per CSS Overflow §3 setting one axis to
 *   a non-`visible` value computes the OTHER axis to `auto`, so its
 *   `overflow-x` is `auto` and it is a genuine horizontal scroll box.
 *   Measured directly rather than reasoned about: with a 120vw child at 393px,
 *   `getComputedStyle(main).overflowX === 'auto'` and `main.scrollLeft` moves
 *   to 79 — so the content is REACHABLE by scrolling the pane.
 *
 *   That is still a real defect, and it is the #1772 shape: one wide element
 *   drags the WHOLE content pane into horizontal scroll — headings, cards and
 *   all — instead of scrolling only itself inside an `overflow-x-auto`
 *   wrapper. Read a `contentOverflows` failure as "the entire content pane is
 *   forced into horizontal scroll", NOT as "the content cannot be reached".
 *
 * `hasOverflow` is the UNION, so every existing
 * `toMatchObject({ hasOverflow: false })` call site starts gating for real
 * without changing shape. The two booleans are also returned separately for a
 * caller that needs to say which one it means.
 *
 * ## Assert `contentRegionFound` on authenticated routes
 *
 * When the content region is absent — or attached but not laid out — the
 * content metric degrades to `0`, which reads as "fits": the silent no-op that
 * this whole helper exists to prevent. So `contentRegionFound` requires a
 * NON-ZERO `clientWidth`, not merely a node in the DOM; a hydration flash, a
 * `display:none` mid-transition or a failed stylesheet all produce an attached
 * `<main>` measuring `0 - 0 = 0`. The helper cannot tell on its own whether a
 * page SHOULD have a content region, so authenticated call sites pass
 * `{ hasOverflow: false, contentRegionFound: true }` and make the no-op path
 * loud. `/login` legitimately has no content region and asserts only
 * `hasOverflow`.
 *
 * ## Known blind spot, and it is structural
 *
 * This compares TWO scroll boxes; it does not walk the ancestor chain. So any
 * `overflow-hidden` BETWEEN the two measured boxes swallows the evidence
 * before either one sees it — a card inside `<main>` that clips a decorative
 * element, and one day clips real content, recreates the exact #1768 failure
 * one level further down. Fixing the document-level case did not close the
 * failure class; it closed the instance of it that the shell created.
 *
 * The concrete case measured so far is `position: fixed` overlays. A fixed
 * element is laid out against the viewport, so it contributes to neither the
 * document's scrollable overflow nor `<main>`'s — and an ancestor's
 * `overflow-hidden` does not clip it either. Verified, not assumed: a 120vw
 * block inside `ReceiveFundsModal` left `dashboard.spec.ts`' assertion green.
 * Call sites that open a dialog before asserting are therefore measuring the
 * page BEHIND the dialog — still a real assertion, but not a check on the
 * dialog's own layout. That is now covered by `measureDialogOverflow` below
 * (#1773), which is a SIBLING rather than a widening of this helper — see its
 * JSDoc for why the union was the wrong shape the second time.
 *
 * ## The viewport-absolute fields, and why they are REPORTED and not asserted
 *
 * `viewportWidth` / `contentLeft` / `contentRight` measure the content region
 * against the VIEWPORT rather than against itself (#1779). Both overflow
 * metrics above compare a box to another box — `scrollWidth` to `clientWidth`,
 * of the same element — so they are invariant under any transformation that
 * moves the whole shell. Measured: swapping the mobile toggle's `fixed` for
 * `relative` puts it in flow as a 32px flex item, `<main>` goes from
 * `left 0, width 393` to `left 32, width 361`, and BOTH ratios are unchanged
 * (`361 - 361 = 0`, exactly as `393 - 393 = 0` was). The whole app shell
 * displaced 32px and every relative reading held. That is a property of the
 * reference frame, not of how the assertion was phrased — no rewording of a
 * "A relative to B" check can see A and B move together.
 *
 * These three are deliberately NOT asserted here, and that is the design rather
 * than an omission. This helper has three classes of caller with three
 * different CORRECT answers: below `lg` the rail is hidden (#4053), so
 * `<main>` spans the full viewport (`0 → innerWidth`); on desktop the rail is
 * an in-flow column and legitimately occupies the first 240px, so `contentLeft` is
 * 240; and `/login` is outside the shell entirely and has no content region at
 * all. A single anchor baked in here would have to be loose enough to hold for
 * all three, which is another way of saying it would hold for the defect too.
 *
 * So the numbers come from here and the CONTRACT is asserted where it is known:
 * `navigation.mobile.spec.ts` pins the mobile shell to `0 → innerWidth`. That
 * split is also why `mobile-nav-layering.mobile.spec.ts` computes its own
 * anchor instead of calling this helper — one shared anchor that every mobile
 * suite trusts would be a single reference frame again, and a single reference
 * frame is the thing #1779 is about. Two independent measurements can disagree;
 * one cannot.
 */
export async function expectNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const documentWidth = document.documentElement.clientWidth
    const scrollWidth = document.documentElement.scrollWidth
    const bodyScrollWidth = document.body.scrollWidth
    const documentOverflows =
      scrollWidth > documentWidth + 1 || bodyScrollWidth > documentWidth + 1

    const main = document.getElementById('main-content')
    const contentScrollWidth = main ? main.scrollWidth : null
    const contentClientWidth = main ? main.clientWidth : null

    // Where the content region sits IN THE VIEWPORT. Nothing above this line
    // can see the shell move, because everything above compares a box to
    // itself. `getBoundingClientRect` is viewport-relative by definition, so
    // these are the anchored readings — see the JSDoc for why they are reported
    // rather than asserted here (#1779).
    const contentBox = main ? main.getBoundingClientRect() : null
    const viewportWidth = window.innerWidth
    // Presence is NOT enough: an attached but unlaid-out `<main>` measures
    // `0 - 0 = 0`, which reads as "fits". Require a real box, so the no-op
    // path fails the `contentRegionFound` assertion instead of passing.
    const contentRegionFound = contentClientWidth !== null && contentClientWidth > 0
    // 1px of tolerance for sub-pixel layout rounding. A real overflow is far
    // larger — the three measured so far were the #1768 mutation, #1772's
    // transactions table, and this helper's own mutation proof, all ~100px+.
    const contentOverflowBy =
      contentRegionFound && contentScrollWidth !== null && contentClientWidth !== null
        ? contentScrollWidth - contentClientWidth
        : 0
    const contentOverflows = contentOverflowBy > 1

    return {
      documentWidth,
      scrollWidth,
      bodyScrollWidth,
      documentOverflows,
      contentRegionFound,
      // Distinguishes "no such element" from "element present but not laid
      // out" when a `contentRegionFound` assertion fails.
      contentAttached: Boolean(main),
      contentScrollWidth,
      contentClientWidth,
      contentOverflowBy,
      contentOverflows,
      hasOverflow: documentOverflows || contentOverflows,
      // Viewport-absolute (#1779). Rounded: sub-pixel layout makes a raw
      // `left` read `0.00001` and an `=== 0` assertion flake on it.
      viewportWidth,
      contentLeft: contentBox ? Math.round(contentBox.left) : null,
      contentRight: contentBox ? Math.round(contentBox.right) : null,
    }
  })
}

/**
 * Measure horizontal overflow INSIDE a fixed-position overlay (#1773).
 *
 * `expectNoHorizontalOverflow` above cannot see any of this. A `position:
 * fixed` element is laid out against the viewport, so it contributes to the
 * scrollable overflow of neither the document nor `<main>`, and an ancestor's
 * `overflow-hidden` does not clip it either. Measured, not inferred: a
 * `w-[120vw]` block inside `ReceiveFundsModal` left `dashboard.spec.ts`'
 * assertion green while the same mutation on the page behind it turned it red.
 * Three specs opened a dialog and then asserted overflow, which reads as "and
 * the panel does not break layout"; all three were measuring the route behind
 * the overlay.
 *
 * ## Why a sibling helper and NOT a widened `hasOverflow`
 *
 * #1771 unioned its two page-level boxes because EVERY caller wanted both.
 * That is not true here — five of the call sites (`auth` x3 and `hosted-mcp`
 * x4, plus `navigation.mobile`) never open a dialog at all. Folding an overlay
 * metric into `hasOverflow` would make "no dialog is open" and "the dialog
 * fits" the same reading, which is the silent-no-op shape `contentRegionFound`
 * exists to prevent, reintroduced one layer up. So this follows #1779's split:
 * shared MEASUREMENT here, the assertion written at each call site that knows
 * it has an overlay open. `dialogFound` is the loud-no-op guard and callers
 * must assert it.
 *
 * ## Why it scans the SUBTREE, not the dialog's own scroll box
 *
 * The issue proposed measuring `[role="dialog"]`'s own scroll box. Measuring
 * it falsified that: it fires on ONE of the three dialogs.
 *
 *   dialog        primitive     role="dialog" is        own box    subtree
 *   ------------- ------------- ----------------------- ---------- --------
 *   Receive funds bespoke       the panel itself           1026       1026
 *   x402 detail   ui/SidePanel  panel; body scrolls           0       1129
 *   Connect agent ui/Modal      the fixed inset-0 box         0       1010
 *
 * (`scrollWidth - clientWidth` in px under the same 120vw mutation; every
 * clean reading is 0.)
 *
 * Two of the three nest an `overflow-y-auto` body inside the dialog node, and
 * per CSS Overflow §3 a non-`visible` value on one axis computes the OTHER to
 * `auto` — so that body is itself a horizontal scroll box, absorbs the
 * overflow, and never propagates it outward. Measuring only the dialog node
 * would have shipped a guard that is green on two of the three call sites it
 * was written for: the family's own defect, third instance. Scanning every box
 * in the subtree also removes the reliance on upward propagation that makes an
 * intermediate `overflow-hidden` a blind spot for the sibling helper.
 *
 * ## The viewport-absolute fields are REPORTED, not asserted
 *
 * Same split as #1779, for a reason measured here rather than inherited. The
 * three overlays have three different CORRECT positions at 1280px — the
 * centred modal spans 384 to 896, the right-anchored side panel 834 to 1282,
 * the full-viewport overlay 0 to 1280 — so no single anchor holds for all
 * three. (All three read off this helper's own output, not reconstructed from
 * the components.) And the side panel sits flush against the right edge, where
 * its rounded `right` read 1280, 1281 and 1282 across three runs at a viewport
 * of 1280; an `=== viewportWidth` assertion would flake on sub-pixel layout.
 * The numbers are returned so a failure is diagnosable and so a call site that
 * knows its overlay's geometry can pin it.
 *
 * One asymmetry the "three different answers" framing would otherwise hide:
 * for a `ui/Modal`-rooted dialog these two fields are structurally INERT.
 * `role="dialog"` sits on the `fixed inset-0` wrapper rather than on the
 * visual panel, so `dialogLeft`/`dialogRight` read `0`/`viewportWidth` no
 * matter what the panel inside does — resize it, shove it off-centre, and
 * these two numbers do not move. They are informative for the bespoke
 * `ReceiveFundsModal` and for `ui/SidePanel`, whose `role="dialog"` IS the
 * panel. Do not read a stable `0 → 1280` on a `ui/Modal` dialog as evidence
 * that its panel is where it should be; nothing here measures that.
 *
 * ## Known limit, stated rather than papered over
 *
 * A box that overflows is reported whether or not it MEANT to. One exclusion
 * is built in — boxes 1px or narrower, which is the visually-hidden idiom and
 * not a layout defect; see the comment at the check itself for the measurement
 * that forced it. Note that this predicate is narrower than the idiom it
 * excludes: it tests width only, not the full `sr-only` signature of a 1px
 * box with `overflow: hidden` and `clip`. That is deliberate — it is the
 * smallest rule that removes the measured false positive — but it is a width
 * test, not a "visually hidden" test, and should be read as one.
 *
 * Beyond that, nothing is excluded, and the consequence is worth stating
 * plainly rather than discovering: **a legitimate, self-contained horizontal
 * scroller inside one of these dialogs will fail these specs.** The exclusion
 * above is purely geometric and does nothing for a properly-sized
 * `overflow-x-auto` wrapper. None of the three dialogs contains one today —
 * verified, not assumed — but a `CodeBlock` showing a connector command, or an
 * `overflow-x-auto` element holding a full delegate address or tx hash, is a
 * plausible next addition to any of them, and it is exactly the idiom the
 * playbook recommends for #1772-shaped defects. The next author to add one
 * will meet this guard.
 *
 * Deliberately NOT solved by excluding elements whose computed `overflow-x` is
 * `auto`/`scroll`, which is the obvious-looking fix and is measurably wrong
 * here: per CSS Overflow §3, `overflow-y-auto` computes `overflow-x` to
 * `auto`, so that rule would exempt `ui/Modal`'s and `ui/SidePanel`'s scrolling
 * BODIES — the exact elements that caught two of this change's three mutation
 * proofs (1010px and 1129px). It would not narrow the guard, it would gut it.
 * A class-name heuristic is rejected for the mirror-image reason: it would
 * silently exempt a real defect that happened to carry the class.
 *
 * So the escape hatch is the repo's existing honest one — exempt the known
 * case BY NAME at the call site with an issue number, the way
 * `KNOWN_CONTENT_OVERFLOW` does in `navigation.mobile.spec.ts`. Concretely,
 * when a dialog legitimately gains one scrolling wrapper:
 *
 *     const overlay = await measureDialogOverflow(page)
 *     // The setup-prompt CodeBlock scrolls inside its own wrapper by design
 *     // (#NNNN). Everything ELSE in the dialog must still fit.
 *     expect(overlay).toMatchObject({ dialogFound: true, dialogCount: 1 })
 *     expect(overlay.worstOffender).toMatch(/overflow-x-auto/)
 *     expect(overlay.offenderCount).toBe(1)
 *
 * — which keeps the assertion gating instead of deleting it, and names what
 * was allowed and why. Widening the helper with an `ignoreSelectors` parameter
 * was considered and left unbuilt: an unused escape hatch is a guess about a
 * case that does not exist yet, and this family's whole subject is guards that
 * were shaped by assumption rather than measurement.
 */
export async function measureDialogOverflow(page: Page, selector = '[role="dialog"]') {
  return page.evaluate((sel) => {
    const matches = Array.from(document.querySelectorAll(sel))
    const dialog = matches[0] ?? null
    const viewportWidth = window.innerWidth

    if (!dialog) {
      return {
        dialogAttached: false,
        dialogFound: false,
        dialogCount: 0,
        dialogScrollWidth: null,
        dialogClientWidth: null,
        dialogOverflowBy: 0,
        dialogOverflows: false,
        overlayOverflowBy: 0,
        overlayOverflows: false,
        offenderCount: 0,
        worstOffender: null,
        viewportWidth,
        dialogLeft: null,
        dialogRight: null,
        contentMinLeft: null,
        contentMaxRight: null,
      }
    }

    const describe = (el: Element) => {
      const cls = (el.getAttribute('class') ?? '').trim().replace(/\s+/g, ' ')
      const id = el.id ? `#${el.id}` : ''
      const testId = el.getAttribute('data-testid')
      return `${el.tagName.toLowerCase()}${id}${testId ? `[data-testid=${testId}]` : ''}${
        cls ? `.${cls.slice(0, 120)}` : ''
      }`
    }

    // The dialog node's own box, kept alongside the subtree figure. When a
    // failure arrives, seeing `dialogOverflowBy: 0` next to a non-zero
    // `overlayOverflowBy` is what tells the reader the offender is a nested
    // scroll box rather than the dialog itself.
    const dialogScrollWidth = dialog.scrollWidth
    const dialogClientWidth = dialog.clientWidth
    // Presence is NOT enough, exactly as for `<main>`: an attached but
    // unlaid-out dialog measures `0 - 0 = 0`, which reads as "fits".
    const dialogFound = dialogClientWidth > 0
    const dialogOverflowBy = dialogFound ? dialogScrollWidth - dialogClientWidth : 0

    // 1px of tolerance for sub-pixel layout rounding, matching the sibling
    // helper. The measured mutations were 1010-1129px, so the tolerance is
    // nowhere near the decision boundary for a real defect.
    let overlayOverflowBy = dialogFound && dialogOverflowBy > 1 ? dialogOverflowBy : 0
    let worstOffender = overlayOverflowBy > 0 ? describe(dialog) : null
    let offenderCount = overlayOverflowBy > 0 ? 1 : 0

    let contentMinLeft = Infinity
    let contentMaxRight = -Infinity

    for (const el of Array.from(dialog.querySelectorAll('*'))) {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      const clientWidth = el.clientWidth
      // A box 1px wide or narrower is not laying out real content, and
      // treating one as an overflow is a false positive rather than a find.
      // Measured, not anticipated: the restore run of this very change went red
      // on `span.sr-only` in the connect modal with `overlayOverflowBy: 67`.
      // Tailwind's `sr-only` is the standard visually-hidden idiom — `width:
      // 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0)` — so its
      // `scrollWidth` is the full width of the screen-reader text and its
      // `clientWidth` is 1. Every such element reports a large "overflow" that
      // is the utility working exactly as intended.
      //
      // Excluded by GEOMETRY rather than by matching the `sr-only` class name:
      // a class-name rule would silently exempt a real defect that happened to
      // carry the class, and would miss every other visually-hidden idiom. The
      // guard loses nothing — the three mutations this change is proven against
      // overflowed boxes 447, 510 and 574px wide.
      if (clientWidth > 1) {
        const by = el.scrollWidth - clientWidth
        if (by > 1) {
          offenderCount += 1
          if (by > overlayOverflowBy) {
            overlayOverflowBy = by
            worstOffender = describe(el)
          }
        }
      }

      const box = el.getBoundingClientRect()
      // A zero-area box has no meaningful position — a collapsed wrapper would
      // otherwise drag `contentMinLeft` to 0 on every dialog.
      if (box.width === 0 && box.height === 0) continue
      if (box.left < contentMinLeft) contentMinLeft = box.left
      if (box.right > contentMaxRight) contentMaxRight = box.right
    }

    const dialogBox = dialog.getBoundingClientRect()

    return {
      dialogAttached: true,
      dialogFound,
      // A second overlay open at once means this measured whichever came first
      // in DOM order. Reported so that is visible instead of silent.
      dialogCount: matches.length,
      dialogScrollWidth,
      dialogClientWidth,
      dialogOverflowBy,
      dialogOverflows: dialogOverflowBy > 1,
      overlayOverflowBy,
      overlayOverflows: overlayOverflowBy > 1,
      // NOT a count of distinct defects. One overflowing leaf registers at
      // every level above it that does not absorb the overflow, so a single
      // bug in a `ReceiveFundsModal`-shaped dialog (where `role="dialog"` is
      // the content panel itself) shows up on the leaf AND the panel. Read it
      // as "how many boxes report it", and `worstOffender` as "where it is
      // widest" — the mutation proof's 2 → 1 was one defect plus one
      // visually-hidden false positive, not two bugs.
      offenderCount,
      worstOffender,
      // Viewport-absolute — reported, never asserted here. See the JSDoc.
      // Rounded for legibility only; nothing branches on these.
      viewportWidth,
      dialogLeft: Math.round(dialogBox.left),
      dialogRight: Math.round(dialogBox.right),
      contentMinLeft: Number.isFinite(contentMinLeft) ? Math.round(contentMinLeft) : null,
      contentMaxRight: Number.isFinite(contentMaxRight) ? Math.round(contentMaxRight) : null,
    }
  }, selector)
}
