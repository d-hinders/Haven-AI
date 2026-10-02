/**
 * The console's Content-Security-Policy (#3515, made per-request by #3581).
 *
 * The pages render customer-controlled strings and ops tokens live 8 h in
 * sessionStorage, so the policy is ENFORCING and scripts are nonce-gated.
 * A static `script-src 'self'` (the #3515 form) cannot work with the App
 * Router: Next delivers its bootstrap and RSC payload as inline scripts, the
 * browser refused every one, and the console rendered a blank page (#3581).
 *
 * The middleware (`src/middleware.ts`) builds this once per request with a
 * fresh nonce and sets it on the request too: Next reads the request's
 * `content-security-policy` header and stamps that nonce on its own scripts.
 * `'strict-dynamic'` lets those nonced scripts load the app's chunks;
 * `'self'` is only the fallback for browsers without CSP level 3. There is
 * deliberately no `'unsafe-inline'` and no `'unsafe-eval'`.
 *
 * `connect-src` is exactly the origins this deployment offers: the caller
 * passes `deploymentRegistry()`'s list, the one the switcher shows, so a
 * preview deployment's policy leaves out the prod origin just as its UI does.
 * A config-error registry offers none, giving `connect-src 'self'`: the
 * console cannot talk anywhere, which is what its config-error screen says.
 *
 * `next dev` evaluates its chunks with `eval`, so a development server adds
 * `'unsafe-eval'`. Production never does.
 */
export function buildCsp({
  nonce,
  connectOrigins,
  development = false,
}: {
  nonce: string
  connectOrigins: string[]
  development?: boolean
}): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])]
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${connectOrigins.join(' ')}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/**
 * A fresh nonce: 16 random bytes, base64. Web Crypto, because the middleware
 * runs on the edge runtime, where `node:crypto` is not available.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
