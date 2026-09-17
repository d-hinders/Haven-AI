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
})
