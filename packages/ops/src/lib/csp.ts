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
 * `connect-src` is exactly the registry origins (parsed by the same module the
 * app uses, so the header and the switcher cannot disagree). A registry with
 * no usable origin adds none: the console cannot talk anywhere, which is what
 * its config-error screen says.
 */
import { parseEnvironments } from './environments'

export function buildCsp({ nonce, registryRaw }: { nonce: string; registryRaw: string | undefined }): string {
  const connectSrc = parseEnvironments(registryRaw).environments.map((environment) => environment.origin)
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${connectSrc.join(' ')}`.trim(),
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
