/**
 * `--doctor` / `--repair` (#1589, epic #1585) — end-to-end setup diagnosis
 * without hand-building an MCP stdio client, which is what the 2026-08-18
 * external Codex Desktop tester was reduced to.
 *
 * Doctor is READ-ONLY (its one spawn is the same read-only tools/list
 * handshake setup itself uses) and secret-free: checks report names, paths,
 * versions and verdicts — never the api key or any key material. Repair
 * re-runs the pieces setup already owns — reinstall the pinned signer
 * runtime, rewrite wrapper + sidecar, re-write the runtime config from the
 * STORED identity — and never touches credentials or needs a new setup token.
 *
 * Design notes carried in from #1587's review:
 * - the signer probe reports the initialize payload, so compat versions come
 *   from the SAME handshake (no second probe);
 * - a probe against an un-acknowledged consent gate exits 1 — the doctor
 *   reports that as "consent missing" with the ack re-run as the repair,
 *   never as "signer broken".
 *
 * #1911 extends "secret-free" to the newest file that holds key material: the
 * doctor reports THAT a `--rekey` is parked (#1700's `rekey-pending.json`),
 * when, where and at which public address — through an accessor that does not
 * return the private half at all, so no output path can leak it by omission.
 * Repair still never deletes it: an expired TTL is a refusal to use the key,
 * not a licence to destroy key material the owner may still be mid-flow on.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { connectorRerunCommand } from '@haven_ai/sdk'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import {
  probeHostedAgentIdentity,
  probeHostedMcpTools,
  probeLocalMcpTools,
  type LocalMcpProbeResult,
} from './probes.js'
import {
  installedRuntimeMatches,
  prepareSignerRuntime,
  readRuntimeSidecar,
  type SignerRuntimeSidecar,
} from './signer-runtime.js'
import { runtimeConfigPathFor, writeRuntimeConfig } from './config-writers.js'
import { restartRequiredForRuntime, type RuntimeId } from './runtime-registry.js'
import { getLocalSignerConsentStatus } from './signer-consent.js'
import { TOMBSTONE_FILENAME, readAgentTombstone, readTombstoneRecords } from './tombstone.js'
import { serverNamesFor, type ServerNames } from './server-names.js'
import { REKEY_PENDING_FILENAME, inspectRekeyPending, type RekeyPendingStatus } from './storage.js'
import { shortAddress } from './redact.js'

export interface DoctorCheck {
  id: string
  label: string
  ok: boolean
  /** Human detail — never secret material. */
  detail: string
  /** One concrete action, present exactly when the check fails. */
  repair?: string
}

export interface DoctorReport {
  version: 1
  ok: boolean
  runtime: string
  credentialDirectory?: string
  checks: DoctorCheck[]
  /** #1697: one entry per credential directory found on this machine. */
  agents: AgentInventoryEntry[]
  /** Signer compat surface from the live handshake, when it succeeded. */
  signerCapabilities?: Record<string, unknown>
}

export interface DoctorDeps {
  homeDir?: string
  fetch?: typeof fetch
  probeSignerTools?: typeof probeLocalMcpTools
  probeHosted?: typeof probeHostedMcpTools
  probeHostedIdentity?: typeof probeHostedAgentIdentity
  runCommand?: (command: string, args: string[]) => Promise<void>
  env?: NodeJS.ProcessEnv
  /** Injected clock — the pending-re-key TTL is the only time-dependent check (#1911). */
  now?: () => number
}

interface IdentityFile {
  api_key?: string
  agent_id?: string
  api_url?: string
  hosted_mcp_url?: string
}

// #2423: the channel comes from the SDK's build-time `HAVEN_CONNECTOR_CHANNEL`,
// so a `@dev` snapshot tells its tester to re-run `@dev` instead of quietly
// pointing them back at the production connector.
const RERUN = connectorRerunCommand()

/**
 * Newest agent directory that holds an identity.json, plus every OTHER such
 * directory (#1688). The others used to be a cosmetic note ("N dirs found;
 * examining the newest") — which downgraded the exact fact that matters: a
 * re-run mints a fresh agent and retires nothing, so a directory this doctor
 * did NOT select can hold a key that still authenticates and still spends.
 * The superseded_agents check now owns that fact; the note is gone.
 *
 * ## Three tells, not two (#1915)
 *
 * A directory is an agent credential directory if it holds ANY of
 * `identity.json`, `TOMBSTONE.json` or `rekey-pending.json`. The third was
 * added because #1911 shipped a diagnostic for abandoned re-key key material
 * and this was the one directory shape that diagnostic could not look at: no
 * enumeration, no `agents[]` entry, no `inspectRekeyPending` call, and so a
 * live private key at mode 0600 invisible in both the human output and
 * `--json`.
 *
 * The shipped `--rekey` flow cannot produce that shape — `writeRekeyPending`
 * writes into an EXISTING agent's directory, `startRekey` reads stored
 * credentials first, and tombstoning does not delete the pending file — so it
 * takes an out-of-band deletion of `identity.json` while the pending file
 * survives. Narrow. It is guarded anyway because of what is in the file: this
 * is the only tell whose *presence* is itself the hazard being reported, so a
 * blind spot here is a hole in the tool's stated job rather than a missing
 * nice-to-have. Cost is one `stat`, reached only when the two prior tells
 * both miss.
 *
 * `parkedOnly` records WHY such a directory was enumerated, so the classifier
 * can say `parked` from evidence instead of inferring it from an absent
 * identity — a corrupt `identity.json` must keep reading `orphaned`.
 */
