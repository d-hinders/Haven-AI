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
})
