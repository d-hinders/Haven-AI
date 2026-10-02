// @vitest-environment node
/**
 * The per-request CSP (#3581). The browser half (Next's inline scripts run,
 * an un-nonced inline script is still refused) needs a real build and a real
 * browser and is recorded in the PR; this pins the header the middleware
 * sends.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
// The parser app-render itself calls on the request's CSP header.
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header'
import { buildCsp, generateNonce } from '../lib/csp'
import { config, middleware } from '../middleware'

const DEV = 'https://havenbackend-dev.example'
const REGISTRY = JSON.stringify({ dev: DEV })

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/)
      return [name, sources] as const
    }),
  )
}

describe('buildCsp', () => {
  it('gates scripts on the nonce, with no unsafe-inline or unsafe-eval', () => {
    const csp = buildCsp({ nonce: 'abc123==', connectOrigins: [DEV] })
    expect(directives(csp).get('script-src')).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"])
    expect(csp).not.toContain('unsafe-eval')
    expect(directives(csp).get('script-src')).not.toContain("'unsafe-inline'")
  })

  it('keeps connect-src to self plus exactly the registry origins, and the #3515 directives', () => {
    const d = directives(buildCsp({ nonce: 'n', connectOrigins: [DEV] }))
    expect(d.get('connect-src')).toEqual(["'self'", DEV])
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'self'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('default-src')).toEqual(["'self'"])
  })

  it('no offered origin leaves connect-src at self', () => {
    expect(directives(buildCsp({ nonce: 'n', connectOrigins: [] })).get('connect-src')).toEqual(["'self'"])
  })

  it("only a development server adds 'unsafe-eval' (next dev evaluates its chunks)", () => {
    expect(directives(buildCsp({ nonce: 'n', connectOrigins: [], development: true })).get('script-src')).toContain(
      "'unsafe-eval'",
    )
    expect(buildCsp({ nonce: 'n', connectOrigins: [] })).not.toContain('unsafe-eval')
  })

  it('generateNonce is base64 of 16 bytes, and Next can read it back', () => {
    const nonce = generateNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    // Next's own parser (the one app-render calls) must recover it, or Next
    // stamps no nonce and every script is refused again.
    expect(getScriptNonceFromHeader(buildCsp({ nonce, connectOrigins: [DEV] }))).toBe(nonce)
  })
})

describe('middleware', () => {
  function run(registry = REGISTRY): { request: string | null; response: string | null } {
    process.env.NEXT_PUBLIC_OPS_ENVIRONMENTS = registry
    const res = middleware(new NextRequest('https://ops.example/'))
    // NextResponse.next({ request: { headers } }) encodes the overridden
    // request headers as x-middleware-request-* on the response.
    return {
      request: res.headers.get('x-middleware-request-content-security-policy'),
      response: res.headers.get('Content-Security-Policy'),
    }
  }

  it('sets the same policy on the request (for Next) and on the response (for the browser)', () => {
    const { request, response } = run()
    expect(response).toBeTruthy()
    expect(request).toBe(response)
    expect(response).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic'/)
    expect(response).toContain(`connect-src 'self' ${DEV}`)
  })

  it('on a preview deployment, connect-src leaves out the prod origin, as the switcher does', () => {
    const prod = 'https://havenbackend-prod.example'
    const previous = process.env.VERCEL_ENV
    process.env.VERCEL_ENV = 'preview'
    try {
      const csp = run(JSON.stringify({ dev: DEV, prod })).response ?? ''
      expect(csp).toContain(`connect-src 'self' ${DEV}`)
      expect(csp).not.toContain(prod)
    } finally {
      if (previous === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = previous
    }
  })

  it('issues a fresh nonce per request', () => {
    const nonceOf = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1]
    const a = nonceOf(run().response)
    const b = nonceOf(run().response)
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('runs on pages and skips static build assets', () => {
    const [pattern] = config.matcher
    const re = new RegExp(`^${pattern}$`)
    expect(re.test('/')).toBe(true)
    expect(re.test('/users/abc')).toBe(true)
    expect(re.test('/_next/static/chunks/main.js')).toBe(false)
  })
})

describe('exactly one CSP source (#3581)', () => {
  it('next.config.ts sets no Content-Security-Policy: the browser would enforce both', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'next.config.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/Content-Security-Policy/i)
    expect(source).toContain("'X-Frame-Options'")
    expect(source).toContain("'X-Robots-Tag'")
  })

  it('vercel.json sets no Content-Security-Policy either', () => {
    const vercel = readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8')
    expect(vercel).not.toMatch(/Content-Security-Policy/i)
  })
})

describe('the root layout renders per request (#3581)', () => {
  // Measured in a real build: without this export Next prerenders `/` as
  // static, the HTML carries no nonce, and the browser refuses every script
  // again (blank page, 13 CSP errors). A literal check, because only a
  // browser can prove the consequence; the PR records that proof.
  it('layout.tsx exports dynamic = force-dynamic', () => {
    const layout = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8')
    expect(layout).toMatch(/^export const dynamic = 'force-dynamic'$/m)
  })
})
