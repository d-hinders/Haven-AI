/**
 * Read the expiry out of the stored session JWT (#2525).
 *
 * `whoami --json` and `login --json` report when the session dies, and the
 * only place that fact exists is the token's own `exp` claim — the backend
 * signs it with `expiresIn: '7d'` (`routes/auth.ts`) and `/auth/me` does not
 * return it. So the payload segment is base64url-decoded and read.
 *
 * This deliberately does NOT verify the signature, and must never be used to
 * decide anything but what to print: the CLI has no key to verify with, and a
 * forged `exp` would only mislead the user about a token the backend will
 * reject on its own terms. It never logs, echoes or returns the token itself.
 */
export function sessionExpiry(token: string): string | null {
  const segment = token.split('.')[1]
  if (!segment) return null
  try {
    const json = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json) as { exp?: unknown }
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null
    return new Date(claims.exp * 1000).toISOString()
  } catch {
    // A token we cannot read is not an error worth failing a command over —
    // the expiry is informational, and every other field still resolves.
    return null
  }
}
