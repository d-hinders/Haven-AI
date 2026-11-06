/**
 * #4720 (epic #4718): the ops health page names the passport half-configured
 * state — issuance on, verifier off — instead of leaving it inside the raw
 * `/health/ops` JSON. Both arms: a chain in `unverifiableChainIds` renders the
 * warning naming it; an empty list renders nothing at all.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PassportReadinessWarning } from '../components/health/PassportReadinessWarning'

const base = {
  verification: { configured: false, issuer: null },
  chains: [{ chainId: 84532, issuanceConfigured: true, verificationConfigured: false, state: 'issuance_only' as const }],
  unverifiableChainIds: [84532],
}

describe('PassportReadinessWarning', () => {
  it('names each chain that issues passports no merchant can verify', () => {
    render(<PassportReadinessWarning passport={base} />)
    expect(screen.getByText('Passports no merchant can verify')).toBeInTheDocument()
    expect(screen.getByText('1 chain')).toBeInTheDocument()
    expect(screen.getByText('(84532)')).toBeInTheDocument()
    expect(screen.getByText(/PASSPORT_RECEIPT_SIGNING_KEY/)).toBeInTheDocument()
  })

  it('renders nothing when every passport chain is ready or unconfigured', () => {
    const { container } = render(
      <PassportReadinessWarning
        passport={{
          ...base,
          verification: { configured: true, issuer: '0x' + '11'.repeat(20) },
          chains: [{ ...base.chains[0], verificationConfigured: true, state: 'ready' }],
          unverifiableChainIds: [],
        }}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the diagnostics carry no passport block', () => {
    const { container } = render(<PassportReadinessWarning passport={undefined} />)
    expect(container.innerHTML).toBe('')
  })
})
