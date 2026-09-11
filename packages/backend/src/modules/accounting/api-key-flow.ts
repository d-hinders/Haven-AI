/**
 * Generic API-key flow for accounting providers (#2862, epic #2858).
 *
 * The other auth kind. No redirect, no state, no refresh: the user pastes a
 * key, the flow VALIDATES it by asking the provider who the key belongs to
 * (`connector.getCompanyInfo`), refuses a ledger that books in the wrong
 * currency, and only then stores the key encrypted. A key that the provider
 * rejects never lands. No live provider uses this kind today (Accounted,
 * Light and Igdrasil are listed `coming_soon`); the flow exists so that when
 * one goes live it is a connector plus a descriptor, and the route and the
 * storage are already there.
 */

import { getConnection, setCompanyInfo, upsertConnection, type AccountingConnectionRow } from '../../infra/repositories/accounting-connections.js'
import { SecretsKeyMissingError, decryptSecrets, encryptSecrets, secretsKeyConfigured } from '../../infra/secrets.js'
import type { AccountingConnector } from './connector.js'
import { ProviderError, assertSupportedBaseCurrency, type AccountingProvider, type ProviderCompanyInfo } from './provider.js'

/** What the secrets blob carries for an api_key provider. */
export interface ApiKeySecrets {
  apiKey: string
}

export class InvalidApiKeyError extends Error {
  readonly code = 'INVALID_API_KEY' as const
  constructor(provider: string, detail: string) {
    super(`${provider} did not accept the API key: ${detail}`)
    this.name = 'InvalidApiKeyError'
  }
}

export async function readApiKeyConnection(
  providerId: string,
  userId: string,
): Promise<{ row: AccountingConnectionRow; secrets: ApiKeySecrets } | null> {
  const row = await getConnection(userId, providerId)
  if (!row || !row.secrets_ciphertext || row.status === 'disconnected') return null
  return { row, secrets: decryptSecrets<ApiKeySecrets>(row.secrets_ciphertext, row.secrets_key_version) }
}

/**
 * Validate-then-store. The validation IS the provider call: a connector for an
 * api_key provider must implement `getCompanyInfo` so that it fails (throws a
 * `ProviderError`) on a key the provider rejects.
 */
export async function connectWithApiKey(input: {
  provider: AccountingProvider
  connector: AccountingConnector
  userId: string
  apiKey: string
}): Promise<AccountingConnectionRow> {
  if (!secretsKeyConfigured()) throw new SecretsKeyMissingError()
  const secrets: ApiKeySecrets = { apiKey: input.apiKey }

  let info: ProviderCompanyInfo
  try {
    info = await input.connector.getCompanyInfo(secrets as unknown as Record<string, unknown>)
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      throw new InvalidApiKeyError(input.provider.id, `HTTP ${err.status}`)
    }
    throw err
  }
  assertSupportedBaseCurrency(info)

  const { ciphertext, keyVersion } = encryptSecrets(secrets as unknown as Record<string, unknown>)
  const row = await upsertConnection(input.userId, {
    provider: input.provider.id,
    authKind: 'api_key',
    secretsCiphertext: ciphertext,
    secretsKeyVersion: keyVersion,
    grantedScope: null,
    tokenExpiresAt: null,
  })
  await setCompanyInfo(input.userId, input.provider.id, info)
  return { ...row, external_company_id: info.externalCompanyId, external_company_name: info.name, base_currency: info.baseCurrency }
}
