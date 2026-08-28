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

export interface UnwireOutcome {
  directory: string
  agentId: string
  slug: string | undefined
  tombstoned: boolean
  runtimes: UnwireRuntimeOutcome[]
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
}

interface IdentityFile {
  agent_id?: string
  api_key?: string
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
  let tombstoned = false
  const tombstonePath = join(input.directory, TOMBSTONE_FILENAME)
  if ((await readOptionalText(tombstonePath)) === null) {
    await writeAgentTombstone({
      directory: input.directory,
      agentId,
      reason: input.reason ?? 'unwired via --unwire',
      replacedBy: input.replacedBy,
      tombstonesDir: input.tombstonesDir,
    })
    tombstoned = true
  }

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

  // ── Full local teardown of THIS directory's key material (#2169 AC). ─────
  // Unlike --tombstone's touch-nothing retirement, unwire tears the target's
  // local half down: its signer private key and any abandoned re-key are
  // deleted, and identity.json keeps its orientation fields but drops the API
  // key. That is what --doctor's mutation-proof rule requires before it will
  // say `retired` instead of `superseded` (tombstone never excuses a live
  // key), and #2155's mirrored record is what keeps the retirement observable
  // after the keys are gone. The backend is NOT revoked — that stays an owner
  // action on the Haven agent page.
  await Promise.all([
    rm(join(input.directory, 'signer.json'), { force: true }),
    rm(join(input.directory, REKEY_PENDING_FILENAME), { force: true }),
  ])
  if (identity && identity.api_key !== undefined) {
    const { api_key: _dropped, ...rest } = identity
    await writeFile(join(input.directory, 'identity.json'), `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 })
  }

  return { directory: input.directory, agentId, slug, tombstoned, runtimes }
}
