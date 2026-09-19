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

import { pruneSignerRuntimes } from './prune-runtimes.js'
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
  installedRuntimeMatchesVersions,
  prepareSignerRuntime,
  readRuntimeSidecar,
  type SignerRuntimeSidecar,
} from './signer-runtime.js'
import {
  RUNTIME_SPEC_ENV,
  describeRuntimeSpecOverride,
  resolveRuntimeSpecOverride,
  RuntimeSpecOverrideError,
} from './runtime-spec-override.js'
import { runtimeConfigPathFor, writeRuntimeConfig } from './config-writers.js'
import { normalizeRuntimeName, restartRequiredForRuntime, RUNTIME_FLAG_VALUE_LIST, type RuntimeId } from './runtime-registry.js'
import { getLocalSignerConsentStatus } from './signer-consent.js'
import { TOMBSTONE_FILENAME, readAgentTombstone, readTombstoneRecords } from './tombstone.js'
import { serverNamesFor, type ServerNames } from './server-names.js'
import { CONNECT_OUTCOME_FILENAME, readConnectOutcomeRuntime, readMcpServerBinding, REKEY_PENDING_FILENAME, inspectRekeyPending, type RekeyPendingStatus } from './storage.js'
import { shortAddress } from './redact.js'

/**
 * #3121: three verdicts, not two. `ok` is "nothing to say"; `advisory` is
 * "worth telling you, and nothing is broken" — an intact install that is
 * behind the connector's pin, or a classification the connector cannot make
 * on this runtime; `failed` is a real failure. Only `failed` reaches the exit
 * code. Before #3121 an advisory had to be reported as a failure or not at
 * all, and an install that passed one day failed the next with no action by
 * anyone, because the pinned dev build had moved overnight.
 */
export type DoctorLevel = 'ok' | 'advisory' | 'failed'

export interface DoctorCheck {
  id: string
  label: string
  /**
   * Kept for `--json` consumers that branch on it (#1589 shape): `true` for
   * `ok` AND `advisory`, `false` only for `failed` — so `check.ok`, like
   * `report.ok`, answers "is anything broken", never "is there nothing to
   * say". The level is the finer answer. Derived from `level` in one place
   * (`finalizeCheck`); the two cannot disagree.
   */
  ok: boolean
  level: DoctorLevel
  /** Human detail — never secret material. */
  detail: string
  /** One concrete action, present when the check is not `ok` (a `failed` check always; an `advisory` when there is one). */
  repair?: string
}

/** A check as its site states it: the level, never `ok` — `finalizeCheck` derives that. */
type CheckVerdict = Omit<DoctorCheck, 'ok'>

function finalizeCheck(check: CheckVerdict): DoctorCheck {
  return { ...check, ok: check.level !== 'failed' }
}

/** The rolled-up level: `failed` if any check failed, else `advisory` if any advised, else `ok`. */
export function rollUpLevel(checks: ReadonlyArray<Pick<DoctorCheck, 'level'>>): DoctorLevel {
  if (checks.some((check) => check.level === 'failed')) return 'failed'
  if (checks.some((check) => check.level === 'advisory')) return 'advisory'
  return 'ok'
}

export interface DoctorReport {
  version: 1
  /**
   * `true` exactly when `level !== 'failed'` — the same predicate the exit
   * code uses, so `--json` consumers that branch on `ok` see exit 0 ⇔ ok.
   * Before #3121 this meant "every check passed"; an advisory now leaves it
   * `true`. Additive within `version: 1` (#3121 decisions 3 and 4).
   */
  ok: boolean
  /** #3121: the rolled-up verdict over the flat checks and every WIRED agent's checks. */
  level: DoctorLevel
  runtime: string
  credentialDirectory?: string
  checks: DoctorCheck[]
  /** #1697: one entry per credential directory found on this machine. */
  agents: AgentInventoryEntry[]
  /** Signer compat surface from the live handshake, when it succeeded. */
  signerCapabilities?: Record<string, unknown>
}

export interface DoctorDeps {
  /** #3123 test seam: the dry-run prune the doctor consults (names only — see the call site). */
  pruneSignerRuntimes?: typeof pruneSignerRuntimes
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
  /** #2908: the name this package writes from this release on. */
  account_address?: string
  /** Pre-#2908 name; still read by every runtime, rewritten on the next re-key. */
  safe_address?: string
}

// #2423: the channel comes from the SDK's build-time `HAVEN_CONNECTOR_CHANNEL`,
// so a `@dev` snapshot tells its tester to re-run `@dev` instead of quietly
// pointing them back at the production connector.
const RERUN = connectorRerunCommand()

