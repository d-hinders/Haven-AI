import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForAgentsPage } from '@/components/marketing/site/for-agents/ForAgentsPage'
import { DevelopersPage } from '@/components/marketing/site/developers/DevelopersPage'
import { PUBLIC_SURFACES } from '@/lib/discovery-surfaces'

/**
 * The two routes' gate wiring (#3577, epic #3572) — the same shape
 * `how-it-works-pages.test.tsx` pins for `/how-it-works/protocols`: each
 * route exists only where the build-time site gate is on and calls
 * `notFound()` with it off, and neither is advertised in `PUBLIC_SURFACES`.
 *
 * The route components are called DIRECTLY — a route component is a
 * function, and no React render is needed to prove where the gate sends it
 * (the protocols gate test in `how-it-works-pages.test.tsx` works the same
 * way; rendering a component that throws mid-render is what made the first
 * draft of this test flaky).
 */

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: () => notFound(),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  notFound.mockClear()
  cleanup()
})

describe.each([
  ['/developers', () => import('@/app/developers/page')],
  ['/for-agents', () => import('@/app/for-agents/page')],
] as const)('%s route gate', (route, load) => {
  it('renders the new page with the gate on', async () => {
    const { default: Route } = await load()
    vi.stubEnv('NEXT_PUBLIC_HAVEN_SITE_PREVIEW', '1')
    const element = Route()
    expect(element).not.toBeNull()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('404s with the gate off (unit-test default: production)', async () => {
    const { default: Route } = await load()
    // Unit tests run with the gate off: no environment name counts as
    // production, so the route calls notFound() — exactly what Next turns
    // into a 404.
    expect(() => Route()).toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it('is not advertised as a public surface', () => {
    const surfaces: readonly string[] = PUBLIC_SURFACES
    expect(surfaces, `${route} must not be in PUBLIC_SURFACES until the switch-over`).not.toContain(route)
  })
})

describe('For agents page body', () => {
  it('prominently links the canonical runbook', () => {
    render(<ForAgentsPage />)
    // The hero link: the runbook is the page's canonical artifact.
    expect(screen.getAllByRole('link', { name: '/for-agents.md' }).length).toBeGreaterThan(0)
    // The closing band's primary CTA.
    expect(screen.getByRole('link', { name: 'Open /for-agents.md' })).toHaveAttribute(
      'href',
      '/for-agents.md',
    )
  })
})

describe('Developers page body', () => {
  it('links its ghost CTA to the For agents page, as the mockup closes', () => {
    render(<DevelopersPage />)
    expect(screen.getByRole('link', { name: 'Read it as an agent' })).toHaveAttribute(
      'href',
      '/for-agents',
    )
  })
})
