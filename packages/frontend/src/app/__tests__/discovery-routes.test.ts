import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as robotsGET, dynamic as robotsDynamic } from '@/app/robots.txt/route'
import { GET as sitemapGET, dynamic as sitemapDynamic } from '@/app/sitemap.xml/route'
import { AUTHENTICATED_PREFIXES, PUBLIC_SURFACES } from '@/lib/discovery-surfaces'

/**
 * The wiring, not the builders (#2521).
 *
 * `discovery-surfaces.test.ts` proves `buildRobotsTxt` / `buildSitemapXml` /
 * `originFrom` are correct in isolation. Nothing there invokes the two route
 * handlers, so a route that hardcoded its body, dropped `force-dynamic`, or
 * answered with the wrong content type would keep the suite green and be caught
 * only by curling a running server. These tests call the handlers.
 */
function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request(url, { headers }))
}

describe('/robots.txt route handler', () => {
  it('is dynamic — a build-time snapshot would freeze one origin into every deployment', () => {
    expect(robotsDynamic).toBe('force-dynamic')
  })

  it('serves text/plain built from the request origin', async () => {
    const response = robotsGET(request('https://haven.example/robots.txt'))
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const body = await response.text()
    expect(body).toContain('User-agent: *')
    expect(body).toContain('Sitemap: https://haven.example/sitemap.xml')
  })

  it('honours the forwarded host, so a proxied deployment advertises its public origin', async () => {
    const body = await robotsGET(
      request('http://internal:3000/robots.txt', {
        'x-forwarded-host': 'preview.example',
        'x-forwarded-proto': 'https',
      }),
    ).text()
    expect(body).toContain('Sitemap: https://preview.example/sitemap.xml')
  })

  it('is not shared-cacheable, because the body follows a client-supplied header', () => {
    const response = robotsGET(request('https://haven.example/robots.txt'))
    const cacheControl = response.headers.get('cache-control') ?? ''
    expect(cacheControl).not.toMatch(/s-maxage=[1-9]/)
    // `max-age=0` alone only makes the response stale; `must-revalidate` is what
    // forbids a shared cache serving that stale copy on. Asserted separately so
    // dropping it is a failure rather than a silent reopening of the window.
    expect(cacheControl).toContain('must-revalidate')
    expect(response.headers.get('vary')).toContain('x-forwarded-host')
  })

  it('disallows every authenticated prefix', async () => {
    const body = await robotsGET(request('https://haven.example/robots.txt')).text()
    for (const prefix of AUTHENTICATED_PREFIXES) {
      expect(body).toContain(`Disallow: ${prefix}`)
    }
  })
})

describe('/sitemap.xml route handler', () => {
  it('is dynamic', () => {
    expect(sitemapDynamic).toBe('force-dynamic')
  })

  it('serves XML listing every public surface against the request origin', async () => {
    const response = sitemapGET(request('https://haven.example/sitemap.xml'))
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    const body = await response.text()
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    for (const surface of PUBLIC_SURFACES) {
      expect(body).toContain(`<loc>https://haven.example${surface}</loc>`)
    }
  })

  it('leaks no authenticated route into the crawlable set', async () => {
    const body = await sitemapGET(request('https://haven.example/sitemap.xml')).text()
    for (const prefix of AUTHENTICATED_PREFIXES) {
      expect(body).not.toContain(`<loc>https://haven.example${prefix}`)
    }
  })

  it('is not shared-cacheable', () => {
    const response = sitemapGET(request('https://haven.example/sitemap.xml'))
    const cacheControl = response.headers.get('cache-control') ?? ''
    expect(cacheControl).not.toMatch(/s-maxage=[1-9]/)
    expect(cacheControl).toContain('must-revalidate')
  })
})
