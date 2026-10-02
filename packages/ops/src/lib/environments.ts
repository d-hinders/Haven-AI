/**
 * The environment registry (#3515, epic #3507).
 *
 * ONE env var — `NEXT_PUBLIC_OPS_ENVIRONMENTS` — holds JSON such as
 * `{"dev":"https://…"}`. Keys are environment labels; the key `prod` is
 * production. Origins must be `https`, except `localhost`. An environment
 * absent from the registry is not offered, so parsing drops invalid or
 * non-https entries rather than erroring on them — a registry with one bad
 * entry and one good one still works.
 *
 * A registry that cannot offer ANY environment (missing, unparseable, not an
 * object, or every entry dropped) is a config error the console must SHOW,
 * not silently run against nothing.
 *
 * Pure module: no window, no process. Callers pass the raw string, so tests
 * cover every branch without environment plumbing, and the middleware's
 * CSP takes its connect-src from the same parse, via `deploymentRegistry()`.
 */

export const PROD_ENV_KEY = 'prod'

export interface OpsEnvironment {
  /** Registry key, verbatim — the label the switcher shows. */
  key: string
  /** Backend origin, normalized through `URL.origin`. */
  origin: string
}

export interface EnvironmentRegistry {
  environments: OpsEnvironment[]
  /** Present when the registry cannot offer any environment at all. */
  error: string | null
}

/**
 * `localhost` may speak plain http (a local backend has no certificate).
 * `URL.hostname` brackets IPv6 literals, so both spellings are covered.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function originAllowed(url: URL): boolean {
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)
}

export function parseEnvironments(raw: string | undefined | null): EnvironmentRegistry {
  if (raw == null || raw.trim() === '') {
    return {
      environments: [],
      error:
        'NEXT_PUBLIC_OPS_ENVIRONMENTS is not set, so this console has no backend to talk to. Set it to JSON such as {"dev":"https://…"} and reload.',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      environments: [],
      error: 'NEXT_PUBLIC_OPS_ENVIRONMENTS is not valid JSON.',
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      environments: [],
      error:
        'NEXT_PUBLIC_OPS_ENVIRONMENTS must be a JSON object mapping environment names to backend origins.',
    }
  }
  const environments: OpsEnvironment[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const label = key.trim()
    if (label === '' || typeof value !== 'string') continue
    let url: URL
    try {
      url = new URL(value)
    } catch {
      continue
    }
    if (!originAllowed(url)) continue
    environments.push({ key: label, origin: url.origin })
  }
  if (environments.length === 0) {
    return {
      environments: [],
      error:
        'NEXT_PUBLIC_OPS_ENVIRONMENTS names no usable backend. Every entry must be an https origin (localhost may use http).',
    }
  }
  return { environments, error: null }
}

/** The Vercel Preview scope never contains prod (#3515). */
export function excludeProd(environments: OpsEnvironment[]): OpsEnvironment[] {
  return environments.filter((environment) => environment.key !== PROD_ENV_KEY)
}

/**
 * The environment the console opens on: `prod` when the registry offers it
 * (a founders' console mostly checks production), otherwise the first key.
 */
export function defaultEnvironment(environments: OpsEnvironment[]): string {
  const prod = environments.find((environment) => environment.key === PROD_ENV_KEY)
  return (prod ?? environments[0]).key
}
