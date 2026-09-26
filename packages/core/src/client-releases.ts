/**
 * Client releases — what a published Haven client needs to know about
 * releases, as data (#3304, epic #3302 slice 2).
 *
 * Two public documents serve this: the backend's `GET /discovery`
 * (`client_releases`) and the frontend's `/.well-known/haven.json` (its
 * `packages` entries), plus the human-readable page at
 * {@link RELEASE_NOTES_PATH}. All three are built by {@link buildReleaseCompat},
 * and the version thresholds come from `CLIENT_COMPAT` in `client-compat.ts`,
 * the table the backend ENFORCES (the epic's "a published minimum is a
 * promise" note). One caveat: the frontend and the backend deploy — and roll
 * back — separately, each with its own bundled copy of this package. So the
 * frontend prefers the thresholds the reachable backend reports in
 * `/discovery`, and falls back to its own copy only when the backend is down.
 *
 * ## Who writes {@link CLIENT_RELEASES}
 *
 * Hand-seeded here by #3304. #3305 makes `npm run release:bump` generate it
 * from the package CHANGELOGs and takes ownership; until then a release that
 * forgets to update it leaves the documents one release behind, never wrong
 * about a minimum (those live in `CLIENT_COMPAT`, which the bump never writes).
 *
 * ## `released_version`, not `latest`
 *
 * The version recorded is the one RELEASED IN SOURCE — the version the bump
 * stamped. npm publishing happens later, on the `dev → main` promotion, and a
 * promotion can be half green (published, `latest` unmoved). Nothing here
 * reads npm, so the field is named for what it is rather than claiming npm's
 * `latest` dist-tag (#3305's scope note; `CLAUDE.md` § Releasing).
 *
 * Pure, like the rest of `@haven_ai/core`: no I/O, no environment.
 */

import {
  CLIENT_COMPAT,
  PUBLISHED_CLIENT_PACKAGES,
  type ClientCompatEntry,
  type PublishedClientPackage,
} from './client-compat.js'

/**
 * The public page that says what changed and whether to update. A PATH on the
 * dashboard origin: the frontend manifest serves it relative (its own-origin
 * rule), the backend resolves it against its configured frontend URL.
 */
export const RELEASE_NOTES_PATH = '/releases'

export interface ClientReleaseNote {
  version: string
  /** ISO date, `YYYY-MM-DD`. */
  date: string
  /** One or two sentences — what changed, for someone deciding whether to update. Not the CHANGELOG. */
  summary: string
  /**
   * True when a client must update to keep paying. Not the same as a breaking
   * change: BREAKING means "updating may break you", this means "not updating
   * will" (#3305 gives it its own CHANGELOG marker).
   */
  action_required: boolean
}

export interface ClientRelease {
  /** The newest version released in source (see the file comment: not npm's `latest`). */
  released_version: string
  /** Newest first. */
  notes: readonly ClientReleaseNote[]
}

/**
 * Hand-seeded by #3304 from the package CHANGELOGs; #3305 generates it.
 * Newest note first.
 */
