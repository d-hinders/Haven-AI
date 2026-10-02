/**
 * The prod banner and the console shell, under test (#3515).
 *
 * The banner shows if and only if `prod` is selected — driven by the
 * selected key, so the wrong-environment failure mode is a wrong key, not a
 * wrong hostname.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProdBanner } from '../components/ProdBanner'
import { EnvSwitcher } from '../components/EnvSwitcher'

describe('ProdBanner', () => {
  it('shows when prod is selected', () => {
    render(<ProdBanner selectedKey="prod" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('prod-banner')).toBeInTheDocument()
  })

  it('does not show when any other environment is selected', () => {
    for (const key of ['dev', 'staging', 'localhost', '']) {
      const { unmount } = render(<ProdBanner selectedKey={key} />)
      expect(screen.queryByTestId('prod-banner')).not.toBeInTheDocument()
      unmount()
    }
  })
})

describe('EnvSwitcher', () => {
  it('offers exactly the registry environments', () => {
    render(
      <EnvSwitcher
        environments={[
          { key: 'dev', origin: 'https://api.dev.example' },
          { key: 'prod', origin: 'https://api.example' },
        ]}
        selectedKey="dev"
        onSelect={() => {}}
      />,
    )
    const group = screen.getByRole('radiogroup', { name: 'Environment' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'dev' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'prod' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'dev' })).toHaveAttribute('aria-checked', 'true')
  })

  it('does not offer an environment absent from the registry', () => {
    render(
      <EnvSwitcher
        environments={[{ key: 'dev', origin: 'https://api.dev.example' }]}
        selectedKey="dev"
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByRole('radio', { name: 'prod' })).not.toBeInTheDocument()
  })
})
