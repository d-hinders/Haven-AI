import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForAgentsPage } from '@/components/marketing/site/for-agents/ForAgentsPage'
import { DevelopersPage } from '@/components/marketing/site/developers/DevelopersPage'
import { PUBLIC_SURFACES } from '@/lib/discovery-surfaces'

/**
 * The two routes (#3577, epic #3572), public since the switch-over (#3579):
 * each renders its page unconditionally — no `notFound()` path is left — and
 * is advertised in `PUBLIC_SURFACES`, so the sitemap lists it.
 *
 * The route components are called DIRECTLY — a route component is a
 * function, and no React render is needed to prove what it returns.
 */

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: () => notFound(),
}))

afterEach(() => {
  notFound.mockClear()
  cleanup()
})

describe.each([
  ['/developers', () => import('@/app/developers/page')],
  ['/for-agents', () => import('@/app/for-agents/page')],
] as const)('%s route', (route, load) => {
  it('renders its page in a production-shaped build (unit-test default)', async () => {
    const { default: Route } = await load()
    const element = Route()
    expect(element).not.toBeNull()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('is advertised as a public surface', () => {
    const surfaces: readonly string[] = PUBLIC_SURFACES
    expect(surfaces).toContain(route)
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