/**
 * #3120: the `--runtime <id>` fragment for a repair/rerun string, or '' when
 * the runtime is unknown. Repair strings interpolate this directly, so the
 * empty case renders as plain `--doctor --repair` (a rerun that will resolve
 * the runtime again) instead of a truncated `--runtime ` that breaks when
 * pasted. Never put a human-readable placeholder in a command line.
 */
function runtimeFlagFor(runtime: string): string {
  return normalizeRuntimeName(runtime) ? ` --runtime ${runtime}` : ''
}

/**
 * #3120: which runtime the doctor is actually looking at.
 *
 * `cli.ts` passes `parsed.options.runtime ?? ''` — an absent flag is the empty
 * string, which is "nobody said", not a runtime. `runtimeConfigPathFor('')`
 * falls through to null and the pre-#3120 doctor reported that as a green
 * "CLI-managed" check no runtime could distinguish from Claude Code's real
 * one. Resolution order:
 *
 * 1. An explicit, non-empty `--runtime` wins VERBATIM. The doctor reports what
 *    was asked for, not a re-spelled alias: `--runtime Cowork` stays
 *    `Cowork` in the report and in `--json`, while `runtimeConfigPathFor` and
 *    the registry normalize it internally as they always have.
 * 2. Otherwise the connector's own record: the `ConnectOutcome` each setup
 *    (success or failure) parks in the agent credential directory's
 *    `last-connect-outcome.json`. The PRIMARY directory's record answers for
 *    the run — per-directory resolution feeds `agentIsWired`, which is #3121's
 *    consequence to own, not this one's.
 * 3. Otherwise unknown (''). Every consumer treats unknown as its honest
 *    degraded verdict; nothing falls back to env detection, which would guess
 *    from the doctor's own shell rather than the runtime the agent uses.
 *
 * `origin` says where a non-flag value came from, so `--doctor --repair` can
 * state which runtime it resolved and from where before it rewrites a config.
 */
async function resolveDoctorRuntime(
  input: { runtime: string; credentialsDir?: string },
  directory: string | undefined,
): Promise<{ runtime: string; origin: 'flag' | 'record' | 'unknown' }> {
  const explicit = input.runtime.trim()
  if (explicit) return { runtime: explicit, origin: 'flag' }
  if (directory) {
    const recorded = await readConnectOutcomeRuntime(directory)
    if (recorded !== null && normalizeRuntimeName(recorded)) {
      return { runtime: recorded, origin: 'record' }
    }
  }
  return { runtime: '', origin: 'unknown' }
}

/**
 * Newest agent directory that holds an identity.json, plus every OTHER such
 * directory (#1688). The others used to be a cosmetic note ("N dirs found;
 * examining the newest") — which downgraded the exact fact that matters: a
 * re-run mints a fresh agent and, without `--replace` (#2551), retires
 * nothing, so a directory this doctor did NOT select can hold a key that
 * still authenticates and still spends.
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
 *   response is `id`, `name`, `status`, `account_address` (`safe_address`
 *   until #2914), `delegate_address`,
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
  return finalizeCheck(rekeyPendingVerdict(status, hostedDelegateAddress, runtime, slug))
}

function rekeyPendingVerdict(
  status: RekeyPendingStatus,
  hostedDelegateAddress: string | undefined,
  runtime: string,
  slug: string | undefined,
): CheckVerdict {
  const label = 'Pending re-key'
  const nameFlag = slug ? ` --name ${slug}` : ''
  if (status.state === 'unreadable') {
    return {
      id: 'rekey_pending',
      label,
      level: 'failed',
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
      level: 'failed',
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
          : `Run: ${RERUN} --rekey-finish${nameFlag} --api-key <the key the agent page showed you>${runtimeFlagFor(runtime)}`,
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
      level: 'failed',
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
    level: 'ok',
    detail:
      `A re-key started ${started} is still open (expires ${status.expiresAt ?? 'unknown'}). Paste this ` +
      `address into "Replace signing key" on the Haven agent page: ${address}. Parked at ${status.path}. ` +
      wedgeNote,
  }
}

async function runtimeSpecOverrideCheck(
  directory: string,
  sidecar: SignerRuntimeSidecar | null,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck | undefined> {
  const facts: string[] = []
  const installed = sidecar?.runtime_spec_override
  if (installed) {
    facts.push(
      `signer runtime installed under ${describeRuntimeSpecOverride(installed.specs)} ` +
        `(resolved: ${installed.resolved_specs.join(' ')}; directory key ${installed.directory_key})`,
    )
  }
  // The `--local` topology's sidecar, when this directory has one.
  const mcpInstalled = await readMcpSidecarOverride(directory)
  if (mcpInstalled) {
    facts.push(
      `local MCP runtime installed under ${describeRuntimeSpecOverride(mcpInstalled.specs)} ` +
        `(resolved: ${mcpInstalled.resolved_specs.join(' ')}; directory key ${mcpInstalled.directory_key})`,
    )
  }
  let shell: string | undefined
  try {
    const active = resolveRuntimeSpecOverride(env)
    if (active) shell = `set in this shell: ${describeRuntimeSpecOverride(active)} — a --repair from here installs these, not the pin`
  } catch (err) {
    shell = err instanceof RuntimeSpecOverrideError
      ? `set in this shell but REFUSED: ${err.message}`
      : `set in this shell but unreadable: ${err instanceof Error ? err.message : String(err)}`
  }
  if (shell) facts.push(shell)
  if (facts.length === 0) return undefined
  const variables = Object.values(RUNTIME_SPEC_ENV).join(' / ')
  return finalizeCheck({
    id: 'runtime_spec_override',
    label: 'Runtime spec override',
    level: 'failed',
    detail: `runtime spec overridden — not the pinned manifest (${MCP_RUNTIME_MANIFEST.signerPackage}@${MCP_RUNTIME_MANIFEST.signerVersion}, ${MCP_RUNTIME_MANIFEST.sdkPackage}@${MCP_RUNTIME_MANIFEST.sdkVersion}). ${facts.join('. ')}.`,
    repair: `Developer override (#2424). To return to the pinned manifest: unset ${variables}, then run ${RERUN} --doctor --repair --runtime <runtime>. If the override is intentional, this finding is the record of it.`,
  })
}

async function readMcpSidecarOverride(
  directory: string,
): Promise<{ specs: Record<string, string>; resolved_specs: string[]; directory_key: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'mcp-runtime.json'), 'utf8')) as {
      runtime_spec_override?: { specs: Record<string, string>; resolved_specs: string[]; directory_key: string }
    }
    return parsed.runtime_spec_override
  } catch {
    return undefined
  }
}

async function readIdentity(directory: string): Promise<IdentityFile | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')) as IdentityFile
  } catch {
    return undefined
  }
}

/**
 * #2908: which NAME the stored files carry the account address under. Reported
 * rather than judged — both are read by every runtime this connector installs
 * (the `safe_address` fallback is permanent, #2906 decision 2a), so neither is
 * a failure; a set written before #2908 simply says so, and the next re-key or
 * setup rewrites it under the new name. Exported for tests.
 */
