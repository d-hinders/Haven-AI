/**
 * Ops console configuration (#3509, epic #3507).
 *
 * The ops console is a founders-only, read-only window onto this backend. It
 * is OFF unless every required variable below is set, and an unconfigured
 * backend answers every `/ops/*` request exactly like a route that does not
 * exist (`routes/ops.ts`). Dependency-free, like `boolean-flag.ts`, so the
 * parsers are testable without the module-level `config` object.
 *
 * Malformed values refuse the boot rather than degrading: a typo in the
 * allowlist or a redirect origin must never silently widen or narrow who can
 * sign in. Unset stays the quiet "ops disabled" state.
 */

export interface OpsConfig {
  /** GitHub OAuth App client id (`OPS_GITHUB_CLIENT_ID`). */
  githubClientId: string
  /** GitHub OAuth App client secret (`OPS_GITHUB_CLIENT_SECRET`). Never logged. */
  githubClientSecret: string
  /** HS256 secret for ops tokens and OAuth state (`OPS_JWT_SECRET`). Never logged. */
  jwtSecret: string
  /** Numeric GitHub user ids allowed to sign in (`OPS_ALLOWED_GITHUB_IDS`). */
  allowedGithubIds: readonly number[]
  /** Exact ops-app origins a sign-in may return to (`OPS_REDIRECT_ORIGINS`). */
  redirectOrigins: readonly string[]
  /**
   * This backend's own public origin (`OPS_PUBLIC_ORIGIN`). It is the ops
   * token's `iss`, and it builds the OAuth `redirect_uri`
   * (`<origin>/ops/auth/github/callback`), which must match the callback
   * registered on the GitHub OAuth App.
   */
  publicOrigin: string
}

/**
 * Parse `OPS_ALLOWED_GITHUB_IDS`: comma-separated positive integers. Matching
 * is on GitHub's immutable numeric id, never on a login name, because a login
 * can be renamed and then claimed by someone else.
 */
export function parseOpsAllowedGithubIds(raw: string | undefined | null): number[] {
  const value = (raw ?? '').trim()
  if (value === '') return []
  const ids: number[] = []
  for (const part of value.split(',')) {
    const entry = part.trim()
    if (!/^[1-9][0-9]{0,15}$/.test(entry) || !Number.isSafeInteger(Number(entry))) {
      throw new Error(
        `OPS_ALLOWED_GITHUB_IDS contains ${JSON.stringify(entry)}, which is not a numeric GitHub ` +
          'user id. Use the numeric "id" from https://api.github.com/users/<login>, never the login ' +
          'name. Refusing to start rather than guessing who may sign in to the ops console.',
      )
    }
    ids.push(Number(entry))
  }
  return [...new Set(ids)]
}

/**
 * An origin is `scheme://host[:port]` with nothing after it. `https` is
 * required except for `localhost`/`127.0.0.1`, where a developer runs the ops
 * app over plain http.
 */
export function parseOpsOrigin(name: string, raw: string): string {
  const entry = raw.trim()
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    throw new Error(`${name} contains ${JSON.stringify(entry)}, which is not a URL origin.`)
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const schemeOk = url.protocol === 'https:' || (isLocal && url.protocol === 'http:')
  // WHATWG URL keeps `*` in a hostname (`https://*.vercel.app` parses, and its
  // origin round-trips), so a wildcard has to be refused by character class.
  const hostOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)
  if (!schemeOk || !hostOk || url.origin !== entry) {
    throw new Error(
      `${name} contains ${JSON.stringify(entry)}, which is not an exact origin. Write ` +
        'scheme://host[:port] with no path, trailing slash or wildcard (https required except ' +
        'for localhost). Refusing to start: a loose origin would hand ops tokens to whoever ' +
        'controls the looser match.',
    )
  }
  return entry
}

/** Parse `OPS_REDIRECT_ORIGINS`: comma-separated exact origins. */
export function parseOpsRedirectOrigins(raw: string | undefined | null): string[] {
  const value = (raw ?? '').trim()
  if (value === '') return []
  return [...new Set(value.split(',').map((part) => parseOpsOrigin('OPS_REDIRECT_ORIGINS', part)))]
}

/**
 * Build the ops config from the environment, or refuse the boot when it is
 * dangerously wrong. `dashboardJwtSecret` is the backend's `JWT_SECRET`: an
 * equal `OPS_JWT_SECRET` would let one secret mint both kinds of token, so it
 * refuses outright rather than disabling quietly.
 */
export function parseOpsConfig(
  env: Record<string, string | undefined>,
  dashboardJwtSecret: string,
): OpsConfig {
  const jwtSecret = env.OPS_JWT_SECRET ?? ''
  if (jwtSecret !== '' && jwtSecret === dashboardJwtSecret) {
    throw new Error(
      'OPS_JWT_SECRET is equal to JWT_SECRET. Refusing to start: the ops console must sign its ' +
        'tokens with a secret of its own. Generate one with `openssl rand -base64 48`.',
    )
  }
  const rawPublicOrigin = (env.OPS_PUBLIC_ORIGIN ?? '').trim()
  return {
    githubClientId: (env.OPS_GITHUB_CLIENT_ID ?? '').trim(),
    githubClientSecret: env.OPS_GITHUB_CLIENT_SECRET ?? '',
    jwtSecret,
    allowedGithubIds: parseOpsAllowedGithubIds(env.OPS_ALLOWED_GITHUB_IDS),
    redirectOrigins: parseOpsRedirectOrigins(env.OPS_REDIRECT_ORIGINS),
    publicOrigin: rawPublicOrigin === '' ? '' : parseOpsOrigin('OPS_PUBLIC_ORIGIN', rawPublicOrigin),
  }
}

/** True only when every required piece is present; anything less is "ops off". */
export function isOpsConfigured(cfg: OpsConfig): boolean {
  return (
    cfg.githubClientId !== '' &&
    cfg.githubClientSecret !== '' &&
    cfg.jwtSecret !== '' &&
    cfg.allowedGithubIds.length > 0 &&
    cfg.redirectOrigins.length > 0 &&
    cfg.publicOrigin !== ''
  )
}
