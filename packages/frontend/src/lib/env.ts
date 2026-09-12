/**
 * Which Haven deployment this build is — the ONE reading of
 * `NEXT_PUBLIC_HAVEN_ENV` (#2709).
 *
 * The variable is build-time inlined and, by convention, production leaves it
 * UNSET: the dev Vercel project sets `dev`, nothing sets `production`
 * (`docs/operations/dev-environment.md`). Three readers used to interpret that
 * convention separately — the `DEV` badge, the `?apiBaseUrl` override gate and
 * the capability manifest — and the manifest got it wrong: it reported
 * `"unknown"` on production, the one deployment where an agent most needs the
 * answer, because it read the raw variable instead of the convention.
 *
 * So the convention lives here, once. Unset, empty, `production` and `prod`
 * all mean production; anything else is that deployment's own name (`dev`),
 * lower-cased so callers compare against one spelling.
 *
 * Reference `process.env.NEXT_PUBLIC_HAVEN_ENV` LITERALLY, as the default
 * argument does: Next inlines only that exact member expression into client
 * bundles, so a helper that reads `process.env[name]` would see `undefined` on
 * every client render and call every deployment production.
 */

export const PRODUCTION_ENVIRONMENT = 'production'

/**
 * The deployment's environment name: `production`, or the value the build set
 * (`dev`), lower-cased and trimmed.
 */
export function havenEnvironment(raw: string | undefined = process.env.NEXT_PUBLIC_HAVEN_ENV): string {
  const value = raw?.trim().toLowerCase()
  if (!value || value === PRODUCTION_ENVIRONMENT || value === 'prod') return PRODUCTION_ENVIRONMENT
  return value
}

/** True on the production deployment — including the conventional unset case. */
export function isProductionEnvironment(raw: string | undefined = process.env.NEXT_PUBLIC_HAVEN_ENV): boolean {
  return havenEnvironment(raw) === PRODUCTION_ENVIRONMENT
}
