/**
 * --unwire (#2169): remove ONE agent's runtime wiring and leave every other
 * agent and every unrelated line untouched.
 *
 * The connector has always been able to WRITE a pair into a runtime config
 * (merge* writers) and never able to ERASE one. Retiring an agent therefore
 * left its MCP pair — and on Hermes its dotenv API-key line — in place, and
 * the next setup produced the exact state --doctor's `identity_match` check
 * exists to name: the runtime quotes as one agent and signs as another. That
 * is the live-demo incident #2168/#2169 were split from.
 *
 * This module is the erase half, with the discipline of the writers inverted:
 *
 * - **Tombstone first.** The directory is retired BEFORE any config is
 *   touched, so a long-lived host that still resolves the old wrapper gets
 *   the `HAVEN-TOMBSTONE` diagnosis instead of a masked `ENOENT` park loop
 *   (#1681), and the #2155 mirrored record keeps the retirement observable
 *   even after the directory itself is deleted.
 * - **Named pairs remove by name** — `haven-<slug>` / `haven-signer-<slug>`
 *   are unique, so the name is proof of ownership.
 * - **Unnamed pairs refuse to guess.** Every unnamed agent claims the same
 *   bare `haven` / `haven-signer` names and the same `MCP_HAVEN_API_KEY`, and
 *   only the wrapper path in the config (or the key value in the dotenv)
 *   distinguishes who actually owns them (#1695, `agentIsWired`'s reasoning).
 *   If the config launches THIS directory's wrapper (or the env holds THIS
 *   agent's stored key) the entry is ours and is removed; otherwise the
 *   command REFUSES rather than unwire a different, working agent.
 * - **No custody boundary moves.** This never revokes on the backend —
 *   `connect reports, the user decides` (#1688) survives; revocation stays an
 *   owner action on the Haven agent page. What it DOES do, unlike
 *   `--tombstone`'s touch-nothing retirement, is fully tear down the TARGET
 *   directory's local half: after the tombstone it removes the directory's own
 *   key material (signer.json, any abandoned re-key) and strips the API key
 *   from identity.json, so `--doctor` reports `retired` — not `superseded`
 *   (still spend-capable) — per the doctor's mutation-proof rule that a
 *   tombstone never excuses a live key. The tombstone record and its #2155
 *   mirror survive the teardown.
 *
 * Scope mirrors the writers: Hermes YAML + dotenv, Codex TOML, and the JSON
 * MCP configs (Cursor, VS Code, VS Code Insiders, Claude Desktop).
 */
import { probeHostedAgentIdentity, type HostedProbeStatus } from './probes.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import {
  UnreadableRuntimeConfigError,
  hermesEnvPath,
  removeCodexToml,
  removeHermesEnv,
  removeHermesYaml,
  removeJsonMcpConfig,
  runtimeConfigPathFor,
} from './config-writers.js'
import { serverNamesFor, type ServerNames } from './server-names.js'
import { readRuntimeSidecar, type SignerRuntimeSidecar } from './signer-runtime.js'
import { TOMBSTONE_FILENAME, writeAgentTombstone } from './tombstone.js'
import { REKEY_PENDING_FILENAME } from './storage.js'

export interface UnwireRuntimeOutcome {
  runtime: string
  label: string
  path: string | null
  status: 'removed' | 'clean' | 'refused' | 'unreadable'
  detail?: string
}

/**
 * #3123: what happened to THIS directory's key material. Before #3123 the
 * teardown ran unconditionally — and a revoked agent's API key is exactly
 * the credential the sweep-recovery routes still accept, so `--unwire` was
 * destroying the only local means of recovering a stranded balance without
 * ever asking what the key was still good for. Owner decision (option c):
 * the connector asks the one question it can (the existing identity probe)
 * and REFUSES to destroy on every answer but "there is nothing to preserve";
 * an explicit flag proceeds and says what ends.
 */
export interface TeardownOutcome {
  /** `destroyed` — nothing to preserve, key material removed as before; `retained` — refused, key material left in place; `forced` — removed under `--destroy-key-material`. */
  status: 'destroyed' | 'retained' | 'forced'
  /** The identity probe's answer, or `not_probed` when there was no stored API key + API URL to probe with. */
  probe: HostedProbeStatus | 'not_probed'
  detail: string
  /** The one next step, present on `retained` (and on `forced`, naming what ended). */
  remedy?: string
}

export interface UnwireOutcome {
  directory: string
  agentId: string
  slug: string | undefined
  tombstoned: boolean
  runtimes: UnwireRuntimeOutcome[]
  teardown: TeardownOutcome
}