async function discoverCredentialDirectory(
  homeDir: string,
  explicit?: string,
): Promise<{ directory?: string; others: string[]; parkedOnly: Set<string> }> {
  // An explicit --credentials-dir names the agent DIRECTORY itself, so its
  // siblings live in its parent — never in the default root. Scanning the
  // default root under an explicit override would live-probe real keys in a
  // location the caller explicitly pointed away from (#1688 review, B2).
  const root = explicit ? dirname(explicit) : join(homeDir, '.haven', 'agents')
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return explicit
      ? { directory: explicit, others: [], parkedOnly: new Set() }
      : { others: [], parkedOnly: new Set() }
  }
  const candidates: Array<{ directory: string; mtimeMs: number }> = []
  // #1681: a directory whose keys were removed but that carries TOMBSTONE.json
  // is a deliberately retired agent — reportable in the superseded scan, but
  // never selectable as the active credential directory.
  const tombstonedOnly: string[] = []
  // #1915: neither identity nor tombstone, but parked re-key key material.
  // Like `tombstonedOnly` this is a REPORTABLE, never SELECTABLE directory —
  // it holds no credentials to describe, so promoting it to the primary would
  // make the flat check list describe an agent that is not there.
  const parkedOnly: string[] = []
  for (const entry of entries) {
    const directory = join(root, entry)
    try {
      const s = await stat(join(directory, 'identity.json'))
      candidates.push({ directory, mtimeMs: s.mtimeMs })
    } catch {
      try {
        await stat(join(directory, TOMBSTONE_FILENAME))
        tombstonedOnly.push(directory)
      } catch {
        try {
          await stat(join(directory, REKEY_PENDING_FILENAME))
          parkedOnly.push(directory)
        } catch {
          // not an agent credential dir
        }
      }
    }
  }
  const parkedOnlySet = new Set(parkedOnly)
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (explicit) {
    return {
      directory: explicit,
      others: [...candidates.map((c) => c.directory), ...tombstonedOnly, ...parkedOnly]
        .filter((d) => d !== explicit),
      parkedOnly: parkedOnlySet,
    }
  }
  if (candidates.length === 0 && tombstonedOnly.length === 0 && parkedOnly.length === 0) {
    return { others: [], parkedOnly: parkedOnlySet }
  }
  return {
    directory: candidates[0]?.directory,
    others: [...candidates.slice(1).map((c) => c.directory), ...tombstonedOnly, ...parkedOnly],
    parkedOnly: parkedOnlySet,
  }
}

/**
 * #1697: one entry per credential directory on this machine.
 *
 * "Newest wins" was a single-agent heuristic: it named one directory the real
 * one and demoted the rest to a note. Multi-agent (#1696) makes several
 * agents legitimately live at once, so the doctor enumerates instead of
 * choosing, and says which of four things each directory IS.
 */
/**
 * What a credential directory IS:
 *
 * - `wired` — has a usable key and the runtime config actually launches it;
 * - `superseded` — has a usable key the runtime is NOT using (still spends);
 * - `retired` — carries a `TOMBSTONE.json`, a deliberate retirement record;
 * - `orphaned` — has an `identity.json` that yields no usable API key;
 * - `parked` (#1915) — holds `rekey-pending.json` and neither of the other
 *   two tells. Not a broken agent: there is no agent here at all, only the
 *   private key a `--rekey` generated and nobody finished with. It is its own
 *   value rather than folded into `orphaned` because the two carry different
 *   instructions — `orphaned` says "this credential set is unusable, re-run
 *   setup", while `parked` says "this is loose key material; take the agent
 *   id to the Haven agent page, then decide whether to delete". Reporting the
 *   second as the first would print a verdict a reader cannot act on, which
 *   is how a report teaches people to skim.
 */
export type AgentClassification = 'wired' | 'superseded' | 'retired' | 'orphaned' | 'parked'

export interface AgentInventoryEntry {
  /** Wiring slug (#1696); absent for the bare haven / haven-signer pair. */
  slug?: string
  agentId?: string
  directory: string
  classification: AgentClassification
  /**
   * Per-agent checks. Empty for entries that are not wired, with one
   * exception: a directory holding a pending re-key carries that check
   * whatever its classification (#1911) — an abandoned re-key in a superseded
   * or retired directory is precisely the case nothing else looks at.
   */
  checks: DoctorCheck[]
  /**
   * #1911: a started-but-unfinished `--rekey` in this directory, when there is
   * one. Populated for EVERY classification — the whole point is that the file
   * holds live key material in a directory nothing else is looking at. Address
   * and timing only; the private half is not in this shape (see
   * `RekeyPendingStatus`).
   *
   * "Every classification" became literally true in #1915. As shipped, it
   * meant every classification the ENUMERATION could reach, and a directory
   * holding only `rekey-pending.json` matched no discovery tell at all — so
   * the one shape whose sole content is the hazard was the one shape this
   * field could never describe. Such a directory is now enumerated and
   * classified `parked`.
   *
   * "Populated", not "gates the exit code": `report.ok` rolls up the flat
   * `checks` array plus WIRED entries' checks only, so this field and a
   * non-wired entry's `checks` are reporting surfaces, not gates. An abandoned
   * parked key outside the primary directory reaches the exit code through the
   * flat `rekey_pending_elsewhere` check instead — see its comment in
   * `runDoctor` for why that check exists rather than a cascade rule change.
   */
  rekeyPending?: RekeyPendingStatus
}

/**
 * Is this agent's MCP pair actually present in the runtime's config?
 *
 * The answer depends on whether the pair is NAMED, because only a named pair
 * has a name of its own:
 * - NAMED (#1696): its entry name is unique, so the name in the config text
 *   settles it.
 * - UNNAMED: every unnamed agent claims the same bare `haven` /
 *   `haven-signer` names, so the name proves nothing — exactly one of them
 *   can be wired, and the tell is which signer wrapper path the config
 *   actually references.
 * - No readable config at all (Claude Code is CLI-managed, or the file is
 *   missing): this module cannot tell. Guessing "orphaned" would accuse every
 *   agent on the most common runtime, so it falls back to the pre-#1697
 *   heuristic — the selected directory is wired, the rest are not — which is
 *   the honest degradation rather than a fabricated verdict.
 */
function agentIsWired(
  configText: string | null,
  names: ServerNames,
  slug: string | undefined,
  identity: IdentityFile | undefined,
  sidecar: SignerRuntimeSidecar | null,
  isPrimary: boolean,
  bareOwnerExists: boolean,
): boolean {
  if (configText === null) return isPrimary
  if (slug) {
    // Match the NAME with a boundary so `haven-ops` cannot match
    // `haven-ops-2` and `haven` cannot match `haven-ops`.
    for (const name of [names.hosted, names.codexHosted, names.signer, names.codexSigner]) {
      if (new RegExp(`(^|[."'\\s\\[])${name}(["'\\]:\\s]|$)`, 'm').test(configText)) return true
    }
    return false
  }
  if (sidecar?.wrapper_path && configText.includes(sidecar.wrapper_path)) return true
  // #1697 review, finding 2: a sidecar whose wrapper is NOT referenced is not
  // proof of the opposite. A config still on the retired npx launch form
  // (which the runtime_config check flags separately) names no wrapper at
  // all, and condemning that directory as superseded would tell the user to
  // revoke their only working agent. Fall through to the same ownership
  // reasoning the sidecar-less case uses.
  // No proof of ownership of the bare
  // pair. If some OTHER directory's wrapper is the one the config launches,
  // the bare pair is already owned and this one is not wired — even when it
  // is the newest. Only when nothing owns the bare pair does the pre-#1697
  // heuristic apply.
  if (bareOwnerExists) return false
  return isPrimary && Boolean(identity?.hosted_mcp_url && configText.includes(identity.hosted_mcp_url))
}

