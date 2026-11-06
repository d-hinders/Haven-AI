import { config } from '../../config.js'
import type { OAuth2ProviderConfig } from './oauth-flow.js'

/**
 * Igdrasil's OAuth2 parameters (#4518, epic #2875) — the generic flow's view
 * of Haven's Igdrasil app.
 *
 * Igdrasil's personal API keys only read, so writing into another company's
 * books takes an OAuth app that Igdrasil registers (client id `igd_app_…`,
 * its redirect URIs and scopes) and a company owner or admin approves. The
 * flow is authorization code with PKCE `S256`, which Igdrasil requires
 * (#4517). Access tokens live 900 s; refresh tokens rotate and a reused one
 * revokes the whole family — the generic flow's single row-locked refresh
 * (`getValidOAuth2AccessToken`) is the only path that refreshes.
 *
 * Scopes: `companies:read` names the grant's company at connect;
 * `vouchers:write` covers `POST …/uploads`, the one write the connector
 * makes. Nothing here asks for `vouchers:book` or `purchase-invoices:write`.
 */

export const IGDRASIL_API_BASE = 'https://accounting.igdrasil.se'
export const IGDRASIL_AUTHORIZE_URL = `${IGDRASIL_API_BASE}/api/v1/oauth/authorize`
export const IGDRASIL_TOKEN_URL = `${IGDRASIL_API_BASE}/api/v1/oauth/token`
export const IGDRASIL_REVOKE_URL = `${IGDRASIL_API_BASE}/api/v1/oauth/revoke`
export const IGDRASIL_SCOPE = 'companies:read vouchers:write'

export interface IgdrasilCredentials {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/** Whether this deployment has Haven's Igdrasil app configured — all three values, or none count. */
export function igdrasilConfigured(): boolean {
  return Boolean(config.igdrasilClientId && config.igdrasilClientSecret && config.igdrasilRedirectUri)
}

export function igdrasilCredentials(): IgdrasilCredentials {
  return {
    clientId: config.igdrasilClientId,
    clientSecret: config.igdrasilClientSecret,
    redirectUri: config.igdrasilRedirectUri,
  }
}

/** The generic flow's view of Igdrasil. */
export function igdrasilOAuth2Config(creds: IgdrasilCredentials): OAuth2ProviderConfig {
  return {
    providerId: 'igdrasil',
    authorizeUrl: IGDRASIL_AUTHORIZE_URL,
    tokenUrl: IGDRASIL_TOKEN_URL,
    revokeUrl: IGDRASIL_REVOKE_URL,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: creds.redirectUri,
    scope: IGDRASIL_SCOPE,
    pkce: 'S256',
  }
}
