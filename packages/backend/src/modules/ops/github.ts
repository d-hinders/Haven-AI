/**
 * GitHub OAuth for the ops console (#3509).
 *
 * The authorization-code flow requests NO scopes: the backend needs only the
 * caller's numeric id (and, when GitHub reports it, their 2FA status) from
 * `GET /user`. The access token is used for that one call and then dropped —
 * it is never stored, returned or logged.
 */

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'
export const GITHUB_TIMEOUT_MS = 15_000

export interface GithubUser {
  id: number
  login: string
  /** Absent when GitHub does not report it for the token's scopes. */
  twoFactorAuthentication?: boolean
}

export class GithubOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubOAuthError'
  }
}

/** The authorize URL a sign-in starts at. `allow_signup=false`: no account creation detour. */
export function githubAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GITHUB_AUTHORIZE_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  url.searchParams.set('allow_signup', 'false')
  return url.toString()
}

/** Exchange an authorization code for an access token. */
export async function exchangeGithubCode(
  params: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof fetch,
): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
  } catch {
    throw new GithubOAuthError('Could not reach GitHub to exchange the sign-in code')
  }
  if (!res.ok) throw new GithubOAuthError(`GitHub refused the code exchange (HTTP ${res.status})`)
  // GitHub answers a bad or reused code with HTTP 200 and an `error` field.
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null
  if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
    const code = typeof body?.error === 'string' ? body.error : 'no_access_token'
    throw new GithubOAuthError(`GitHub refused the code exchange (${code})`)
  }
  return body.access_token
}

/** Read the signed-in GitHub user. */
export async function fetchGithubUser(accessToken: string, fetchImpl: typeof fetch): Promise<GithubUser> {
  let res: Response
  try {
    res = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'haven-ops',
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
  } catch {
    throw new GithubOAuthError('Could not reach GitHub to read the signed-in user')
  }
  if (!res.ok) throw new GithubOAuthError(`GitHub refused the user read (HTTP ${res.status})`)
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || typeof body.login !== 'string') {
    throw new GithubOAuthError('GitHub returned an unreadable user')
  }
  const tfa = body.two_factor_authentication
  return {
    id: body.id,
    login: body.login,
    ...(typeof tfa === 'boolean' ? { twoFactorAuthentication: tfa } : {}),
  }
}
