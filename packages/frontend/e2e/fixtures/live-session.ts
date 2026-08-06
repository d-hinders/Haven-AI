import type { Page } from '@playwright/test'
import { AUTH_TOKEN_STORAGE_KEY } from '../../src/lib/auth-storage'

/**
 * Live-session helper for the **unmocked** `live` Playwright project (#576).
 *
 * Unlike `seedAuthenticatedSession` (which fakes a token + mocks every route),
 * this establishes a *real* dashboard session against the shared **dev backend**
 * using the seeded QA identity (#574), then re-points the deployed frontend at
 * that backend via the `?apiBaseUrl` override. Everything it asserts is read-only
 * — this layer never moves funds.
 */

// Private constant in lib/api.ts (the `?apiBaseUrl` / stored-override key). Kept
// as a literal here so the helper doesn't force an export of an internal key.
const API_OVERRIDE_STORAGE_KEY = 'haven_api_base_url'

export interface LiveSessionConfig {
  /** Shared dev backend the deployed frontend should talk to. */
  apiUrl: string
  email: string
  password: string
}

/**
 * Read the live-session env. Throws with a clear pointer when a var is missing
 * so the workflow_dispatch run fails loudly rather than silently mock-less.
 */
export function loadLiveSessionConfig(env: NodeJS.ProcessEnv = process.env): LiveSessionConfig {
  const required: Record<keyof LiveSessionConfig, string> = {
    apiUrl: 'QA_HAVEN_API_URL',
    email: 'QA_USER_EMAIL',
    password: 'QA_USER_PASSWORD',
  }
  const missing = Object.values(required).filter((key) => !env[key]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `Live QA session needs ${missing.join(', ')} (testnet/dev-only — see docs/operations/agent-qa.md).`,
    )
  }
  return {
    apiUrl: env[required.apiUrl]!.trim().replace(/\/+$/, ''),
    email: env[required.email]!.trim(),
    password: env[required.password]!.trim(),
  }
}

/**
 * Log the QA user into the dev backend and prime the deployed frontend so it
 * loads already authenticated and pointed at that backend. Call before the first
 * navigation in a spec.
 */
export async function establishLiveSession(
  page: Page,
  config: LiveSessionConfig = loadLiveSessionConfig(),
): Promise<void> {
  const res = await page.request.post(`${config.apiUrl}/auth/login`, {
    data: { email: config.email, password: config.password },
  })
  if (!res.ok()) {
    throw new Error(`QA login failed against ${config.apiUrl}: HTTP ${res.status()}`)
  }
  const body = (await res.json()) as { token?: string }
  if (!body.token) {
    throw new Error('QA login returned no token')
  }

  await page.addInitScript(
    ({ tokenKey, overrideKey, token, apiUrl }) => {
      window.localStorage.setItem(tokenKey, token)
      // Re-point a preview/deployed frontend at the dev backend. Honoured only
      // when NEXT_PUBLIC_HAVEN_ENV is non-prod (the #582 gate), which the dev
      // deploy is — so this is inert anywhere it would be unsafe.
      window.localStorage.setItem(overrideKey, apiUrl)
    },
    {
      tokenKey: AUTH_TOKEN_STORAGE_KEY,
      overrideKey: API_OVERRIDE_STORAGE_KEY,
      token: body.token,
      apiUrl: config.apiUrl,
    },
  )
}
