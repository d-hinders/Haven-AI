/**
 * #4216 — child-process probe for the kit-analytics proof. Spawned by
 * `kit-analytics-off.test.ts` via tsx so each measurement gets a fresh node
 * process: the kit's analytics latch lives in module state, and a fresh
 * process is the only way to re-arm it (vitest cannot re-evaluate an
 * externalized node_modules package).
 *
 *   node <tsx-cli> kit-analytics-probe.ts mechanism   # kit-analytics-off.ts first
 *   node <tsx-cli> kit-analytics-probe.ts bare        # no mechanism
 *
 * Both modes strip CI and DO_NOT_TRACK from the environment first (GitHub
 * Actions exports CI=true, which is one of the kit's own opt-out inputs — a
 * proof that inherits it measures nothing), install a fetch recorder BEFORE
 * the kit is imported (openapi-fetch captures globalThis.fetch when the kit's
 * Analytics client is constructed at module evaluation), make one tracked kit
 * call, wait past the kit's 100ms post flush, and print one JSON line:
 * `{ analyticsPosts, totalPosts }`. With fetch stubbed, nothing leaves the
 * process.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

const ANALYTICS_HOST = 'mm-sdk-analytics.api.cx.metamask.io'
const FLUSH_WAIT_MS = 1500 // the kit batches posts on a 100ms timer; wait well past it
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // USDC Base Sepolia

const mode = process.argv[2]
if (mode !== 'mechanism' && mode !== 'bare') {
  console.error('usage: kit-analytics-probe.ts <mechanism|bare>')
  process.exit(2)
}

// The kit's own opt-out inputs must not leak in: an inherited CI=true or
// DO_NOT_TRACK disables the kit before our mechanism gets a chance to matter.
delete process.env.CI
delete process.env.DO_NOT_TRACK

if (mode === 'mechanism') {
  // The mechanism under test, exactly as src/index.ts / vitest.setup.ts /
  // scripts load it: a side-effect import that must precede the kit.
  await import('../../kit-analytics-off.js')
}

const posts: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  if (url) posts.push(url)
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const { createDelegation, getSmartAccountsEnvironment } = await import(
  '@metamask/smart-accounts-kit'
)
const account = privateKeyToAccount(generatePrivateKey())
// A tracked kit call — cheap, self-contained, nothing signed that matters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
createDelegation({
  environment: getSmartAccountsEnvironment(84532),
  from: account.address,
  to: account.address,
  scope: {
    type: 'erc20PeriodTransfer',
    tokenAddress: TOKEN,
    periodAmount: 1_000_000n,
    periodDuration: 86_400,
    startDate: 1_700_000_000,
  },
  caveats: [],
  salt: `0x${'11'.repeat(32)}` as Hex,
} as any)

await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))
process.stdout.write(
  `${JSON.stringify({
    analyticsPosts: posts.filter((u) => u.includes(ANALYTICS_HOST)).length,
    totalPosts: posts.length,
  })}\n`,
)
process.exit(0)
