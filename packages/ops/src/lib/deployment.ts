/**
 * The registry THIS deployment offers (#3515).
 *
 * Server-side only — `layout.tsx` calls it once and hands the plain result to
 * the client provider, so the client never re-derives the registry and a
 * server-side prod exclusion cannot hydration-mismatch against a client that
 * did not exclude it.
 *
 * The Preview rule lives HERE rather than in the client because Vercel sets
 * `VERCEL_ENV` on the server; a build-time-inlined `NEXT_PUBLIC_*` mirror
 * would be a second source of truth that could disagree with the deployed
 * scope.
 */
import {
  excludeProd,
  parseEnvironments,
  PROD_ENV_KEY,
  type EnvironmentRegistry,
} from './environments'

/** Vercel sets VERCEL_ENV to `production`, `preview` or `development`. */
export function isPreviewDeployment(): boolean {
  return process.env.VERCEL_ENV === 'preview'
}

export function deploymentRegistry(): EnvironmentRegistry {
  const registry = parseEnvironments(process.env.NEXT_PUBLIC_OPS_ENVIRONMENTS)
  if (registry.error) return registry
  const environments = isPreviewDeployment() ? excludeProd(registry.environments) : registry.environments
  if (environments.length === 0) {
    return {
      environments: [],
      error: `"${PROD_ENV_KEY}" is not offered on preview deployments, and the registry names no other environment.`,
    }
  }
  return { environments, error: null }
}