export function describeAccountAddressKey(
  identity: IdentityFile | undefined,
  signerFile: Record<string, unknown> | undefined,
): string {
  const files = [identity as Record<string, unknown> | undefined, signerFile]
  const has = (key: 'account_address' | 'safe_address') =>
    files.some((f) => typeof f?.[key] === 'string' && (f[key] as string).trim() !== '')
  if (has('account_address')) return 'account address stored as account_address'
  if (has('safe_address')) {
    return 'account address stored under the pre-#2908 name safe_address — still read; ' +
      'the next --rekey or setup rewrites it as account_address'
  }
  return 'no account address stored'
}

/** Every per-agent check for ONE credential directory. */
async function checksForAgent(
  entry: { directory: string; identity?: IdentityFile; sidecar: SignerRuntimeSidecar | null },
  input: { runtime: string },
  deps: DoctorDeps,
): Promise<{ checks: DoctorCheck[]; signerCapabilities?: Record<string, unknown> }> {
  const verdicts = await verdictsForAgent(entry, input, deps)
  return {
    checks: verdicts.checks.map(finalizeCheck),
    ...(verdicts.signerCapabilities ? { signerCapabilities: verdicts.signerCapabilities } : {}),
  }
}

async function verdictsForAgent(
  entry: { directory: string; identity?: IdentityFile; sidecar: SignerRuntimeSidecar | null },
  input: { runtime: string },
  deps: DoctorDeps,
): Promise<{ checks: CheckVerdict[]; signerCapabilities?: Record<string, unknown> }> {
  const { directory, identity, sidecar } = entry
  const checks: CheckVerdict[] = []
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
    level: credentialsOk ? 'ok' : 'failed',
    detail: credentialsOk
      ? `identity.json and signer.json parse (agent ${identity?.agent_id ?? 'unknown'}; ` +
        `${describeAccountAddressKey(identity, signerFile)})`
      : 'identity.json or signer.json is missing or unparseable.',
    ...(credentialsOk ? {} : { repair: `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.` }),
  })

  // ── Signer runtime install ────────────────────────────────────────────────
  if (!sidecar) {
    checks.push({
      id: 'signer_runtime',
      label: 'Signer runtime (preinstalled wrapper)',
      level: 'failed',
      detail: 'No signer-runtime.json sidecar — the pinned signer runtime was never prepared (or a pre-#1586 npx config).',
      repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input.runtime)}`,
    })
  } else if (sidecar.runtime_spec_override) {
    // #2424: an override install is compared against what the run that wrote
    // the sidecar recorded, not against the manifest — the manifest is exactly
    // what the developer chose not to install. The override itself is the
    // separate `runtime_spec_override` finding below.
    const matches = await installedRuntimeMatchesVersions(sidecar.runtime_directory, sidecar.cli_path, {
      signerVersion: sidecar.signer_version,
      sdkVersion: sidecar.sdk_version,
    })
    checks.push({
      id: 'signer_runtime',
      label: 'Signer runtime (preinstalled wrapper)',
      level: matches ? 'ok' : 'failed',
      detail: matches
        ? `Installed ${sidecar.signer_package}@${sidecar.signer_version} at ${sidecar.runtime_directory} (override install — see runtime_spec_override)`
        : `Override runtime directory is stale or empty (${sidecar.runtime_directory}) — the CLI or package versions are missing.`,
      ...(matches ? {} : { repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input.runtime)} with the same HAVEN_*_SPEC variables set.` }),
    })
  } else {
    // #2963: two questions, two references. "Is the directory intact?" is
    // answered against the SIDECAR — what npm actually laid down when this
    // runtime was installed — and "is it current?" against the MANIFEST pin.
    // Comparing intactness against the manifest (the pre-#2963 shape) made
    // the drift message unreachable: an install that was merely older than
    // the pin failed the intactness check and was reported as "stale or
    // empty" while its CLI sat there, 64 kB, serving tools to the very next
    // check.
    const intact = await installedRuntimeMatchesVersions(sidecar.runtime_directory, sidecar.cli_path, {
      signerVersion: sidecar.signer_version,
      sdkVersion: sidecar.sdk_version,
    })
    const versionOk = sidecar.signer_version === MCP_RUNTIME_MANIFEST.signerVersion
    const ok = intact && versionOk
    // #3121: intact but behind the pin is an ADVISORY — nothing is broken,
    // the CLI serves tools to the very next check — so it no longer fails the
    // run. The detail still names both versions and the repair still says how
    // to catch up. Not intact is a real failure, as before.
    checks.push({
      id: 'signer_runtime',
      label: 'Signer runtime (preinstalled wrapper)',
      level: ok ? 'ok' : intact ? 'advisory' : 'failed',
      detail: ok
        ? `Installed ${sidecar.signer_package}@${sidecar.signer_version} at ${sidecar.runtime_directory}`
        : intact
          ? `Installed version ${sidecar.signer_version} does not match the connector's pinned ${MCP_RUNTIME_MANIFEST.signerVersion} — intact, but outdated.`
          : `Runtime directory is stale or empty (${sidecar.runtime_directory}) — the CLI or package versions are missing.`,
      ...(ok ? {} : { repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input.runtime)}` }),
    })
  }

  // ── Runtime spec override (#2424) ─────────────────────────────────────────
  // A finding, not a note: a developer override is legitimate and it is also
  // the one state in which "the signer runtime check is green" says nothing
  // about the pinned manifest. It fires on EITHER the installed truth (the
  // sidecar says this directory was built under an override) or the shell
  // truth (a HAVEN_*_SPEC variable is set right now, so a `--repair` from this
  // shell would install that instead of the pin). No override anywhere → no
  // check at all, so a production `--doctor` reads exactly as before.
  const overrideCheck = await runtimeSpecOverrideCheck(directory, sidecar, deps.env ?? process.env)
  if (overrideCheck) checks.push(overrideCheck)

  // ── Hosted MCP ────────────────────────────────────────────────────────────
  const hostedUrl = identity?.hosted_mcp_url ?? (identity?.api_url ? `${identity.api_url}/mcp` : undefined)
  if (identity?.api_key && hostedUrl) {
    const probe = await (deps.probeHosted ?? probeHostedMcpTools)(identity.api_key, hostedUrl, deps.fetch)
    checks.push({
      id: 'hosted_mcp',
      label: 'Hosted Haven MCP',
      level: probe.status === 'ok' ? 'ok' : 'failed',
      detail: probe.status === 'ok'
        ? `MCP tools endpoint is reachable (${hostedUrl}).`
        : `MCP tools endpoint probe failed: ${probe.status} (${hostedUrl}).`,
      ...(probe.status === 'ok'
        ? {}
        : {
            repair: 'Check network access and runtime configuration for the hosted MCP URL, then re-run --doctor.',
          }),
    })
  } else {
    checks.push({
      id: 'hosted_mcp',
      label: 'Hosted Haven MCP',
      level: 'failed',
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
        level: 'failed',
        detail: probe.status === 'unauthorized'
          ? 'The stored API key was rejected, so the agent it authenticates as cannot be compared with the local signing key.'
          : `Could not read the hosted identity (${probe.status}) — the comparison did not happen, so it cannot be reported as a match.`,
        repair: probe.status === 'unauthorized'
          ? `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.`
          : `Restore network access to the Haven API, then re-run: ${RERUN} --doctor${runtimeFlagFor(input.runtime)}`,
      })
    } else if (!localDelegate) {
      checks.push({
        id: 'identity_match',
        label: 'Hosted identity matches the local signing key',
        level: 'failed',
        detail: 'signer.json holds no delegate_address to compare against the hosted identity.',
        repair: `Re-run the full setup with a fresh token: ${RERUN} --setup <token>.`,
      })
    } else {
      const same = probe.delegateAddress?.toLowerCase() === localDelegate.toLowerCase()
      checks.push({
        id: 'identity_match',
        label: 'Hosted identity matches the local signing key',
        level: same ? 'ok' : 'failed',
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
        level: 'failed',
        detail: 'The local-tools consent is not acknowledged, so the signer refuses to start (by design).',
        repair: `Run: ${RERUN} --ack-local-tools --setup <token>  (or re-run your original connector command with --ack-local-tools).`,
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
        level: probe.status === 'ok' ? 'ok' : 'failed',
        detail: probe.status === 'ok'
          ? `Signer started, listed ${probe.toolNames?.length ?? 0} tools${probe.serverInfo?.version ? ` (v${probe.serverInfo.version})` : ''}.${compatDetail}`
          : `Handshake failed: ${probe.status}.`,
        ...(probe.status === 'ok' ? {} : { repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input.runtime)}` }),
      })
    }
  } else {
    checks.push({
      id: 'signer_process',
      label: 'Signer stdio handshake',
      level: 'failed',
      detail: 'Skipped — no prepared signer runtime to probe.',
      repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input.runtime)}`,
    })
  }

  return { checks, ...(signerCapabilities ? { signerCapabilities } : {}) }
}

export async function runDoctor(
  input: { runtime: string; credentialsDir?: string },
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const homeDir = deps.homeDir ?? homedir()
  const checks: CheckVerdict[] = []
  let signerCapabilities: Record<string, unknown> | undefined

  const { directory, others, parkedOnly } = await discoverCredentialDirectory(homeDir, input.credentialsDir)

  // ── #3120: resolve the runtime BEFORE anything judges it ──────────────────
  // An absent flag used to flow through as '' and earn a fabricated green
  // "CLI-managed" verdict. Resolve the recorded runtime from the primary
  // directory's own outcome record instead, and let every check below see the
  // same resolved value.
  const resolution = await resolveDoctorRuntime(input, directory)
  const runtime = resolution.runtime
  const input2 = { ...input, runtime }

  // ── Runtime config (read once; every agent's wiring is judged against it) ─
  // #3145 review: `runtimeConfigPathFor` switches on the RAW string, so a
  // documented alias (`--runtime codex`) used to resolve to no path and take
  // the "CLI-managed" skip while ~/.codex/config.toml sat unread. The path is
  // looked up by the NORMALIZED id; the report keeps the flag verbatim.
  const normalizedRuntime = normalizeRuntimeName(input2.runtime)
  const configPath = runtimeConfigPathFor(normalizedRuntime ?? input2.runtime, homeDir)
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
        checks: rekeyPending ? [rekeyPendingCheck(rekeyPending, undefined, input2.runtime, slug)] : [],
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
      const result = await checksForAgent({ directory: dir, identity, sidecar }, input2, deps)
      entry.checks = result.checks
      capabilitiesByDirectory.set(dir, result.signerCapabilities)
    } else if (rekeyPending) {
      // A superseded directory runs no probes (that is the point — it is not
      // the agent in use), so the backend-completed refinement is unavailable
      // here and the check reports the file facts alone.
      entry.checks = [rekeyPendingCheck(rekeyPending, undefined, input2.runtime, slug)]
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
      level: 'failed',
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
        { directory: primaryDirectory, identity: primaryIdentity, sidecar: primarySidecar }, input2, deps,
      )
      signerCapabilities = result.signerCapabilities
      for (const check of result.checks) primaryChecksById.set(check.id, check)
    }
    // #2424: `runtime_spec_override` rides directly behind `signer_runtime`
    // so the flat list shows the override next to the install it describes.
    for (const id of ['credentials', 'signer_runtime', 'runtime_spec_override']) {
      const check = primaryChecksById.get(id)
      if (check) checks.push(check)
    }
  }

  // #3121 review, finding 2: `configPath === null` has THREE causes, not two —
  // unknown (''), a recognised runtime that owns no config file (claude-code,
  // other), and a runtime string the connector does not recognise at all
  // (`--runtime codex-clii` — args.ts does not validate the value). Only the
  // second earns the honest skip and the advisory below; the third is a
  // failure that names the allowed values, like the unknown case.
  const runtimeOwnsNoConfig = normalizedRuntime !== null && configPath === null
  if (configPath === null && input2.runtime !== '' && normalizedRuntime === null) {
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      level: 'failed',
      detail:
        `Runtime '${input2.runtime}' is not one the connector recognises. The runtime config was NOT checked. ` +
        `Re-run the doctor naming the runtime — one of: ${RUNTIME_FLAG_VALUE_LIST.join(', ')}.`,
      repair: `Re-run the doctor naming the runtime — one of: ${RUNTIME_FLAG_VALUE_LIST.join(', ')}.`,
    })
  } else if (configPath === null && input2.runtime === '') {
    // #3120: the fabricated pass lived here. configPath is null for TWO
    // indistinguishable reasons — a CLI-managed runtime that really has no
    // file-based config (claude-code, other), and an UNKNOWN runtime ("nobody
    // said"). Only the first justifies a green skip; the second must say it
    // could not look. `level: 'failed'` — deliberately NOT #3121's advisory
    // level, so an unknown runtime can never ride a green exit code again.
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      level: 'failed',
      detail:
        `Runtime is unknown — no runtime flag was given and the connector's record in ` +
        `${primaryDirectory ?? input.credentialsDir ?? '~/.haven/agents'} carries no resolvable ` +
        `${CONNECT_OUTCOME_FILENAME} runtime. The runtime config was NOT checked. Re-run the doctor ` +
        `naming the runtime — one of: ${RUNTIME_FLAG_VALUE_LIST.join(', ')}.`,
      repair: `Re-run the doctor naming the runtime — one of: ${RUNTIME_FLAG_VALUE_LIST.join(', ')}.`,
    })
  } else if (configPath === null) {
    // claude-code / other: genuinely CLI-managed or manual — the honest skip
    // the scope boundary preserves. The detail names the RESOLVED runtime
    // (#3120), so "CLI-managed" is only ever claimed about a runtime that
    // earned it.
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      level: 'ok',
      detail: `Runtime '${input2.runtime}' is configured through its own CLI or by hand (${input2.runtime === 'other' ? 'manual runtime' : 'CLI-managed'}) and has no file-based config the connector owns — skipping the file check.`,
    })
  } else if (configText === null) {
    checks.push({
      id: 'runtime_config',
      label: 'Runtime MCP config',
      level: 'failed',
      detail: `No runtime config at ${configPath}.`,
      repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input2.runtime)}`,
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
      level: ok ? 'ok' : 'failed',
      detail: ok
        ? `Config at ${configPath} references the hosted server and the prepared signer wrapper.`
        : signerViaNpx
          ? `Config at ${configPath} still launches the signer via npx — the pre-#1586 shape that cannot start under a 120s startup timeout.`
          : `Config at ${configPath} is missing the Haven entries${primarySidecar && !wrapperReferenced ? ' (or references a different signer wrapper)' : ''}.`,
      ...(ok ? {} : { repair: `Run: ${RERUN} --doctor --repair${runtimeFlagFor(input2.runtime)}` }),
    })
  }

  for (const id of ['hosted_mcp', 'identity_match', 'rekey_pending']) {
    const check = primaryChecksById.get(id)
    if (check) checks.push(check)
  }

  // ── Superseded agents (#1688, now inventory-driven) ───────────────────────
  // A re-run mints a NEW agent and, without `--replace` (#2551), retires
  // nothing: the connector never deletes old directories (a replace tombstones
  // one and strips its keys, which is `retired` below), registration only
  // collides on delegate address,
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
      if (!identity?.api_key || !identity.api_url) {
        if (tombstone) retired.push(`${otherAgent} (retired ${tombstone.retired_at})`)
        else unverifiable.push(`${otherAgent} (no stored key/API URL to probe)`)
        continue
      }
      const suffix = tombstone ? ' [tombstoned — key material still present]' : ''
      // `tools/list` is intentionally static and does not authenticate its
      // bearer. A spend-capability verdict therefore needs the authenticated
      // agent-identity endpoint, not merely a reachable hosted MCP URL.
      const probe = await (deps.probeHostedIdentity ?? probeHostedAgentIdentity)(
        identity.api_key,
        identity.api_url,
        deps.fetch,
      )
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
    // #3121: with no readable config (`configText === null` — every
    // claude-code run, by design, or a missing file) `agentIsWired` could only
    // fall back to "the selected directory is wired, the rest are not", so a
    // second agent the user deliberately wired on this runtime is classified
    // `superseded` here without evidence. Failing the run on that would tell
    // the user to revoke an agent they are using; the honest verdict is an
    // ADVISORY that names the live keys and says why the classification is
    // unreliable. The CLASSIFICATION itself does not change (decision 5) —
    // only the severity of the check that reads it. With a readable config
    // the classification is evidence, and a live unwired key stays a failure
    // for every non-wired classification.
    // Demoted only for a RECOGNISED runtime that owns no config file; an
    // unrecognised runtime string or an unknown runtime keeps the failure
    // (review finding 2 — a typo must not green-wash a live key).
    const classificationUnreliable = configText === null && runtimeOwnsNoConfig
    const supersededLevel: DoctorLevel =
      supersededLive.length === 0 ? 'ok' : classificationUnreliable ? 'advisory' : 'failed'
    checks.push({
      id: 'superseded_agents',
      label: 'Superseded agent credentials',
      level: supersededLevel,
      detail:
        supersededLevel === 'failed'
          ? `${otherEntries.length} other credential dir(s) found — ${parts.join('; ')}. A host started before ` +
            'your latest setup keeps authenticating (and spending) as the old agent.'
          : supersededLevel === 'advisory'
            ? `${otherEntries.length} other credential dir(s) found — ${parts.join('; ')}. Runtime ` +
              `'${input2.runtime}' has no config file the connector can read, so which of these agents ` +
              'are wired cannot be verified from this machine: a live key here may be an agent you use ' +
              'deliberately, or one a host started before your latest setup is still spending as.'
            : `${otherEntries.length} other credential dir(s) found — ${parts.join('; ')}.`,
      ...(supersededLevel === 'failed'
        ? {
            repair:
              `Revoke ${supersededLive.join(', ')} on the Haven agent page, then remove the old ` +
              'director(y/ies) under ~/.haven/agents. Connect never revokes or deletes for you.',
          }
        : supersededLevel === 'advisory'
          ? {
              repair:
                `Check ${supersededLive.join(', ')} on the Haven agent page: revoke the ones you no longer use, ` +
                'then remove their director(y/ies) under ~/.haven/agents. Connect never revokes or deletes for you.',
            }
          : {}),
    })
  }

  // ── Rebound MCP server names (#3122) — advisory, only when two records ──
  // collide. Each directory's `mcp-server-binding.json` says what ITS setup
  // bound. Two directories claiming the same hosted name means the name
  // changed hands locally: the later binding is what a runtime launches now,
  // the earlier agent is what a saved session or document may still mean.
  // Locally recorded facts only — the backend's `agents.mcp_server_name` is
  // the authority for the same backend; this check does not assert
  // otherwise, and names a backend change explicitly because that is the case
  // the backend cannot see.
  const bindings = (
    await Promise.all(inventory.map(async (entry) => ({ entry, binding: await readMcpServerBinding(entry.directory) })))
  ).filter((item): item is { entry: AgentInventoryEntry; binding: NonNullable<typeof item.binding> } => item.binding !== null)
  const byName = new Map<string, typeof bindings>()
  for (const item of bindings) {
    const list = byName.get(item.binding.server_name) ?? []
    list.push(item)
    byName.set(item.binding.server_name, list)
  }
  const rebound = [...byName.entries()].filter(([, items]) => items.length > 1)
  if (rebound.length > 0) {
    const parts = rebound.map(([name, items]) => {
      const ordered = [...items].sort((a, b) => (a.binding.bound_at < b.binding.bound_at ? -1 : a.binding.bound_at > b.binding.bound_at ? 1 : 0))
      const backends = new Set(ordered.map((i) => i.binding.api_url))
      return (
        `'${name}': ` +
        ordered.map((i) => `${i.binding.agent_id} on ${i.binding.api_url} at ${i.binding.bound_at} [${i.entry.classification}]`).join(' → ') +
        (backends.size > 1 ? ' (BACKEND CHANGED)' : '')
      )
    })
    checks.push({
      id: 'mcp_server_name_rebound',
      label: 'MCP server names bound more than once',
      level: 'advisory',
      detail:
        `${rebound.length} MCP server name${rebound.length === 1 ? '' : 's'} changed hands on this machine (locally recorded ` +
        `bindings; the backend's own record is the authority for the same backend): ${parts.join('; ')}. A saved session, ` +
        'script or document naming the server may still mean the earlier agent.',
      repair: `Retire the earlier director(y/ies) with ${RERUN} --unwire <dir> to release the name, or keep both and address them by --name.`,
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
      level: abandoned.length === 0 ? 'ok' : 'failed',
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

  // ── Unused signer-runtime directories (#3123) — advisory, only when any ─
  // A dry-run prune: directories under ~/.haven/signer-runtime that no
  // credential directory's sidecar or wrapper names and that are not the current pin.
  // Reported here so the doctor's own repair advice can be completed without
  // hand-editing directories; absent when there is nothing to reclaim, so a
  // single-agent install reads exactly as before.
  // `measure: false`: names only. Sizing walks every file under the root —
  // 287k files, 2.0 GB on disk, on one developer machine: 28 s cold / 34 s
  // warm in one #3151 reviewer's run, 1059 s cold in the other reviewer's
  // sandbox (the figure depends on the cache and the box; none is a
  // contract) — and the doctor is the command a user runs when something is
  // already broken.
  const prune = await (deps.pruneSignerRuntimes ?? pruneSignerRuntimes)({ dryRun: true, measure: false }, { homeDir, credentialsDir: input.credentialsDir })
  const unused = prune.entries.filter((entry) => entry.action === 'would_remove')
  if (unused.length > 0) {
    checks.push({
      id: 'signer_runtime_unused',
      label: 'Unused signer-runtime directories',
      level: 'advisory',
      detail:
        `${unused.length} signer-runtime director${unused.length === 1 ? 'y' : 'ies'} under ${prune.root} that no credential ` +
        `directory names: ${unused.map((entry) => entry.key).join(', ')}. ` +
        'Nothing is broken; they are left over from earlier pins or overrides (sizes: --prune-signer-runtimes --dry-run).',
      repair: `Run: ${RERUN} --prune-signer-runtimes (add --dry-run to list only).`,
    })
  }

  // ── Restart still required? (informational, never fails the doctor) ───────
  const restart = restartRequiredForRuntime(input2.runtime, deps.env)
  checks.push({
    id: 'restart',
    label: 'Runtime restart',
    level: 'ok',
    detail: restart
      ? 'This runtime loads MCP config at startup — restart it after any repair before expecting the tools to appear.'
      : input2.runtime === ''
        ? 'Runtime is unknown — whether a restart is needed cannot be determined. Re-run the doctor naming the runtime for a definitive answer.'
        : 'No restart requirement known for this runtime.',
  })

  // #1697: exit non-zero if ANY wired agent fails ANY check — not just the
  // one the old heuristic happened to select. #3121: "fails" means level
  // `failed`; a wired agent's advisory rolls up to `advisory`, never to the
  // exit code.
  const wiredChecks = inventory
    .filter((entry) => entry.classification === 'wired')
    .flatMap((entry) => entry.checks)
  const finalChecks = checks.map(finalizeCheck)
  const level = rollUpLevel([...finalChecks, ...wiredChecks])

  return {
    version: 1,
    ok: level !== 'failed',
    level,
    runtime: input2.runtime,
    credentialDirectory: primaryDirectory,
    checks: finalChecks,
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

  // #3120: repair REWRITES the runtime config, so an inherited runtime is
  // worse here than in a read-only check. Resolve exactly like the doctor
  // does — explicit flag verbatim, else the record the setup parked in this
  // directory — and refuse to touch any config while the runtime is unknown.
  const resolution = await resolveDoctorRuntime(input, directory)
  if (resolution.origin === 'record') {
    messages.push(`Runtime not given — resolved '${resolution.runtime}' from ${join(directory, CONNECT_OUTCOME_FILENAME)}.`)
  }
  const runtime = resolution.runtime
  const input2 = { ...input, runtime }
  if (runtime === '') {
    return {
      ok: false,
      messages: [
        'Runtime is unknown — no runtime flag was given and the connector record carries no resolvable runtime.',
        'Repair rewrites the runtime config, so it will not guess. Re-run repair naming the runtime — ' +
          `one of: ${RUNTIME_FLAG_VALUE_LIST.join(', ')}.`,
      ],
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
  // Looked up by the normalized id for the same reason as in runDoctor: an
  // alias must not skip this refusal and clobber a local topology.
  const configPath = runtimeConfigPathFor(normalizeRuntimeName(input2.runtime) ?? input2.runtime, homeDir)
  if (configPath) {
    try {
      const existing = await readFile(configPath, 'utf8')
      if (existing.includes('bin/haven-mcp') || existing.includes('.haven/mcp-runtime')) {
        return {
          ok: false,
          messages: [
            `The config at ${configPath} is the LOCAL-stdio topology (--local). Repair currently rewrites only the hosted+signer shape and will not touch it.`,
            'Re-run your original connector command (with --local) to repair a local-stdio install.',
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
    { runCommand: deps.runCommand, env: deps.env },
  )
  messages.push(...prepared.messages)

  const names = serverNamesFor(serverName)
  messages.push(`Rewriting MCP entries ${names.hosted} / ${names.signer}${serverName ? ` (agent "${serverName}")` : ' (unnamed pair)'} — no other pair is touched.`)

  const configResult = await writeRuntimeConfig({
    // Normalized for the WRITE too (#3145 review round 3): `writeRuntimeConfig`
    // switches on the id, and the raw alias fell to its "manual runtime" arm
    // — a repair that reported success while writing nothing.
    runtime: (normalizeRuntimeName(input2.runtime) ?? input2.runtime) as RuntimeId,
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
