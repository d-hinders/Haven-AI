import { describe, expect, it } from 'vitest'
import { merchantNameFromParts } from '../dashboard-summary'

/**
 * #4883: the dashboard cards name a merchant exactly as the transaction rows
 * do — the server's name first (#4882's one order), else the resource
 * HOSTNAME through the shared `parseX402Hostname`, so a port never splits one
 * merchant into two labels.
 */
describe('merchantNameFromParts (#4883)', () => {
  it('the server name wins over the resource host', () => {
    expect(merchantNameFromParts({ merchantName: 'NordShield VPN', x402ResourceUrl: 'https://api.nordshield.example/v1' })).toBe(
      'NordShield VPN',
    )
  })

  it('falls back to the hostname without the port, as the transaction rows do', () => {
    expect(merchantNameFromParts({ merchantName: null, x402ResourceUrl: 'https://api.nordshield.example:8443/v1' })).toBe(
      'api.nordshield.example',
    )
  })

  it('names nothing for an unparseable or absent URL', () => {
    expect(merchantNameFromParts({ merchantName: null, x402ResourceUrl: 'not a url' })).toBeNull()
    expect(merchantNameFromParts({ merchantName: null, x402ResourceUrl: null })).toBeNull()
  })
})
