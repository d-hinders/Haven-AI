import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import EnvBadge from '@/components/EnvBadge'

/**
 * The `DEV` chip reads the deployment through `lib/env.ts` (#2709). What this
 * pins is the behaviour that must not change with the refactor: nothing on
 * production — unset or spelled out — and the deployment's name otherwise.
 */
describe('EnvBadge (#2709)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['', 'production', 'prod'])('renders nothing on production (NEXT_PUBLIC_HAVEN_ENV=%j)', (value) => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', value)
    const { container } = render(<EnvBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the deployment name on a non-production build', () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'dev')
    const { getByText, getByTitle } = render(<EnvBadge />)
    expect(getByText('dev')).toBeInTheDocument()
    expect(getByTitle('Haven dev environment — not production')).toBeInTheDocument()
  })
})