/**
 * #1911 — the one state `doctor` could not see: a `--rekey` that was started
 * and never finished.
 *
 * `rekey-pending.json` holds a freshly generated PRIVATE key between the two
 * re-key phases (#1700). It is 0600, in the same directory, at the same mode,
 * as the live signer key it is about to replace — so it is not a new exposure.
 * What it is, is invisible: the surface whose entire job is "tell me what
 * state this machine's Haven wiring is in" did not read the file, so an
 * abandoned re-key left key material on disk with nothing naming it, and a
 * lost terminal left the owner with no way to re-read the address they were
 * supposed to paste except by running `--rekey` again and discarding the
 * parked keypair.
 *
 * This check reports THAT one exists, when it started, when it expires, its
 * PUBLIC address and its path. Never its contents — the accessor it reads does
 * not return them.
 *
 * ## What this can and cannot tell you about #1868
 *
 * #1868 establishes that a re-key abandoned AFTER the on-chain revoke wedges
 * the agent: the old delegations are gone, no new ones were issued, nothing
 * expires the in-flight row, and the only way back is a manual owner re-grant.
 * A re-key abandoned BEFORE the revoke costs nothing at all. Those two are
 * worth very different words, so this check says only what it can actually
 * establish:
 *
 * - **Can distinguish: the backend re-key COMPLETED.** `agents.delegate_address`
 *   is swapped at the `complete` stage, so a hosted identity already reporting
 *   the address this machine generated proves the whole owner-signed sequence
 *   ran. Nothing is wedged; only the local half is outstanding, and
 *   `--rekey-finish` closes it.
 * - **Cannot distinguish: before the revoke vs. after it,** within the
 *   not-completed case. `rekey-pending.json` is written before the owner opens
 *   the dashboard and is never touched again, so it records nothing about how
 *   far the backend got; and the identity probe this connector makes reads two
 *   fields (`id`, `delegate_address`) from `GET /machine-payments/agent`, whose
 *   response is `id`, `name`, `status`, `safe_address`, `delegate_address`,
 *   `delegate_account_address`, `chain_id` and `execution_rail` — **none of
 *   which is a re-key stage**. The absent field is what matters here, not the
 *   count: there is nothing on this endpoint to read the stage from, so
 *   widening the probe would not help. So "never started on the agent page" and "started, revoked,
 *   abandoned — the #1868 wedge" are the same observation from here. The check
 *   says so, and points at the agent page, rather than implying the reassuring
 *   half.
 */
function rekeyPendingCheck(
  status: RekeyPendingStatus,
  hostedDelegateAddress: string | undefined,
  runtime: string,
  slug: string | undefined,
): DoctorCheck {
  const label = 'Pending re-key'
  const nameFlag = slug ? ` --name ${slug}` : ''
  if (status.state === 'unreadable') {
    return {
      id: 'rekey_pending',
      label,
      ok: false,
      detail:
        `A re-key was started here but ${status.path} does not parse, so neither the address it ` +
        'generated nor when it started can be read. The file still holds what was a private key.',
      repair: `Delete ${status.path}, then start again: ${RERUN} --rekey${nameFlag}`,
    }
  }

  const started = status.startedAt ?? 'an unknown time'
  const address = status.newDelegateAddress ?? 'unknown'
  const completedOnHaven =
    hostedDelegateAddress !== undefined &&
    status.newDelegateAddress !== undefined &&
    hostedDelegateAddress.toLowerCase() === status.newDelegateAddress.toLowerCase()

  if (completedOnHaven) {
    // The one branch with a definite backend answer. Haven already signs as
    // the new address, so this machine is the only thing left behind — and
    // `identity_match` is failing for exactly this reason, which this check
    // explains rather than repeats.
    return {
      id: 'rekey_pending',
      label,
      ok: false,
      detail:
        `A re-key started ${started} has COMPLETED on Haven — the agent's signing address is already ` +
        `${address}, the one this machine generated — but the local half was never finished, so the ` +
        `credential files here still hold the old key. Parked at ${status.path}.` +
        (status.state === 'expired'
          ? ' The local file is also past its 24h TTL, which --rekey-finish refuses, so the finish ' +
            'command below will not accept it any more.'
          : ''),
      repair:
        status.state === 'expired'
          ? `The parked key expired. Start again — ${RERUN} --rekey${nameFlag} — and re-run "Replace ` +
            'signing key" on the Haven agent page with the new address it prints.'
          : `Run: ${RERUN} --rekey-finish${nameFlag} --api-key <the key the agent page showed you> --runtime ${runtime}`,
    }
  }

  // Not completed. What is UNKNOWN from here is how far the agent page got —
  // and the two possibilities are free and expensive respectively (#1868).
  const wedgeNote =
    'Haven is NOT yet on this address, so the re-key did not complete. This machine cannot tell ' +
    'whether the on-chain revoke on the agent page already ran: if it did not, closing this costs ' +
    "nothing; if it did, the agent's old delegations are revoked, no new ones were issued, and only " +
    'an owner re-grant restores its spend authority (#1868). Check the agent page before assuming ' +
    'the harmless case.'

  if (status.state === 'expired') {
    return {
      id: 'rekey_pending',
      label,
      ok: false,
      detail:
        `A re-key started ${started} EXPIRED ${status.expiresAt ?? ''} without being finished. Its ` +
        `address was ${address}; the private half it generated is still on disk at ${status.path}. ` +
        wedgeNote,
      repair:
        `Either delete ${status.path} to drop the parked key, or start over: ${RERUN} --rekey${nameFlag}. ` +
        'Connect never deletes it for you — an expired TTL is a refusal to USE the key, not a licence ' +
        'to destroy key material you may still be mid-flow on.',
    }
  }

  return {
    id: 'rekey_pending',
    label,
    ok: true,
    detail:
      `A re-key started ${started} is still open (expires ${status.expiresAt ?? 'unknown'}). Paste this ` +
      `address into "Replace signing key" on the Haven agent page: ${address}. Parked at ${status.path}. ` +
      wedgeNote,
  }
}

