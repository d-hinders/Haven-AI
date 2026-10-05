import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { describe, expect, it } from 'vitest'

/**
 * `next.config.ts`'s `redirects()` (#3024).
 *
 * The custody route is deleted outright rather than kept on disk as a
 * redirect page (the `/reporting` precedent) — there is no directory left
 * for `AUTH_MARKED_PREFIXES`'s filesystem-pinned list to see, so the redirect
 * has to live in config instead, and nothing else in this repo asserts that
 * `next build` actually wires it. Read directly rather than through Next's
 * `phase` machinery: `nextConfig` is the plain object the default export
 * returns unconditionally, so importing the module and inspecting its
 * `redirects()` is the same contract `next build`/`next start` consult.
 */
describe('next.config redirects (#3024)', () => {
  // `phase-test` is deliberately NOT one of `GENERATING_PHASES` (production
  // build / dev server) — those trigger the served-docs generator as a side
  // effect, which is real filesystem work this test has no reason to pay for.
  const PHASE = 'phase-test'

  it('answers a permanent redirect from /custody to /accounts', async () => {
    const config = (await import('../../../next.config')).default
    const redirects = await config(PHASE as never).redirects!()
    const custody = redirects.find((r) => r.source === '/custody')
    expect(custody, 'no /custody redirect entry in next.config.ts').toBeDefined()
    expect(custody).toMatchObject({ source: '/custody', destination: '/accounts', permanent: true })
  })

  it('positive control: a route with no redirect entry is not found', async () => {
    const config = (await import('../../../next.config')).default
    const redirects = await config(PHASE as never).redirects!()
    expect(redirects.find((r) => r.source === '/not-a-real-route')).toBeUndefined()
  })

  // #3079: /catalog is renamed Marketplace. Two entries — a bare `/catalog`
  // and a `:path*` form — so a deep link (`/catalog/ampersend-demo-api`,
  // `/catalog?category=x`) redirects too, not just the bare route.
  it('answers a permanent redirect from /catalog to /marketplace', async () => {
    const config = (await import('../../../next.config')).default
    const redirects = await config(PHASE as never).redirects!()
    const catalog = redirects.find((r) => r.source === '/catalog')
    expect(catalog, 'no /catalog redirect entry in next.config.ts').toBeDefined()
    expect(catalog).toMatchObject({ source: '/catalog', destination: '/marketplace', permanent: true })
  })

  it('answers a permanent redirect from any /catalog/* deep link to the same path under /marketplace', async () => {
    const config = (await import('../../../next.config')).default
    const redirects = await config(PHASE as never).redirects!()
    const catalogDeepLink = redirects.find((r) => r.source === '/catalog/:path*')
    expect(catalogDeepLink, 'no /catalog/:path* redirect entry in next.config.ts').toBeDefined()
    expect(catalogDeepLink).toMatchObject({
      source: '/catalog/:path*',
      destination: '/marketplace/:path*',
      permanent: true,
    })
  })

  // #3579: the protocol pages retired with the site switch-over.
  it.each(['/protocols', '/protocols/x402', '/protocols/mpp'])(
    'answers a permanent redirect from %s to /how-it-works/protocols',
    async (source) => {
      const config = (await import('../../../next.config')).default
      const redirects = await config(PHASE as never).redirects!()
      expect(redirects.find((r) => r.source === source)).toMatchObject({
        source,
        destination: '/how-it-works/protocols',
        permanent: true,
      })
    },
  )

  it('sends /demo/x402 to /how-it-works/protocols in one hop', async () => {
    const config = (await import('../../../next.config')).default
    const redirects = await config(PHASE as never).redirects!()
    const demoX402 = redirects.find((r) => r.source === '/demo/x402')
    expect(demoX402).toMatchObject({ destination: '/how-it-works/protocols', permanent: true })
    // One hop: the destination is not itself a redirect source.
    expect(redirects.find((r) => r.source === demoX402!.destination)).toBeUndefined()
  })

  it('leaves /demo and /demo.md alone: no redirect rule matches either', async () => {
    const config = (await import('../../../next.config')).default
    const redirects = await config(PHASE as never).redirects!()
    // Next's OWN matcher (the one its router applies to `redirects()`), not a
    // hand-rolled regex: a `/demo/:path*` source matches `/demo` itself, which
    // an approximation of path-to-regexp gets wrong (haven-reviewer, #3579).
    const matches = (source: string, path: string) =>
      getPathMatch(source, { removeUnnamedParams: true, strict: true })(path) !== false
    for (const path of ['/demo', '/demo.md']) {
      const matching = redirects.filter((r) => matches(r.source, path))
      expect(matching, `${path} matched ${matching.map((r) => r.source).join(', ')}`).toEqual([])
    }
    // Positive controls: the matcher finds the real /demo/x402 rule, and a
    // catch-all under /demo — the likeliest regression — would match /demo.
    expect(redirects.filter((r) => matches(r.source, '/demo/x402'))).toHaveLength(1)
    expect(matches('/demo/:path*', '/demo')).toBe(true)
    expect(matches('/demo(.*)', '/demo.md')).toBe(true)
  })

})