export const CLIENT_RELEASES: Readonly<Record<PublishedClientPackage, ClientRelease>> = {
  '@haven_ai/sdk': {
    released_version: '0.5.0-alpha.1',
    notes: [
      {
        version: '0.5.0-alpha.1',
        date: '2026-09-25',
        summary:
          'Every Haven API request names the client in X-Haven-Client, so the backend can say when an update is needed; read the hint with HavenClient.clientUpdate().',
        action_required: false,
      },
      {
        version: '0.5.0-alpha.0',
        date: '2026-09-25',
        summary:
          'signForData refuses to sign anything that is not this key redeeming its own budget delegation; new @haven_ai/sdk/edge entry; receipts gain the transaction-feed field names.',
        action_required: false,
      },
    ],
  },
  '@haven_ai/signer': {
    released_version: '0.5.0-alpha.1',
    notes: [
      {
        version: '0.5.0-alpha.1',
        date: '2026-09-25',
        summary:
          'Sign-context reads name the signer in X-Haven-Client; a signer below a minimum the deployment sets is refused with client_outdated and the update command.',
        action_required: false,
      },
      {
        version: '0.5.0-alpha.0',
        date: '2026-09-25',
        summary:
          'haven_sign signs only a guarded direct payment, x402 funding leg or verified settlement child; x402 expected-context v1 is retired.',
        action_required: false,
      },
    ],
  },
  '@haven_ai/mcp': {
    released_version: '0.5.0-alpha.1',
    notes: [
      {
        version: '0.5.0-alpha.1',
        date: '2026-09-25',
        summary:
          'Requests name the runtime in X-Haven-Client; a backend update hint is returned as client_update on tool results.',
        action_required: false,
      },
      {
        version: '0.5.0-alpha.0',
        date: '2026-09-25',
        summary:
          'Payment tools refuse, before signing, anything that is not this key redeeming its own budget delegation (via the SDK).',
        action_required: false,
      },
    ],
  },
  '@haven_ai/connect': {
    released_version: '0.5.0-alpha.1',
    notes: [
      {
        version: '0.5.0-alpha.1',
        date: '2026-09-25',
        summary: 'Connector requests name the connector in X-Haven-Client.',
        action_required: false,
      },
      {
        version: '0.5.0-alpha.0',
        date: '2026-09-25',
        summary:
          '--doctor no longer needs --runtime; a retired agent directory can no longer keep a spendable key.',
        action_required: false,
      },
    ],
  },
  '@haven_ai/cli': {
    released_version: '0.5.0-alpha.1',
    notes: [
      {
        version: '0.5.0-alpha.1',
        date: '2026-09-25',
        summary: 'CLI requests name the CLI in X-Haven-Client. No command output changes.',
        action_required: false,
      },
      {
        version: '0.5.0-alpha.0',
        date: '2026-09-25',
        summary: 'activity list rows carry scope and timestampSource, and report an unrecorded proof status as null.',
        action_required: false,
      },
    ],
  },
}

/**
 * The command that updates `pkg` on the given connector channel (the npm
 * dist-tag a deployment hands out). Moved here from the backend's
 * `client-compat` middleware (#3303) so the update hint and the public release
 * documents print one command, not two copies.
 */
export function upgradeCommandFor(pkg: PublishedClientPackage, channel: string): string {
  switch (pkg) {
    case '@haven_ai/sdk':
      return `npm install @haven_ai/sdk@${channel}`
    case '@haven_ai/cli':
      return `npx -y @haven_ai/cli@${channel}`
    // The signer and the local MCP runtime are installed BY the connector; a
    // connector re-run reinstalls the pinned runtime (the signer's own
    // version-mismatch guidance says the same).
    case '@haven_ai/signer':
    case '@haven_ai/mcp':
    case '@haven_ai/connect':
      return `npx -y @haven_ai/connect@${channel}`
  }
}

/** One package's entry in the public release documents. */
export interface PackageReleaseCompat {
  released_version: string
  /** From `CLIENT_COMPAT`: below this, responses carry a non-blocking update hint. */
  recommended_version: string | null
  /** From `CLIENT_COMPAT`: below this, the package's refusal points answer `client_outdated`. */
  min_version: string | null
  /** Null when the caller does not know the deployment's channel (e.g. the backend was unreachable). */
  upgrade_command: string | null
  notes: readonly ClientReleaseNote[]
}

export interface BuildReleaseCompatOptions {
  releases?: Readonly<Record<PublishedClientPackage, ClientRelease>>
  compat?: Readonly<Record<PublishedClientPackage, ClientCompatEntry>>
}

/**
 * The per-package release data both public documents serve. `channel` is the
 * deployment's connector channel, or null when unknown. The tables are read
 * at CALL time, never captured at import, so the documents follow the source.
 */
export function buildReleaseCompat(
  channel: string | null,
  { releases = CLIENT_RELEASES, compat = CLIENT_COMPAT }: BuildReleaseCompatOptions = {},
): Record<PublishedClientPackage, PackageReleaseCompat> {
  const out = {} as Record<PublishedClientPackage, PackageReleaseCompat>
  for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
    out[pkg] = {
      released_version: releases[pkg].released_version,
      recommended_version: compat[pkg].recommended_version,
      min_version: compat[pkg].min_version,
      upgrade_command: channel ? upgradeCommandFor(pkg, channel) : null,
      notes: releases[pkg].notes,
    }
  }
  return out
}