async function readIdentity(directory: string): Promise<IdentityFile | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')) as IdentityFile
  } catch {
    return undefined
  }
}

/** Every per-agent check for ONE credential directory. */
async function checksForAgent(
  entry: { directory: string; identity?: IdentityFile; sidecar: SignerRuntimeSidecar | null },
  input: { runtime: string },
  deps: DoctorDeps,
): Promise<{ checks: DoctorCheck[]; signerCapabilities?: Record<string, unknown> }> {
  const { directory, identity, sidecar } = entry
  const checks: DoctorCheck[] = []
  let signerCapabilities: Record<string, unknown> | undefined

  // ── Credentials ───────────────────────────────────────────────────────────
  let signerFile: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'signer.json'), 'utf8')) as Record<string, unknown>
    signerFile = typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    signerFile = undefined
  }
  const credentialsOk = Boolean(identity?.api_key) && signerFile !== undefined
  checks.push({
    id: 'credentials',
    label: 'Agent credentials',
    ok: credentialsOk,
    detail: credentialsOk
      ? `identity.json and signer.json parse (agent ${identity?.agent_id ?? 'unknown'})`
      : 'identity.json or signer.json is missing or unparseable.',
    ...(credentialsOk ? {} : { repair: `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.` }),
  })

  // ── Signer runtime install ────────────────────────────────────────────────
  if (!sidecar) {
    checks.push({
      id: 'signer_runtime',
      label: 'Signer runtime (preinstalled wrapper)',
      ok: false,
      detail: 'No signer-runtime.json sidecar — the pinned signer runtime was never prepared (or a pre-#1586 npx config).',
      repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}`,
    })
  } else {
    const matches = await installedRuntimeMatches(sidecar.runtime_directory, sidecar.cli_path)
    const versionOk = sidecar.signer_version === MCP_RUNTIME_MANIFEST.signerVersion
    const ok = matches && versionOk
    checks.push({
      id: 'signer_runtime',
      label: 'Signer runtime (preinstalled wrapper)',
      ok,
      detail: ok
        ? `Installed ${sidecar.signer_package}@${sidecar.signer_version} at ${sidecar.runtime_directory}`
        : matches
          ? `Installed version ${sidecar.signer_version} does not match the connector's pinned ${MCP_RUNTIME_MANIFEST.signerVersion}.`
          : `Runtime directory is stale or empty (${sidecar.runtime_directory}) — the CLI or package versions are missing.`,
      ...(ok ? {} : { repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}` }),
    })
  }

  // ── Hosted MCP ────────────────────────────────────────────────────────────
  const hostedUrl = identity?.hosted_mcp_url ?? (identity?.api_url ? `${identity.api_url}/mcp` : undefined)
  if (identity?.api_key && hostedUrl) {
    const probe = await (deps.probeHosted ?? probeHostedMcpTools)(identity.api_key, hostedUrl, deps.fetch)
    checks.push({
      id: 'hosted_mcp',
      label: 'Hosted Haven MCP',
      ok: probe.status === 'ok',
      detail: probe.status === 'ok'
        ? `Reachable and authorized (${hostedUrl}).`
        : `Probe failed: ${probe.status} (${hostedUrl}).`,
      ...(probe.status === 'ok'
        ? {}
        : {
            repair: probe.status === 'unauthorized'
              ? `The stored API key was rejected — re-run the full setup with a fresh token: ${RERUN} --setup <token>.`
              : 'Check network access to the hosted MCP URL, then re-run --doctor.',
          }),
    })
  } else {
    checks.push({
      id: 'hosted_mcp',
      label: 'Hosted Haven MCP',
      ok: false,
      detail: 'No stored API key / hosted MCP URL to probe with.',
      repair: `Re-run the full setup: ${RERUN} --setup <token>.`,
    })
  }

  // ── Hosted-vs-local identity (#1697) ──────────────────────────────────────
  // The #1681 incident, made mechanical: the API key and the signing key must
  // belong to the SAME agent. A mismatch means the runtime would quote as one
  // agent and sign as another — the exact shape #1690 refuses at signing time.
  // This proves the on-disk pair is self-consistent, which is the half a local
  // tool can know; it still cannot see inside an already-running host.
  const localDelegate = typeof signerFile?.delegate_address === 'string'
    ? (signerFile.delegate_address as string)
    : undefined
  // Hoisted for the pending-re-key check below: a hosted delegate that already
  // equals the parked address is the one thing that proves a backend re-key
  // completed (#1911). `undefined` when the probe did not succeed, which keeps
  // "could not ask" out of the "definitely not completed" branch.
  let hostedDelegateAddress: string | undefined
  if (identity?.api_key && identity.api_url) {
    const probe = await (deps.probeHostedIdentity ?? probeHostedAgentIdentity)(
      identity.api_key, identity.api_url, deps.fetch,
    )
    if (probe.status === 'ok') hostedDelegateAddress = probe.delegateAddress
    if (probe.status !== 'ok') {
      // #1697 review, finding 1: an unperformable comparison is NOT a pass.
      // Saying "skipped, not passed" in the text while setting ok:true is the
      // same green-check-proving-nothing defect this check exists to remove —
      // and worse here, because a real key mismatch that coincides with a
      // network blip would sail through. `hosted_mcp` already fails on
      // network_error; identity_match matches it rather than contradicting it.
      checks.push({
        id: 'identity_match',
        label: 'Hosted identity matches the local signing key',
        ok: false,
        detail: probe.status === 'unauthorized'
          ? 'The stored API key was rejected, so the agent it authenticates as cannot be compared with the local signing key.'
          : `Could not read the hosted identity (${probe.status}) — the comparison did not happen, so it cannot be reported as a match.`,
        repair: probe.status === 'unauthorized'
          ? `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.`
          : `Restore network access to the Haven API, then re-run: ${RERUN} --doctor --runtime ${input.runtime}`,
      })
    } else if (!localDelegate) {
      checks.push({
        id: 'identity_match',
        label: 'Hosted identity matches the local signing key',
        ok: false,
        detail: 'signer.json holds no delegate_address to compare against the hosted identity.',
        repair: `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.`,
      })
    } else {
      const same = probe.delegateAddress?.toLowerCase() === localDelegate.toLowerCase()
      checks.push({
        id: 'identity_match',
        label: 'Hosted identity matches the local signing key',
        ok: same,
        detail: same
          ? `The stored API key authenticates as the agent whose signing key is in this directory (${shortAddress(localDelegate)}).`
          : `MISMATCH: the stored API key authenticates as agent ${probe.agentId ?? 'unknown'} with delegate ` +
            `${shortAddress(probe.delegateAddress ?? 'unknown')}, but signer.json here holds ${shortAddress(localDelegate)}. ` +
            'This runtime would quote as one agent and sign as another.',
        ...(same
          ? {}
          : {
              repair: 'Re-run setup for this agent so its API key and signing key come from one run: ' +
                `${RERUN} --setup <token>. Do not hand-edit either file.`,
            }),
      })
    }
  }

  // ── Pending re-key (#1911) ────────────────────────────────────────────────
  const pending = await inspectRekeyPending(directory, deps.now?.() ?? Date.now())
  if (pending) {
    checks.push(rekeyPendingCheck(pending, hostedDelegateAddress, input.runtime, sidecar?.server_name))
  }

  // ── Signer stdio handshake ────────────────────────────────────────────────
  if (sidecar) {
    const consent = await getLocalSignerConsentStatus(join(directory, 'signer.json'))
    if (!consent.acknowledged) {
      checks.push({
        id: 'signer_process',
        label: 'Signer stdio handshake',
        ok: false,
        detail: 'The local-tools consent is not acknowledged, so the signer refuses to start (by design).',
        repair: `Run: ${RERUN} --ack-local-tools --setup <token>  (or re-run your original setup command with --ack-local-tools).`,
      })
    } else {
      const probe: LocalMcpProbeResult = await (deps.probeSignerTools ?? probeLocalMcpTools)(
        sidecar.wrapper_path,
        [],
        MCP_RUNTIME_MANIFEST.requiredSignerTools,
      )
      const experimental = (probe.capabilities?.experimental ?? probe.capabilities) as
        | Record<string, unknown>
        | undefined
      const compat = experimental?.['haven/signer-compatibility'] as Record<string, unknown> | undefined
      signerCapabilities = compat ? { 'haven/signer-compatibility': compat } : undefined
      const compatDetail = compat
        ? ` Compat: x402 expected-context v${JSON.stringify((compat as { x402_expected_context_versions?: unknown }).x402_expected_context_versions ?? '?')}.`
        : ''
      checks.push({
        id: 'signer_process',
        label: 'Signer stdio handshake',
        ok: probe.status === 'ok',
        detail: probe.status === 'ok'
          ? `Signer started, listed ${probe.toolNames?.length ?? 0} tools${probe.serverInfo?.version ? ` (v${probe.serverInfo.version})` : ''}.${compatDetail}`
          : `Handshake failed: ${probe.status}.`,
        ...(probe.status === 'ok' ? {} : { repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}` }),
      })
    }
  } else {
    checks.push({
      id: 'signer_process',
      label: 'Signer stdio handshake',
      ok: false,
      detail: 'Skipped — no prepared signer runtime to probe.',
      repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}`,
    })
  }

  return { checks, ...(signerCapabilities ? { signerCapabilities } : {}) }
}

export async function runDoctor(
  input: { runtime: string; credentialsDir?: string },
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const homeDir = deps.homeDir ?? homedir()
  const checks: DoctorCheck[] = []
  let signerCapabilities: Record<string, unknown> | undefined

  const { directory, others, parkedOnly } = await discoverCredentialDirectory(homeDir, input.credentialsDir)

  // ── Runtime config (read once; every agent's wiring is judged against it) ─
  const configPath = runtimeConfigPathFor(input.runtime, homeDir)
  let configText: string | null = null
  if (configPath !== null) {
    try {
      configText = await readFile(configPath, 'utf8')
    } catch {
      configText = null
    }
  }

  // ── Inventory ─────────────────────────────────────────────────────────────
  const allDirectories = directory ? [directory, ...others] : others
  // Which directory (if any) owns the BARE haven / haven-signer pair? The
  // config launches exactly one signer wrapper for it, and that path is the
  // only unambiguous tell — the bare NAMES are claimed by every unnamed
  // agent, so they identify nobody.
  let bareOwnerExists = false
  for (const dir of allDirectories) {
    const sidecar = await readRuntimeSidecar(dir)
    if (!sidecar?.server_name && sidecar?.wrapper_path && configText?.includes(sidecar.wrapper_path)) {
      bareOwnerExists = true
      break
    }
  }
  const inventory: AgentInventoryEntry[] = []
  const capabilitiesByDirectory = new Map<string, Record<string, unknown> | undefined>()
  const primaryChecksById = new Map<string, DoctorCheck>()
  for (const dir of allDirectories) {
    const identity = await readIdentity(dir)
    const sidecar = await readRuntimeSidecar(dir)
    const tombstone = await readAgentTombstone(dir)
    const slug = sidecar?.server_name
    const names = serverNamesFor(slug)
    // #1911: read on EVERY directory, before the not-wired early return. A
    // retired or orphaned directory is exactly where an abandoned re-key would
    // go unnoticed, and the file holds key material regardless of whether the
    // agent it belongs to is still wired.
    const rekeyPending = await inspectRekeyPending(dir, deps.now?.() ?? Date.now())
    if (!identity?.api_key) {
      // #1915: fall back to the agent id recorded IN the parked file. Without
      // it a `parked` directory renders as `unknown: parked` — and the agent
      // id is the one thing the owner has to carry to the Haven agent page
      // before deciding whether the key is safe to delete.
      const agentId = tombstone?.agent_id ?? rekeyPending?.agentId
      inventory.push({
        ...(slug ? { slug } : {}),
        ...(agentId ? { agentId } : {}),
        directory: dir,
        // A tombstone is a deliberate record and outranks the discovery tell:
        // a retired directory that also holds a parked key stays `retired`.
        classification: tombstone ? 'retired' : parkedOnly.has(dir) ? 'parked' : 'orphaned',
        checks: rekeyPending ? [rekeyPendingCheck(rekeyPending, undefined, input.runtime, slug)] : [],
        ...(rekeyPending ? { rekeyPending } : {}),
      })
      continue
    }
    const wired = agentIsWired(configText, names, slug, identity, sidecar, dir === directory, bareOwnerExists)
    const entry: AgentInventoryEntry = {
      ...(slug ? { slug } : {}),
      ...(identity.agent_id ? { agentId: identity.agent_id } : {}),
      directory: dir,
      classification: wired ? 'wired' : 'superseded',
      checks: [],
      ...(rekeyPending ? { rekeyPending } : {}),
    }
    if (wired) {
      const result = await checksForAgent({ directory: dir, identity, sidecar }, input, deps)
      entry.checks = result.checks
      capabilitiesByDirectory.set(dir, result.signerCapabilities)
    } else if (rekeyPending) {
      // A superseded directory runs no probes (that is the point — it is not
      // the agent in use), so the backend-completed refinement is unavailable
      // here and the check reports the file facts alone.
      entry.checks = [rekeyPendingCheck(rekeyPending, undefined, input.runtime, slug)]
    }
    inventory.push(entry)
  }

  // Which agent does the flat `checks` array describe? An explicitly given
  // --credentials-dir always wins. Otherwise it is the first WIRED agent —
  // not merely the newest directory, because a newly created but unwired
  // credential set would otherwise hijack the report and describe an agent
  // the runtime is not even using (#1697).
  const wiredDirectories = inventory
    .filter((entry) => entry.classification === 'wired')
    .map((entry) => entry.directory)
  const primaryDirectory = input.credentialsDir
    ? directory
    : (wiredDirectories.includes(directory ?? '') ? directory : wiredDirectories[0] ?? directory)
  if (primaryDirectory) {
    const primaryEntry = inventory.find((entry) => entry.directory === primaryDirectory)
    signerCapabilities = capabilitiesByDirectory.get(primaryDirectory)
    for (const check of primaryEntry?.checks ?? []) primaryChecksById.set(check.id, check)
  }

  // ── The historical single-agent check list, for the PRIMARY directory ─────
  // A single-agent install must read exactly as it did before (#1697 AC), so
  // the flat `checks` array keeps its order and ids; `agents` is the new,
  // additive per-agent shape.
  if (!primaryDirectory) {
    checks.push({
      id: 'credentials',
      label: 'Agent credentials',
      ok: false,
      detail: 'No agent credential directory with an identity.json under ~/.haven/agents.',
      repair: `Run the full setup once: ${RERUN} --setup <token from the Haven dashboard>.`,
    })
  } else {
    const primaryIdentity = await readIdentity(primaryDirectory)
    const primarySidecar = await readRuntimeSidecar(primaryDirectory)
    // Keyed on a check `checksForAgent` ALWAYS produces, not on the map being
    // empty (#1911): an unwired primary directory that happens to hold a
    // pending re-key now carries that one check from the inventory pass, and a
    // bare `size === 0` would read that as "already done" and silently skip
    // every real check for the directory the user pointed at.
    if (!primaryChecksById.has('credentials')) {
      // The primary directory is not wired (or has no key): run its checks
      // anyway — the user pointed the doctor at this machine, and silence
      // about the selected directory would be the old heuristic's failure.
      const result = await checksForAgent(
        { directory: primaryDirectory, identity: primaryIdentity, sidecar: primarySidecar }, input, deps,
      )
      signerCapabilities = result.signerCapabilities
      for (const check of result.checks) primaryChecksById.set(check.id, check)
    }
    for (const id of ['credentials', 'signer_runtime']) {
      const check = primaryChecksById.get(id)
      if (check) checks.push(check)
    }
  }

  if (configPath === null) {
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      ok: true,
      detail: `Runtime '${input.runtime}' has no file-based config the connector owns (CLI-managed) — skipping the file check.`,
    })
  } else if (configText === null) {
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      ok: false,
      detail: `No runtime config at ${configPath}.`,
      repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}`,
    })
  } else {
    const primaryIdentity = await readIdentity(primaryDirectory ?? '')
    const primarySidecar = primaryDirectory ? await readRuntimeSidecar(primaryDirectory) : null
    const hasHaven = primaryIdentity?.hosted_mcp_url
      ? configText.includes(primaryIdentity.hosted_mcp_url)
      : configText.includes('haven')
    // The wrapper form never writes the package spec into the config; only
    // the retired npx launch does — so the spec's presence IS the tell.
    const signerViaNpx = configText.includes('@haven_ai/signer')
    const wrapperReferenced = primarySidecar ? configText.includes(primarySidecar.wrapper_path) : false
    const ok = hasHaven && !signerViaNpx && (primarySidecar ? wrapperReferenced : true)
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      ok,
      detail: ok
        ? `Config at ${configPath} references the hosted server and the prepared signer wrapper.`
        : signerViaNpx
          ? `Config at ${configPath} still launches the signer via npx — the pre-#1586 shape that cannot start under a 120s startup timeout.`
          : `Config at ${configPath} is missing the Haven entries${primarySidecar && !wrapperReferenced ? ' (or references a different signer wrapper)' : ''}.`,
      ...(ok ? {} : { repair: `Run: ${RERUN} --doctor --repair --runtime ${input.runtime}` }),
    })
  }

  for (const id of ['hosted_mcp', 'identity_match', 'rekey_pending']) {
    const check = primaryChecksById.get(id)
    if (check) checks.push(check)
  }

  // ── Superseded agents (#1688, now inventory-driven) ───────────────────────
  // A re-run mints a NEW agent and retires nothing: the connector never
  // deletes old directories, registration only collides on delegate address,
  // and cancel deliberately refuses to auto-revoke. Net effect: an MCP host
  // that started before the re-run keeps spending as the agent the user
  // believes they replaced — silently, because its old key still resolves.
  // The doctor reports; the user decides — connect never revokes or deletes.
  const otherEntries = inventory.filter((entry) => entry.directory !== primaryDirectory)
  if (otherEntries.length > 0) {
    // Labels carry their SOURCE ENTRY (#1697 review, finding 3): resolving a
    // label back to an entry by string prefix would attribute one agent's
    // classification to another whenever one id is a prefix of the next
    // (`agent-1` / `agent-10`), and the failure mode is telling the user to
    // revoke the live agent.
    const live: Array<{ label: string; entry: AgentInventoryEntry }> = []
    const revoked: string[] = []
    const unverifiable: string[] = []
    const retired: string[] = []
    for (const entry of otherEntries) {
      const identity = await readIdentity(entry.directory)
      const tombstone = await readAgentTombstone(entry.directory)
      // #1915 review: use the id the inventory already resolved rather than
      // re-deriving a narrower one. It is identical for a wired, superseded or
      // retired directory, and strictly better for one whose only id is in the
      // parked file — a NAMED agent's directory basename is its wiring slug,
      // so re-deriving would label the same directory by its slug here and by
      // its real agent id in the "Other agents" section, for the same entry.
      const otherAgent = entry.agentId ?? basename(entry.directory)
      const otherUrl = identity?.hosted_mcp_url
        ?? (identity?.api_url ? `${identity.api_url}/mcp` : undefined)
      if (!identity?.api_key || !otherUrl) {
        if (tombstone) retired.push(`${otherAgent} (retired ${tombstone.retired_at})`)
        else unverifiable.push(`${otherAgent} (no stored key/URL to probe)`)
        continue
      }
      const suffix = tombstone ? ' [tombstoned — key material still present]' : ''
      const probe = await (deps.probeHosted ?? probeHostedMcpTools)(identity.api_key, otherUrl, deps.fetch)
      if (probe.status === 'ok') live.push({ label: `${otherAgent}${suffix}`, entry })
      else if (probe.status === 'unauthorized') revoked.push(`${otherAgent}${suffix}`)
      // network_error / bad_response: neither a false "still live" failure
      // nor a false clean bill — a note, never a verdict.
      else unverifiable.push(`${otherAgent} (${probe.status})${suffix}`)
    }
    const parts: string[] = []
    if (live.length > 0) parts.push(`STILL SPEND-CAPABLE: ${live.map((item) => item.label).join(', ')}`)
    if (revoked.length > 0) parts.push(`already revoked: ${revoked.join(', ')}`)
    if (retired.length > 0) parts.push(`tombstoned (keys removed): ${retired.join(', ')}`)
    if (unverifiable.length > 0) parts.push(`could not verify: ${unverifiable.join(', ')}`)
    // #<new>: mirrored tombstone records whose credential directory is GONE.
    // A retirement flow (or a full ~/.haven/agents wipe) deleted the dir, but
    // the mirror keeps the retirement observable. Informational only — a
    // record with no dir holds no key and can never spend, so it never fails
    // this check. Reads the SAME home the doctor scans (deps.homeDir), never
    // the ambient process home — an explicit --credentials-dir run must not
    // consult the machine-wide default root (REGRESSION B2 discipline).
    const knownIds = new Set([...inventory].map((e) => e.agentId ?? basename(e.directory)))
    const ghostRecords = (await readTombstoneRecords(join(homeDir, '.haven', 'tombstones'))).filter(
      (rec) => !knownIds.has(rec.agent_id),
    )
    if (ghostRecords.length > 0) {
      parts.push(
        `retired records (dir removed): ${ghostRecords
          .map((rec) => `${rec.agent_id} (${rec.reason})`)
          .join(', ')}`,
      )
    }
    // #1697: a WIRED sibling is a legitimately live agent, not a superseded
    // one — several agents may share a runtime now. Only unwired credential
    // dirs make the check fail.
    const supersededLive = live
      .filter((item) => item.entry.classification !== 'wired')
      .map((item) => item.label)
    checks.push({
      id: 'superseded_agents',
      label: 'Superseded agent credentials',
      ok: supersededLive.length === 0,
      detail:
        supersededLive.length > 0
          ? `${otherEntries.length} other credential dir(s) found — ${parts.join('; ')}. A host started before ` +
            'your latest setup keeps authenticating (and spending) as the old agent.'
          : `${otherEntries.length} other credential dir(s) found — ${parts.join('; ')}.`,
      ...(supersededLive.length > 0
        ? {
            repair:
              `Revoke ${supersededLive.join(', ')} on the Haven agent page, then remove the old ` +
              'director(y/ies) under ~/.haven/agents. Connect never revokes or deletes for you.',
          }
        : {}),
    })
  }

  // ── Parked re-keys in OTHER directories (#1911) ───────────────────────────
  //
  // Why this is a FLAT check and not merely a nested one. `report.ok` rolls up
  // the flat list plus every WIRED agent's checks, so a hazard found only in a
  // non-wired entry does not reach the exit code — and `--json` + `report.ok`
  // is the obvious way a CI health-check consumes this. Leaving an abandoned
  // private key visible only in `agents[]` would reproduce, one layer up,
  // exactly the invisibility #1911 exists to remove: reported, but not
  // reported anywhere that gates anything.
  //
  // The precedent is `superseded_agents` directly above: it is a flat check
  // that FAILS on a credential hazard found in a directory that is explicitly
  // not wired. This repo already treats "spend-capable key material in a
  // directory you are not using" as exit-code-worthy, and a parked private key
  // is the same kind of fact — arguably more so, since a superseded agent is
  // at least an agent the owner once chose to create.
  //
  // Severity matches the per-agent check rather than inventing a second scale:
  // an OPEN pending re-key elsewhere is someone mid-flow on another agent and
  // stays informational; an EXPIRED or UNREADABLE one is the abandoned case
  // and fails. Deleting is still nobody's call but the owner's.
  //
  // #1915 widened what reaches this check without touching the check itself.
  // A `parked` directory is enumerated now, so its abandoned key cascades to
  // the exit code through this existing rule on this existing severity scale.
  // That is deliberate: the exit-code surface already moved once when #1911
  // made an expired parked key a failure, and moving it a second time — a new
  // check, or a new severity for this shape — would be a second behaviour
  // change bought for a strictly narrower case than the first. The state that
  // fails is the same state that already failed; only the set of directories
  // it can be found in got honest.
  const parkedElsewhere = inventory
    .filter((entry) => entry.directory !== primaryDirectory && entry.rekeyPending)
    .map((entry) => ({ entry, pending: entry.rekeyPending as RekeyPendingStatus }))
  if (parkedElsewhere.length > 0) {
    const abandoned = parkedElsewhere.filter((item) => item.pending.state !== 'pending')
    const describe = (item: (typeof parkedElsewhere)[number]): string =>
      `${item.entry.slug ?? item.entry.agentId ?? basename(item.entry.directory)} (${item.pending.state}, ${item.pending.path})`
    checks.push({
      id: 'rekey_pending_elsewhere',
      label: 'Parked re-keys in other credential directories',
      ok: abandoned.length === 0,
      detail:
        abandoned.length > 0
          ? `ABANDONED re-key key material outside the agent this report describes: ${abandoned.map(describe).join(', ')}. ` +
            'Each holds a private key that was generated for a re-key nobody finished.'
          : `${parkedElsewhere.length} other director(y/ies) hold an open pending re-key: ${parkedElsewhere.map(describe).join(', ')}.`,
      ...(abandoned.length > 0
        ? {
            repair:
              'Check the Haven agent page for each before deleting: if its on-chain revoke already ran, the agent ' +
              'has no spend authority until you re-grant it (#1868), and that is not visible from this machine. ' +
              'Connect never deletes key material for you.',
          }
        : {}),
    })
  }

  const signerProcess = primaryChecksById.get('signer_process')
  if (signerProcess) checks.push(signerProcess)

  // ── Restart still required? (informational, never fails the doctor) ───────
  const restart = restartRequiredForRuntime(input.runtime, deps.env)
  checks.push({
    id: 'restart',
    label: 'Runtime restart',
    ok: true,
    detail: restart
      ? 'This runtime loads MCP config at startup — restart it after any repair before expecting the tools to appear.'
      : 'No restart requirement known for this runtime.',
  })

  // #1697: exit non-zero if ANY wired agent fails ANY check — not just the
  // one the old heuristic happened to select.
  const wiredOk = inventory
    .filter((entry) => entry.classification === 'wired')
    .every((entry) => entry.checks.every((check) => check.ok))

  return {
    version: 1,
    ok: checks.every((check) => check.ok) && wiredOk,
    runtime: input.runtime,
    credentialDirectory: primaryDirectory,
    checks,
    agents: inventory,
    ...(signerCapabilities ? { signerCapabilities } : {}),
  }
}

