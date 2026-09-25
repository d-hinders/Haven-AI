/**
 * Client identity on Haven API requests (#3303, epic #3302).
 *
 * Every published Haven client names itself with one header,
 * `X-Haven-Client: <package>/<version>`, so the backend can tell an outdated
 * client what to run — a `client_update` hint on its responses, or, only below
 * a minimum the deployment has explicitly set, a 426 `client_outdated` refusal
 * at the payment-initiating routes (the signer: at sign-context). The backend's
 * table and decision live in `@haven_ai/core`'s `client-compat.ts`; this module
 * is the client half and deliberately holds no thresholds.
 *
 * Deliberately free of any other SDK import so `@haven_ai/sdk/edge` (the
 * signer's ethers-free entry) can re-export it.
 */

/**
 * This SDK's own version. Owned by `scripts/release-bump.mjs`, which rewrites
 * it with the package version on every release — never hand-edit it.
 */
export const SDK_VERSION = '0.5.0-alpha.1'

/** The request header every published Haven client sends. */
export const HAVEN_CLIENT_HEADER = 'X-Haven-Client'

/** `<package>/<version>` — the value of {@link HAVEN_CLIENT_HEADER}. */
export function havenClientIdentity(pkg: string, version: string): string {
  return `${pkg}/${version}`
}

/** What a bare SDK embedder sends when it names no package of its own. */
export const SDK_CLIENT_IDENTITY = havenClientIdentity('@haven_ai/sdk', SDK_VERSION)

/**
 * The `client_update` object the backend attaches to a response when this
 * client is behind (`required: false`) or below a set minimum
 * (`required: true`). Every field is the backend's; the SDK never computes one.
 */
export interface HavenClientUpdate {
  package: string
  current: string
  recommended: string | null
  min_version: string | null
  required: boolean
  upgrade_command: string
  notes_url: string | null
}

/** Narrow an unknown response field to a {@link HavenClientUpdate}, or undefined. */
export function readClientUpdate(value: unknown): HavenClientUpdate | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.package !== 'string' ||
    typeof v.current !== 'string' ||
    typeof v.required !== 'boolean' ||
    typeof v.upgrade_command !== 'string'
  ) {
    return undefined
  }
  return {
    package: v.package,
    current: v.current,
    recommended: typeof v.recommended === 'string' ? v.recommended : null,
    min_version: typeof v.min_version === 'string' ? v.min_version : null,
    required: v.required,
    upgrade_command: v.upgrade_command,
    notes_url: typeof v.notes_url === 'string' ? v.notes_url : null,
  }
}
