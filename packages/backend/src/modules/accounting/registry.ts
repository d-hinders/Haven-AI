/**
 * Accounting provider registry (#2862, epic #2858).
 *
 * The list of providers Haven knows about, as descriptors (`provider.ts`).
 * Owner decision 2026-09-11: Accounted, Light and Igdrasil are LISTED now as
 * *Coming soon* — listing is a product decision, and the dashboard shows
 * them before any code for them exists. Only a `live` provider accepts a
 * connect; the generic routes enforce that through `assertConnectable`.
 *
 * `registerConnector` (connector.ts) is the OTHER registry — the instances
 * that actually talk to a provider. A provider can be listed here without an
 * instance (coming soon), and an instance can be registered only when its
 * descriptor exists here; `connectorFor` joins the two.
 *
 * Adding a provider: `README.md` in this directory.
 */

import { getConnector, type AccountingConnector } from './connector.js'
import type { AccountingProvider, ProviderAvailability } from './provider.js'
import { FORTNOX_SCOPE } from './fortnox.js'

export const FORTNOX: AccountingProvider = {
  id: 'fortnox',
  displayName: 'Fortnox',
  authKind: 'oauth2',
  // `revoke` (#2863): disconnect posts the refresh token to Fortnox's
  // `/oauth-v1/revoke` (RFC 7009) before clearing the stored secrets, so a
  // grant Haven no longer holds is also one Fortnox no longer honours. A
  // failed revoke still disconnects locally (`connections.ts`).
  capabilities: { attachments: true, verify: true, revoke: true, companyInfo: true },
  availability: 'live',
  requiredScopes: FORTNOX_SCOPE.split(' '),
}

const COMING_SOON_CAPABILITIES = { attachments: false, verify: false, revoke: false, companyInfo: false }

export const ACCOUNTED: AccountingProvider = {
  id: 'accounted',
  displayName: 'Accounted',
  authKind: 'oauth2',
  capabilities: COMING_SOON_CAPABILITIES,
  availability: 'coming_soon',
  requiredScopes: [],
}

export const LIGHT: AccountingProvider = {
  id: 'light',
  displayName: 'Light',
  authKind: 'api_key',
  capabilities: COMING_SOON_CAPABILITIES,
  availability: 'coming_soon',
  requiredScopes: [],
}

export const IGDRASIL: AccountingProvider = {
  id: 'igdrasil',
  displayName: 'Igdrasil',
  authKind: 'oauth2',
  capabilities: COMING_SOON_CAPABILITIES,
  availability: 'coming_soon',
  requiredScopes: [],
}

/** Display order: live first, then coming soon in product order. */
const PROVIDERS: readonly AccountingProvider[] = [FORTNOX, ACCOUNTED, LIGHT, IGDRASIL]

/**
 * Test-only descriptors (the in-memory connector's, in the conformance suite).
 * Never populated at runtime — `src/index.ts` registers connector INSTANCES,
 * not descriptors, and the four above are the whole product list.
 */
const testProviders = new Map<string, AccountingProvider>()

export function registerTestProvider(provider: AccountingProvider): void {
  testProviders.set(provider.id, provider)
}

export function clearTestProviders(): void {
  testProviders.clear()
}

export function listProviders(): readonly AccountingProvider[] {
  return testProviders.size === 0 ? PROVIDERS : [...PROVIDERS, ...testProviders.values()]
}

export function getProvider(id: string): AccountingProvider | undefined {
  return PROVIDERS.find((p) => p.id === id) ?? testProviders.get(id)
}

export function providerAvailability(id: string): ProviderAvailability | undefined {
  return getProvider(id)?.availability
}

export class ProviderNotConnectableError extends Error {
  readonly code: 'UNKNOWN_PROVIDER' | 'PROVIDER_NOT_LIVE' | 'PROVIDER_NOT_CONFIGURED' | 'WRONG_AUTH_KIND'
  constructor(code: ProviderNotConnectableError['code'], message: string) {
    super(message)
    this.name = 'ProviderNotConnectableError'
    this.code = code
  }
}

/**
 * The connect gate: a provider accepts a connect only when it is known, `live`
 * and has a registered connector on this deployment (Fortnox registers one
 * only when its credentials are configured). Mutation-tested: allowing a
 * `coming_soon` provider through makes the route test go red.
 */
export function assertConnectable(
  id: string,
  authKind?: AccountingProvider['authKind'],
): { provider: AccountingProvider; connector: AccountingConnector } {
  const provider = getProvider(id)
  if (!provider) throw new ProviderNotConnectableError('UNKNOWN_PROVIDER', `Unknown accounting provider "${id}".`)
  if (provider.availability !== 'live') {
    throw new ProviderNotConnectableError('PROVIDER_NOT_LIVE', `${provider.displayName} is coming soon and cannot be connected yet.`)
  }
  if (authKind && provider.authKind !== authKind) {
    throw new ProviderNotConnectableError(
      'WRONG_AUTH_KIND',
      `${provider.displayName} connects with ${provider.authKind === 'oauth2' ? 'OAuth' : 'an API key'}, not this flow.`,
    )
  }
  const connector = getConnector(provider.id)
  if (!connector) {
    throw new ProviderNotConnectableError(
      'PROVIDER_NOT_CONFIGURED',
      `${provider.displayName} is not configured on this deployment.`,
    )
  }
  return { provider, connector }
}

/** Descriptor + instance for a provider, or null when either is missing. */
export function connectorFor(id: string): { provider: AccountingProvider; connector: AccountingConnector } | null {
  const provider = getProvider(id)
  const connector = getConnector(id)
  return provider && connector ? { provider, connector } : null
}