export interface RepairResult {
  ok: boolean
  messages: string[]
}

/** Re-run the pieces setup owns; never touches credentials or tokens. */
export async function runRepair(
  input: { runtime: string; credentialsDir?: string },
  deps: DoctorDeps = {},
): Promise<RepairResult> {
  const homeDir = deps.homeDir ?? homedir()
  const messages: string[] = []
  const { directory, others } = await discoverCredentialDirectory(homeDir, input.credentialsDir)
  if (others.length > 0) {
    // Repair never touches the other directories — that is the doctor's
    // superseded_agents check's job to REPORT and the user's to act on.
    messages.push(`Note: ${others.length} other agent credential dir(s) exist — run --doctor for their status.`)
  }
  if (!directory) {
    return {
      ok: false,
      messages: [`No agent credentials found to repair — run the full setup: ${RERUN} --setup <token>.`],
    }
  }
  let identity: IdentityFile
  try {
    identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')) as IdentityFile
  } catch {
    return { ok: false, messages: ['identity.json is unreadable — re-run the full setup with a fresh token.'] }
  }
  if (!identity.api_key || !(identity.hosted_mcp_url || identity.api_url)) {
    return { ok: false, messages: ['identity.json lacks the stored API key / hosted URL — re-run the full setup.'] }
  }

  // #1589 review (HIGH): a --local (local-stdio) setup writes a structurally
  // different config (the haven entry is the LOCAL MCP wrapper, not the
  // hosted URL). Repair only knows how to write the hosted+signer shape, so
  // clobbering a local config would convert a working topology silently —
  // the exact class of harm a repair tool must never cause. Detect and
  // refuse: the local wrapper (bin/haven-mcp) and its mcp-runtime sidecar
  // are the tell.
  const configPath = runtimeConfigPathFor(input.runtime, homeDir)
  if (configPath) {
    try {
      const existing = await readFile(configPath, 'utf8')
      if (existing.includes('bin/haven-mcp') || existing.includes('.haven/mcp-runtime')) {
        return {
          ok: false,
          messages: [
            `The config at ${configPath} is the LOCAL-stdio topology (--local). Repair currently rewrites only the hosted+signer shape and will not touch it.`,
            'Re-run your original setup command (with --local) to repair a local-stdio install.',
          ],
        }
      }
    } catch {
      // No existing config — nothing to clobber; proceed.
    }
  }

  // #1910: WHICH MCP pair does this directory own? `serverNamesFor(undefined)`
  // is the BARE `haven` / `haven-signer` pair, so a repair that omits the slug
  // does not merely fail to fix the named agent it was pointed at — it
  // overwrites a *different*, working agent's entries with this one's
  // credentials and wrapper path. `--repair` is what people reach for when
  // something is already broken; breaking a second agent is the worst
  // available outcome.
  //
  // The slug is not a flag the user must remember to repeat: #1696 records it
  // in this directory's own sidecar, which is already on disk. Read it before
  // `prepareSignerRuntime` — that call REWRITES the sidecar, and passing the
  // slug back in is what stops the rewrite from erasing it (a second, quieter
  // half of the same defect: a repaired named agent would afterwards read as
  // an unnamed one to every later `--doctor`).
  const existingSidecar = await readRuntimeSidecar(directory)
  const serverName = existingSidecar?.server_name

  const signerPath = join(directory, 'signer.json')
  const prepared = await prepareSignerRuntime(
    { credentialDirectory: directory, signerPath, homeDir, serverName },
    { runCommand: deps.runCommand },
  )
  messages.push(...prepared.messages)

  const names = serverNamesFor(serverName)
  messages.push(`Rewriting MCP entries ${names.hosted} / ${names.signer}${serverName ? ` (agent "${serverName}")` : ' (unnamed pair)'} — no other pair is touched.`)

  const configResult = await writeRuntimeConfig({
    runtime: input.runtime as RuntimeId,
    hostedMcpUrl: identity.hosted_mcp_url ?? `${identity.api_url}/mcp`,
    apiKey: identity.api_key,
    identityPath: join(directory, 'identity.json'),
    signerPath,
    credentialDirectory: directory,
    signerCommand: { command: prepared.command, args: prepared.args },
    homeDir,
    mode: 'hosted',
    serverName,
  })
  messages.push(...configResult.messages)
  messages.push('Repair complete — restart the runtime, then verify with --doctor.')
  return { ok: true, messages }
}
