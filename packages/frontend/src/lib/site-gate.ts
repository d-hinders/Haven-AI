import { isProductionEnvironment } from '@/lib/env'

/**
 * Whether this build renders the redesigned public site (epic #3572, #3573).
 *
 * The new site is built in slices while `dev` is promoted to `main` often, so
 * a half-built site would otherwise reach production. Until the switch-over
 * slice removes this gate, it is ON outside production and OFF in production,
 * and with it off every public route renders what it rendered before the
 * epic. `NEXT_PUBLIC_HAVEN_SITE_PREVIEW=1` turns it on in a build that is
 * otherwise production-shaped — the CI build the e2e and visual suites run
 * against, which sets no environment name. No deployment sets it.
 *
 * **Build-time on purpose, unlike the `/demo` gate.** `lib/demo-gate.ts` is
 * server-only and read per request because it guards a page that hands out
 * test funds, and a request-time answer is what keeps it out of every client
 * bundle. This gate guards presentation only, and three of its readers are
 * client components (`SiteHeader`, and later `/login` and `/signup`). A pure,
 * synchronous function over inlined `NEXT_PUBLIC_` values answers the same in
 * a server and a client render, and makes no page dynamic: `/`,
 * `/how-it-works`, `/login` and `/signup` stay statically rendered.
 *
 * Both variables are referenced LITERALLY in the default arguments: Next
 * inlines only that exact member expression into client bundles (the rule
 * `lib/env.ts` states for `NEXT_PUBLIC_HAVEN_ENV`).
 */
export function isNewSiteVisible(
  environment: string | undefined = process.env.NEXT_PUBLIC_HAVEN_ENV,
  preview: string | undefined = process.env.NEXT_PUBLIC_HAVEN_SITE_PREVIEW,
): boolean {
  return !isProductionEnvironment(environment) || preview === '1'
}
