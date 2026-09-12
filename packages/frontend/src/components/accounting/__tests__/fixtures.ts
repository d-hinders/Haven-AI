/**
 * Shared shapes for the Settings → Accounting tests (#2868). Values are the
 * generated wire types, so a field the spec renames fails here at compile
 * time rather than rendering `undefined` somewhere a test does not look.
 */
import type { AccountingConnection, AccountingProvider } from '@/hooks/useAccounting'

export function provider(overrides: Partial<AccountingProvider> = {}): AccountingProvider {
  return {
    id: 'fortnox',
    displayName: 'Fortnox',
    authKind: 'oauth2',
    capabilities: { attachments: true, verify: true, revoke: true, companyInfo: true },
    availability: 'live',
    requiredScopes: ['bookkeeping', 'companyinformation', 'archive'],
    configured: true,
    ...overrides,
  }
}

export const COMING_SOON: AccountingProvider[] = [
  provider({ id: 'accounted', displayName: 'Accounted', availability: 'coming_soon', configured: false, requiredScopes: [] }),
  provider({ id: 'light', displayName: 'Light', availability: 'coming_soon', configured: false, requiredScopes: [] }),
  provider({ id: 'igdrasil', displayName: 'Igdrasil', availability: 'coming_soon', configured: false, requiredScopes: [] }),
]

export function connection(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    provider: 'fortnox',
    displayName: 'Fortnox',
    authKind: 'oauth2',
    status: 'connected',
    statusReason: null,
    isActiveDestination: true,
    feedFrom: '2026-09-01T08:00:00.000Z',
    grantedScope: 'bookkeeping companyinformation archive',
    missingScopes: [],
    tokenExpiresAt: '2026-09-12T08:00:00.000Z',
    externalCompanyId: '1234567',
    externalCompanyName: 'Ada Lovelace AB',
    baseCurrency: 'SEK',
    lastPushAt: '2026-09-10T14:30:00.000Z',
    lastError: null,
    connectedAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-10T14:30:00.000Z',
    settings: { suggestedAccount: null, autoFeed: true },
    ...overrides,
  }
}