export interface UnwireInput {
  directory: string
  /** #1696 wiring slug; when absent, read from the directory's own sidecar. */
  slug?: string
  /** Reason recorded in the tombstone written first (#1681). */
  reason?: string
  replacedBy?: string
  /** Override for the surviving mirror root (#2155), like `--tombstone`'s own. */
  tombstonesDir?: string
  homeDir?: string
  /**
   * #3123: `--destroy-key-material`. Proceed with the local key teardown
   * whatever the probe says. The outcome states what was destroyed and that
   * local recovery of a stranded balance ends with it.
   */
  destroyKeyMaterial?: boolean
  /** Test seam for the ONE network call on this path (the existing identity probe). */
  probeHostedIdentity?: typeof probeHostedAgentIdentity
  fetch?: typeof fetch
}

interface IdentityFile {
  agent_id?: string
  api_key?: string
  api_url?: string
  hosted_mcp_url?: string
}

interface RuntimeModel {
  runtime: string
  label: string
  kind: 'yaml' | 'toml' | 'json'
  serverRoot?: 'mcpServers' | 'servers'
}

/** One entry per supported runtime, mirroring `runtimeConfigPathFor`. */
const RUNTIMES: RuntimeModel[] = [
  { runtime: 'hermes', label: 'Hermes Agent config', kind: 'yaml' },
  { runtime: 'codex-cli', label: 'Codex config', kind: 'toml' },
  { runtime: 'cursor', label: 'Cursor MCP config', kind: 'json', serverRoot: 'mcpServers' },
  { runtime: 'vscode', label: 'VS Code MCP config', kind: 'json', serverRoot: 'servers' },
  { runtime: 'vscode-insiders', label: 'VS Code Insiders MCP config', kind: 'json', serverRoot: 'servers' },
  { runtime: 'claude-desktop', label: 'Claude Desktop config', kind: 'json', serverRoot: 'mcpServers' },
]

