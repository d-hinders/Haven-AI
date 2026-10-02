/**
 * Per-request Content-Security-Policy (#3581). See `lib/csp.ts` for the
 * policy and why it is nonce-based.
 *
 * The policy goes on the REQUEST as well as the response: Next 15 reads the
 * request's `content-security-policy` header during render
 * (`getScriptNonceFromHeader`) and stamps that nonce on every script it
 * emits. The root layout opts into dynamic rendering so each response carries
 * its own nonce; a prerendered page would bake one nonce into every response.
 *
 * The other hardening headers (#3515) stay static in `next.config.ts`; only
 * the CSP lives here, so a response carries exactly one.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { buildCsp, generateNonce } from './lib/csp'

export function middleware(request: NextRequest): NextResponse {
  const csp = buildCsp({ nonce: generateNonce(), registryRaw: process.env.NEXT_PUBLIC_OPS_ENVIRONMENTS })
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('content-security-policy', csp)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  // Every page and RSC request. Static build assets carry no inline script
  // and are served without running middleware.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
