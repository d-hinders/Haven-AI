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
 * deployed bundle. Neither Vercel project's env configuration sets it, and
 * `docs/operations/dev-environment.md`'s "`HAVEN_DEMO_PAGE_VISIBLE`" section
 * says never to (nothing asks it to; it exists only for the visual-regression
 * Playwright server, which otherwise builds exactly like production — no
 * `NEXT_PUBLIC_HAVEN_ENV`, see `playwright.config.ts` — and would 404 the
 * page it needs to screenshot).
 *
 * The override ALSO ignores itself whenever `process.env.VERCEL` is set —
 * Vercel sets that on every build in every one of its own environments, so
 * this is a second, code-level door shut on the same thing the doc asks
 * humans not to do: even a `HAVEN_DEMO_PAGE_VISIBLE` accidentally left in a
 * Vercel project's env vars does nothing on a Vercel deployment. Playwright's
 * own server runs outside Vercel (GitHub Actions or a local machine), so this
 * never blocks the one caller that needs the override.
 */
export function isDemoPageVisible(): boolean {
  if (process.env.HAVEN_DEMO_PAGE_VISIBLE === '1' && !process.env.VERCEL) return true
  if (isProductionEnvironment()) return false
  return getFaucetUrl(DEFAULT_CHAIN_ID) !== undefined
}
