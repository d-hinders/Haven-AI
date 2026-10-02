/**
 * Typography and the sign-in CTA (#3584).
 *
 * - The root layout loads Inter through `next/font/google` and applies it on
 *   `<body>`, as the dashboard does. Read from source: the layout is a server
 *   component whose `next/font` call only resolves inside a Next build.
 * - The sign-in button renders at `size="lg"` (44 px painted). jsdom cannot
 *   measure paint, so this pins the size class; the 390 px capture in the PR
 *   measures `getBoundingClientRect().height`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SignInView } from '../components/SignInView'

vi.mock('../components/OpsClientRoot', () => ({
  useOpsSessionContext: () => ({}),
}))

const LAYOUT = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8')

describe('ops typography (#3584)', () => {
  it('loads Inter from next/font/google', () => {
    expect(LAYOUT).toMatch(/import \{ Inter \} from 'next\/font\/google'/)
    expect(LAYOUT).toMatch(/const inter = Inter\(\{ subsets: \['latin'\] \}\)/)
  })

  it('applies it on <body>, with the dashboard’s antialiasing', () => {
    expect(LAYOUT).toMatch(/<body className=\{`\$\{inter\.className\} antialiased`\}>/)
  })
})

describe('sign-in CTA (#3584)', () => {
  it('renders at the 44 px lg size', () => {
    render(
      <SignInView
        environments={[{ key: 'dev', origin: 'https://havenbackend-dev.example' }]}
        storage={window.sessionStorage}
        error={null}
      />,
    )
    const button = screen.getByRole('button', { name: 'Continue with GitHub' })
    expect(button.className).toContain('h-11')
    expect(button.className).not.toContain('h-10')
  })
})