function identityAt(directory: string): Promise<IdentityFile | null> {
  return readFile(join(directory, 'identity.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as IdentityFile)
    .catch(() => null)
}

function removeForModel(text: string, model: RuntimeModel, names: ServerNames, path: string): string {
  switch (model.kind) {
    case 'yaml':
      return removeHermesYaml(text, names, path)
    case 'toml':
      return removeCodexToml(text, names)
    case 'json':
      return removeJsonMcpConfig(text, model.serverRoot ?? 'mcpServers', names, path)
  }
}

function envLineValue(envText: string, envKey: string): string | undefined {
  const line = envText.split(/\r?\n/).find((candidate) => new RegExp(`^\\s*(?:export[ \\t]+)?${envKey}[ \\t]*=`).test(candidate))
  if (!line) return undefined
  let value = line.slice(line.indexOf('=') + 1)
  value = value.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Unwire ONE agent: tombstone it first, then remove its pair from every
 * supported runtime config and (Hermes) dotenv file that exists. Refuses —
 * never guesses — when the bare pair is present but provably belongs to a
 * different agent.
 */
export async function unwireAgent(input: UnwireInput): Promise<UnwireOutcome> {
  const homeDir = input.homeDir ?? homedir()
  const [identity, sidecar] = await Promise.all([identityAt(input.directory), readRuntimeSidecar(input.directory)])
  const agentId = identity?.agent_id ?? 'unknown'
  const slug = input.slug ?? sidecar?.server_name
  const names = serverNamesFor(slug)
  const runtimes: UnwireRuntimeOutcome[] = []

  // ── Tombstone first (#1681 ordering): the long-lived host that still
  //    references this wrapper must hear "retired", never "ENOENT". ─────────
  const tombstoned = await tombstoneDirectoryIfAbsent({
    directory: input.directory,
    agentId,
    reason: input.reason ?? 'unwired via --unwire',
    replacedBy: input.replacedBy,
    tombstonesDir: input.tombstonesDir,
  })

  // ── Runtime configs. ──────────────────────────────────────────────────────
  for (const model of RUNTIMES) {
    const path = runtimeConfigPathFor(model.runtime, homeDir)
    if (path === null) continue
    const text = await readOptionalText(path)
    if (text === null) continue
    try {
      if (!slug) {
        // Unnamed pair: positive proof of ownership is the wrapper path.
        // Only the wrapper in the config distinguishes two unnamed agents
        // (#1695); without it we must not touch the bare names.
        const owned = sidecar?.wrapper_path != null && text.includes(sidecar.wrapper_path)
        if (!owned) {
          const pairPresent = removeForModel(text, model, names, path) !== text
          if (!pairPresent) continue
          runtimes.push({
            runtime: model.runtime,
            label: model.label,
            path,
            status: 'refused',
            detail:
              'the bare haven / haven-signer pair in this config launches a different agent ' +
              '(no wrapper from this directory in the file); refusing to guess which one is yours',
          })
          continue
        }
      }
      const next = removeForModel(text, model, names, path)
      if (next === text) continue
      await writeFile(path, next, 'utf8')
      runtimes.push({ runtime: model.runtime, label: model.label, path, status: 'removed' })
    } catch (err) {
      if (err instanceof UnreadableRuntimeConfigError) {
        runtimes.push({ runtime: model.runtime, label: model.label, path, status: 'unreadable', detail: err.message })
        continue
      }
      throw err
    }
  }

  // ── Hermes dotenv key — the half a config-only removal misses (#2169). ────
  const envPath = hermesEnvPath(homeDir)
  const envText = await readOptionalText(envPath)
  if (envText !== null) {
    try {
      if (!slug) {
        // The bare key is shared by every unnamed agent; it is OURS only when
        // its value is this directory's stored key (#1695's own hazard note).
        const value = envLineValue(envText, names.hermesEnvKey)
        if (value === undefined) {
          // No managed key line at all — nothing of ours to remove here.
        } else if (!identity?.api_key) {
          runtimes.push({
            runtime: 'hermes',
            label: 'Hermes env',
            path: envPath,
            status: 'refused',
            detail: 'MCP_HAVEN_API_KEY is shared by unnamed agents and this directory has no stored API key to compare against; refusing to remove another agent\'s credential',
          })
        } else if (value !== identity.api_key) {
          runtimes.push({
            runtime: 'hermes',
            label: 'Hermes env',
            path: envPath,
            status: 'refused',
            detail: 'MCP_HAVEN_API_KEY in the Hermes env holds a different agent\'s key; refusing to remove another agent\'s credential',
          })
        } else {
          const next = removeHermesEnv(envText, names.hermesEnvKey)
          if (next !== envText) {
            await writeFile(envPath, next, 'utf8')
            runtimes.push({ runtime: 'hermes', label: 'Hermes env', path: envPath, status: 'removed' })
          }
        }
      } else {
        const next = removeHermesEnv(envText, names.hermesEnvKey)
        if (next !== envText) {
          await writeFile(envPath, next, 'utf8')
          runtimes.push({ runtime: 'hermes', label: 'Hermes env', path: envPath, status: 'removed' })
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('ambiguous managed key')) {
        runtimes.push({
          runtime: 'hermes',
          label: 'Hermes env',
          path: envPath,
          status: 'refused',
          detail: err.message,
        })
      } else {
        throw err
      }
    }
  }

  // ── Local teardown of THIS directory's key material (#2169 AC, #3123). ───
  // Unlike --tombstone's touch-nothing retirement, unwire tears the target's
  // local half down: its signer private key and any abandoned re-key are
  // deleted, and identity.json keeps its orientation fields but drops the API
  // key. That is what --doctor's mutation-proof rule requires before it will
  // say `retired` instead of `superseded` (tombstone never excuses a live
  // key), and #2155's mirrored record is what keeps the retirement observable
  // after the keys are gone. The backend is NOT revoked — that stays an owner
  // action on the Haven agent page.
  //
  // #3123 ORDER (S3): the runtime configs and the Hermes env — the copies of
  // the API key that live in world-readable editor files — were scrubbed
  // ABOVE, before this decision, so a refusal here leaves the key in the
  // 0o600 credential file and in any config this run could not clean (those
  // are reported `refused` / `unreadable` above, never silently). The
  // decision itself asks
  // the one question the connector can answer with the probe it already has
  // and refuses on every answer but "nothing to preserve" (option c).
  const teardown = await decideTeardown(identity, input)
  if (teardown.status !== 'retained') await teardownLocalKeyMaterial(input.directory, identity)

  return { directory: input.directory, agentId, slug, tombstoned, runtimes, teardown }
}

const DESTROY_FLAG = '--destroy-key-material'

/**
 * #3123 decision table. The probe (`GET /machine-payments/agent`, the agent's
 * own key) answers spend-capability on the route it calls: `ok` ⟺ active.
 * `unauthorized` is deliberately ambiguous on the backend (revoked, archived,
 * paused, unknown key all read the same) and the connector must not claim
 * more than that. No balance read exists; unknown is never "safe to delete".
 */
async function decideTeardown(identity: IdentityFile | null, input: UnwireInput): Promise<TeardownOutcome> {
  const ended =
    'Local recovery of a stranded delegate balance ends with it: the sweep-recovery routes accept only this ' +
    'agent\'s API key and delegate signature, and neither exists on this machine any more.'
  if (!identity?.api_key || !identity.api_url) {
    return {
      status: input.destroyKeyMaterial ? 'forced' : 'destroyed',
      probe: 'not_probed',
      detail: 'No stored API key + API URL to probe with — nothing the sweep-recovery routes would accept, so nothing to preserve.',
    }
  }
  const probe = await (input.probeHostedIdentity ?? probeHostedAgentIdentity)(identity.api_key, identity.api_url, input.fetch)
  if (input.destroyKeyMaterial) {
    return {
      status: 'forced',
      probe: probe.status,
      detail: `Key material destroyed under ${DESTROY_FLAG} (probe: ${probe.status}): signer.json, any parked re-key, and the API key in identity.json.`,
      remedy: ended,
    }
  }
  switch (probe.status) {
    case 'ok':
      return {
        status: 'retained',
        probe: 'ok',
        detail:
          'This agent is still ACTIVE on the backend: its API key and delegate key still carry spend authority, so ' +
          'destroying them would be a live spend-authority change. Key material kept in this directory (0o600); its MCP wiring above is gone.',
        remedy:
          'Revoke the agent on the Haven agent page (connect never revokes), then re-run --unwire; or, to delete ' +
          `the key anyway, re-run with ${DESTROY_FLAG}.`,
      }
    case 'unauthorized':
      return {
        status: 'retained',
        probe: 'unauthorized',
        detail:
          'This key no longer authenticates on normal routes (revoked, archived, paused, pending approval, rotated, ' +
          'or not a key the backend knows — it does not say which). A stranded delegate balance MAY still exist and ' +
          'the connector CANNOT check: this directory may hold the only local credential the sweep-recovery routes ' +
          'would still accept. Key material kept.',
        remedy:
          'Recover any stranded balance first (haven_sweep_delegate from a runtime still wired to this agent, or the ' +
          `Haven agent page), then re-run with ${DESTROY_FLAG} to remove the key material.`,
      }
    default:
      return {
        status: 'retained',
        probe: probe.status,
        detail:
          `Could not verify what this key is still good for (${probe.status}). Unknown is not "safe to delete": ` +
          'destroying it on a failed check would erase the evidence of a live key. Key material kept.',
        remedy: `Retry when the backend is reachable, or re-run with ${DESTROY_FLAG} to remove the key material regardless.`,
      }
  }
}

/**
 * Write the #1681 tombstone unless the directory already carries one.
 * Returns whether THIS call wrote it. Shared with the #2551 replace path,
 * which retires a superseded directory after the new wiring is written.
 */
export async function tombstoneDirectoryIfAbsent(input: {
  directory: string
  agentId: string
  reason: string
  replacedBy?: string
  tombstonesDir?: string
}): Promise<boolean> {
  if ((await readOptionalText(join(input.directory, TOMBSTONE_FILENAME))) !== null) return false
  await writeAgentTombstone(input)
  return true
}

/**
 * The local half of a retirement: delete the signer private key and any
 * abandoned re-key, and strip the API key from `identity.json` while keeping
 * its orientation fields. This is what `--doctor`'s mutation-proof rule
 * requires before it will say `retired` instead of `superseded` — a tombstone
 * never excuses a live key. Nothing is revoked on the backend; that stays an
 * owner action on the Haven agent page. Shared by `--unwire` (#2169) and the
 * #2551 replace path.
 */
export async function teardownLocalKeyMaterial<T extends { api_key?: string }>(
  directory: string,
  identity: T | null,
): Promise<void> {
  await Promise.all([
    rm(join(directory, 'signer.json'), { force: true }),
    rm(join(directory, REKEY_PENDING_FILENAME), { force: true }),
  ])
  if (identity && identity.api_key !== undefined) {
    const { api_key: _dropped, ...rest } = identity
    await writeFile(join(directory, 'identity.json'), `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 })
  }
}

/** Parse a directory's `identity.json`, or `null` when absent/unreadable. Exported for the #2551 replace path. */
export async function readIdentityFile(directory: string): Promise<IdentityFile | null> {
  return identityAt(directory)
}
