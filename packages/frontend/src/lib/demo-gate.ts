import { getFaucetUrl } from '@haven_ai/core'
import { isProductionEnvironment } from './env'
import { DEFAULT_CHAIN_ID } from './chains'

/**
 * Whether `/demo` and `/demo.md` may render (#3477).
 *
 * The investor demo walks a visitor through spending TEST funds — it must
 * never answer on the real-money deployment. Two independent reasons a build
 * counts as "production" here, either one enough to 404:
 *
 * 1. `isProductionEnvironment()` — the `NEXT_PUBLIC_HAVEN_ENV` convention
 *    (`lib/env.ts`): unset, empty, `production` or `prod` all mean production.
 * 2. The deployment's default chain (`DEFAULT_CHAIN_ID`, `lib/chains.ts`) has
 *    no faucet — i.e. it is not a testnet Haven's registry knows about
 *    (`getFaucetUrl`, `@haven_ai/core`). Production defaults to Base mainnet,
 *    which has none; this catches a build that is production in substance
 *    even if `NEXT_PUBLIC_HAVEN_ENV` were ever misconfigured.
 *
 * `HAVEN_DEMO_PAGE_VISIBLE` is the one escape hatch, and it is deliberately
 * server-only: no `NEXT_PUBLIC_` prefix, so Next never inlines it into the
 * client bundle and it can never become a build-time constant baked into a
 * deployed bundle. Production's env configuration
 * (`docs/operations/dev-environment.md`) never sets it — nothing asks it to.
 * It exists only so the visual-regression Playwright server, which otherwise
 * builds exactly like production (no `NEXT_PUBLIC_HAVEN_ENV`, see
 * `playwright.config.ts`), can still render `/demo` to capture its baselines.
 */
export function isDemoPageVisible(): boolean {
  if (process.env.HAVEN_DEMO_PAGE_VISIBLE === '1') return true
  if (isProductionEnvironment()) return false
  return getFaucetUrl(DEFAULT_CHAIN_ID) !== undefined
}
