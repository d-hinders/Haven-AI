import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import crypto from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface StoredCredentialPaths {
  directory: string
  identityPath: string
  signerPath: string
  /** Non-secret orientation file (identity + configured budget, no keys). */
  agentPath: string
}

export interface WriteCredentialInput {
  baseDir?: string
  agentId: string
  /**
   * #1696: wiring slug. Named agents live at ~/.haven/agents/<slug>/ (stable
   * across a re-key by construction — the slug never rotates); unnamed keep
   * the historical ~/.haven/agents/<agent-uuid>/. Both schemes coexist.
   */
  serverName?: string
  apiKey: string
  delegateKey: string
  delegateAddress: string
  safeAddress?: string
  chainId?: number
  network?: string
  agentBudget?: Array<{
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
  apiUrl: string
  hostedMcpUrl: string
  x402BindingSigner?: string
  warn?: (message: string) => void
}

export interface PreflightCredentialStorageInput {
  baseDir?: string
  warn?: (message: string) => void
}

export async function preflightCredentialStorage(
  input: PreflightCredentialStorageInput = {},
): Promise<string> {
  const directory = defaultCredentialRoot(input.baseDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await restrictPermissions(directory, 0o700, input.warn)

  const probePath = join(directory, `.haven-connect-preflight-${crypto.randomBytes(8).toString('hex')}`)
  try {
    await writeOwnerOnlyJson(probePath, { ok: true }, input.warn)
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined)
  }

  return directory
}

export async function writeCredentialFiles(input: WriteCredentialInput): Promise<StoredCredentialPaths> {
  const directory = defaultAgentDirectory(input.serverName ?? input.agentId, input.baseDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await restrictPermissions(directory, 0o700, input.warn)

  const identityPath = join(directory, 'identity.json')
  const signerPath = join(directory, 'signer.json')
  const agentPath = join(directory, 'agent.json')

  await assertDoesNotExist(identityPath)
  await assertDoesNotExist(signerPath)
  await assertDoesNotExist(agentPath)

  await writeOwnerOnlyJson(signerPath, signerPayload(input), input.warn)

  try {
    await writeOwnerOnlyJson(identityPath, identityPayload(input), input.warn)
  } catch (err) {
    await rm(signerPath, { force: true }).catch(() => undefined)
    throw err
  }

  // Non-secret orientation file. Lets the agent answer "who am I and what may I
  // spend" on its first turn by reading one local file — no MCP round trip and
  // no exposure of the API key (identity.json) or delegate key (signer.json) in
  // the agent's transcript. Holds the *configured* budget; live remaining budget
  // still comes from haven_get_allowances before a payment.
  try {
    await writeOwnerOnlyJson(agentPath, agentPayload(input), input.warn)
  } catch (err) {
    // Roll back every file so a partial write (e.g. writeFile succeeds but chmod
    // fails) can't leave agent.json behind and block reconnection via
    // assertDoesNotExist on the next run.
    await rm(signerPath, { force: true }).catch(() => undefined)
    await rm(identityPath, { force: true }).catch(() => undefined)
    await rm(agentPath, { force: true }).catch(() => undefined)
    throw err
  }

  return { directory, identityPath, signerPath, agentPath }
}

// ── The three credential payloads, in one place ────────────────────────────
//
// Shared by the create path above and the re-key rewrite below (#1700). A
// second copy of these shapes is how a re-key ends up writing a credential set
// that setup would never have produced — a missing `x402_binding_signer`, a
// dropped budget — which nothing downstream would flag, because each file is
// individually well-formed.

function signerPayload(input: WriteCredentialInput): Record<string, unknown> {
  return {
    delegate_key: input.delegateKey,
    delegate_address: input.delegateAddress,
    agent_id: input.agentId,
    safe_address: input.safeAddress,
    chain_id: input.chainId,
    network: input.network,
    x402_binding_signer: input.x402BindingSigner,
    note: 'Local signer credential. Haven backend never receives this private key.',
  }
}

function identityPayload(input: WriteCredentialInput): Record<string, unknown> {
  return {
    api_key: input.apiKey,
    agent_id: input.agentId,
    safe_address: input.safeAddress,
    chain_id: input.chainId,
    network: input.network,
    api_url: input.apiUrl,
    hosted_mcp_url: input.hostedMcpUrl,
    agent_budget: input.agentBudget,
    note: 'Haven API key identifies the agent only. It cannot spend without the local signer key and on-chain Haven wallet rules.',
  }
}

function agentPayload(input: WriteCredentialInput): Record<string, unknown> {
  return {
    agent_id: input.agentId,
    delegate_address: input.delegateAddress,
    safe_address: input.safeAddress,
    chain_id: input.chainId,
    network: input.network,
    agent_budget: input.agentBudget,
    note: 'Non-secret orientation for the agent: public delegate/Haven wallet identity + configured budget. Contains no API key or signing key. For the live remaining budget, call haven_get_allowances.',
  }
}

// ── Re-key: rewriting a credential set IN PLACE (#1700) ────────────────────

/** What a re-key found on disk before it rewrote anything. */
export interface StoredCredentialSnapshot {
  directory: string
  agentId: string
  apiKey: string
  delegateAddress?: string
  safeAddress?: string
  chainId?: number
  network?: string
  apiUrl: string
  hostedMcpUrl: string
  x402BindingSigner?: string
  agentBudget?: WriteCredentialInput['agentBudget']
}

/**
 * Read the existing credential set a re-key is about to replace.
 *
 * Deliberately strict about the three fields a rewrite cannot invent — the
 * agent id, the current API key and the API URL. A directory missing any of
 * them is not a re-keyable agent, and guessing (say, defaulting the API URL to
 * localhost) would produce a credential set that authenticates against the
 * wrong Haven.
 */
export async function readStoredCredentials(
  serverName: string | undefined,
  agentIdOrSlug: string | undefined,
  baseDir?: string,
): Promise<StoredCredentialSnapshot> {
  const key = serverName ?? agentIdOrSlug
  const directory = key ? defaultAgentDirectory(key, baseDir) : await discoverSoleAgentDirectory(baseDir)

  const identity = await readJsonFile(join(directory, 'identity.json'))
  if (!identity) {
    throw new Error(
      `No Haven credentials at ${directory}. Nothing to re-key — connect this agent first, ` +
        'or pass the --name you wired it under.',
    )
  }
  const agent = (await readJsonFile(join(directory, 'agent.json'))) ?? {}
  const signer = (await readJsonFile(join(directory, 'signer.json'))) ?? {}

  const agentId = asString(identity.agent_id)
  const apiKey = asString(identity.api_key)
  const apiUrl = asString(identity.api_url)
  const hostedMcpUrl = asString(identity.hosted_mcp_url)
  if (!agentId || !apiKey || !apiUrl || !hostedMcpUrl) {
    throw new Error(
      `The credential set at ${directory} is incomplete (identity.json is missing agent_id, ` +
        'api_key, api_url or hosted_mcp_url). Re-key cannot rebuild it — reconnect the agent instead.',
    )
  }

  return {
    directory,
    agentId,
    apiKey,
    apiUrl,
    hostedMcpUrl,
    delegateAddress: asString(agent.delegate_address) ?? asString(signer.delegate_address),
    safeAddress: asString(identity.safe_address) ?? asString(agent.safe_address),
    chainId: typeof identity.chain_id === 'number' ? identity.chain_id : undefined,
    network: asString(identity.network),
    x402BindingSigner: asString(signer.x402_binding_signer),
    agentBudget: Array.isArray(identity.agent_budget)
      ? (identity.agent_budget as WriteCredentialInput['agentBudget'])
      : undefined,
  }
}

/**
 * Find the one wired agent on this machine, when no `--name` was given.
 *
 * The unnamed agent's directory is keyed by its AGENT ID
 * (`~/.haven/agents/<agent-uuid>/`), which the person running the command does
 * not know and has no reason to — they never typed it. Requiring it was the
 * defect review caught: `--rekey` was unusable for the DEFAULT setup, the one
 * the help text describes as "omit --name for the bare pair", while working
 * fine for the named case the tests happened to cover.
 *
 * Discovery, not guessing. Exactly one candidate is resolved; several is an
 * ambiguity only the user can settle, so it refuses and NAMES them rather than
 * picking the newest — "newest wins" is the heuristic #1695 removed, and
 * silently re-keying the wrong agent is the worst outcome available here.
 * A tombstoned directory (#1681) is skipped: it is a deliberately retired
 * agent, never a re-key target.
 */
async function discoverSoleAgentDirectory(baseDir?: string): Promise<string> {
  const root = defaultCredentialRoot(baseDir)
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    throw new Error(`No Haven credentials found under ${root}. Connect an agent on this machine first.`)
  }

  const candidates: string[] = []
  for (const entry of entries) {
    const directory = join(root, entry)
    if (!(await readJsonFile(join(directory, 'identity.json')))) continue
    if (await readJsonFile(join(directory, 'TOMBSTONE.json'))) continue
    candidates.push(directory)
  }

  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) {
    throw new Error(`No Haven credentials found under ${root}. Connect an agent on this machine first.`)
  }
  throw new Error(
    `Several agents are wired on this machine, so --rekey cannot tell which one you mean:\n` +
      candidates.map((d) => `  ${d}`).join('\n') +
      '\nRe-run with --name <slug> to pick one.',
  )
}

/**
 * Replace an existing credential set in place, all-or-nothing.
 *
 * This is the ONLY path allowed to overwrite credential files, and the reason
 * `assertDoesNotExist` is not consulted here. That guard exists to stop a
 * re-run silently replacing a live agent's keys; a re-key is the one operation
 * whose whole purpose is to replace them, at a path that deliberately does not
 * move (#1694 owner decision — no new directory, no tombstone, so nothing
 * downstream has a dead path to chase).
 *
 * **Why the temp-then-rename dance.** The acceptance bar is that a failure
 * never leaves a MIXED set — the old signer key beside the new API key, or the
 * reverse. That pairing is worse than either generation intact: the agent
 * authenticates as itself and then signs with a key its delegation no longer
 * names, which is precisely the payer/signer mismatch #1690 exists to catch.
 * So every file is written and permission-set as a sibling temp FIRST, and only
 * once all three are safely on disk are they renamed into place. A failure
 * before the first rename touches nothing; a failure during the renames is
 * rolled back from the in-memory snapshot of the originals.
 *
 * The residual window is a hard process kill (SIGKILL, power loss) between two
 * renames — not an exception, which is handled. Closing that needs a
 * write-ahead marker and a recovery pass at startup; it is out of scope here
 * and named rather than papered over. `doctor` already reports a credential
 * set whose delegate address disagrees with the backend, which is what such a
 * kill would leave behind.
 */
export async function rewriteCredentialFiles(
  input: WriteCredentialInput,
): Promise<StoredCredentialPaths> {
  const directory = defaultAgentDirectory(input.serverName ?? input.agentId, input.baseDir)
  const identityPath = join(directory, 'identity.json')
  const signerPath = join(directory, 'signer.json')
  const agentPath = join(directory, 'agent.json')

  const targets: Array<{ path: string; payload: Record<string, unknown> }> = [
    { path: signerPath, payload: signerPayload(input) },
    { path: identityPath, payload: identityPayload(input) },
    { path: agentPath, payload: agentPayload(input) },
  ]

  // The originals, so a failure mid-rename can put back exactly what was there.
  const originals = new Map<string, string | null>()
  for (const { path } of targets) {
    originals.set(path, await readRawFile(path))
  }

  const temps: Array<{ from: string; to: string }> = []
  try {
    for (const { path, payload } of targets) {
      const temp = `${path}.rekey-${crypto.randomBytes(6).toString('hex')}.tmp`
      await writeOwnerOnlyJson(temp, payload, input.warn)
      temps.push({ from: temp, to: path })
    }
    // Every temp is on disk and mode-restricted before ANY of them lands.
    for (const { from, to } of temps) {
      await rename(from, to)
    }
  } catch (err) {
    for (const { from } of temps) await rm(from, { force: true }).catch(() => undefined)
    for (const [path, contents] of originals) {
      if (contents === null) {
        await rm(path, { force: true }).catch(() => undefined)
      } else {
        await writeFile(path, contents, { mode: 0o600 }).catch(() => undefined)
      }
    }
    throw err
  }

  return { directory, identityPath, signerPath, agentPath }
}

// ── The pending key, between the two re-key phases (#1700) ─────────────────
//
// `--rekey` generates the new keypair and then STOPS, because the dashboard
// needs its public address before it can run the five owner-signed steps that
// end in a new API key. The private half has to survive that gap.
//
// It lives in the agent's own credential directory, at 0600, beside the live
// signer key it is going to replace — the same directory, the same mode, the
// same machine. That is the point: it widens no boundary that the live key has
// not already crossed. It is a SECOND copy until `--rekey-finish` consumes it,
// which is why it expires and why both the finish and a fresh `--rekey` delete
// it rather than leaving it to rot.
//
// It is deliberately NOT a tombstone and NOT in a temp dir: a tombstone marks a
// dead path (#1681's recreation case) and there is no dead path here, while a
// temp dir is exactly the kind of world-traversable location a private key
// should never sit in.

export const REKEY_PENDING_FILENAME = 'rekey-pending.json'

/** How long a started re-key stays resumable. */
export const REKEY_PENDING_TTL_MS = 24 * 60 * 60 * 1000

export interface RekeyPending {
  agent_id: string
  new_delegate_address: string
  new_delegate_key: string
  started_at: string
  expires_at: string
}

export async function writeRekeyPending(
  directory: string,
  pending: RekeyPending,
  warn?: (message: string) => void,
): Promise<string> {
  const path = join(directory, REKEY_PENDING_FILENAME)
  // Overwrite deliberately: starting a re-key again replaces an earlier
  // unfinished attempt. Keeping the first would strand the owner on an address
  // the dashboard no longer shows, with no way to tell which is live.
  await rm(path, { force: true }).catch(() => undefined)
  await writeOwnerOnlyJson(path, { ...pending }, warn)
  return path
}

/**
 * Read a started re-key, or explain why there is nothing to finish.
 *
 * An EXPIRED pending file is an error rather than a silent miss: the owner
 * asked to finish a re-key, and "no pending re-key found" would send them
 * looking for a typo when the real answer is that it timed out and the address
 * in their dashboard is stale.
 */
export async function readRekeyPending(directory: string, now = Date.now()): Promise<RekeyPending> {
  const path = join(directory, REKEY_PENDING_FILENAME)
  const raw = await readJsonFile(path)
  if (!raw) {
    throw new Error(
      `No re-key in progress at ${directory}. Run the connector with --rekey first — it prints ` +
        'the new signing address to paste into the Haven agent page.',
    )
  }
  const pending = raw as unknown as RekeyPending
  if (!pending.new_delegate_key || !pending.new_delegate_address || !pending.agent_id) {
    throw new Error(`The pending re-key at ${path} is unreadable. Delete it and start again with --rekey.`)
  }
  if (pending.expires_at && Date.parse(pending.expires_at) < now) {
    throw new Error(
      `The re-key started at ${pending.started_at} has expired. Start again with --rekey — the ` +
        'address currently shown in your dashboard is no longer the one this machine holds.',
    )
  }
  return pending
}

export async function clearRekeyPending(directory: string): Promise<void> {
  await rm(join(directory, REKEY_PENDING_FILENAME), { force: true }).catch(() => undefined)
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readRawFile(path)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function readRawFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}


/**
 * #1696: a wiring slug keys a credential directory, and connect never
 * overwrites credential files — a taken slug is refused before any side
 * effect. A leftover EMPTY slug directory (no identity.json) does not count
 * as taken. Replacing a named agent's credentials in place is #1700's
 * explicit re-key path, never a re-run.
 */
export async function assertServerSlugAvailable(serverName: string, baseDir?: string): Promise<void> {
  const directory = defaultAgentDirectory(serverName, baseDir)
  try {
    await stat(join(directory, 'identity.json'))
  } catch {
    return
  }
  throw new Error(
    `The name "${serverName}" is already wired on this machine (${directory} holds credentials). ` +
      'Pick a different --name, or revoke and remove that agent first — connect never overwrites credentials.',
  )
}

export function defaultAgentDirectory(agentId: string, baseDir = join(homedir(), '.haven', 'agents')): string {
  return resolve(defaultCredentialRoot(baseDir), safePathPart(agentId))
}

export function defaultCredentialRoot(baseDir = join(homedir(), '.haven', 'agents')): string {
  return resolve(baseDir)
}

async function writeOwnerOnlyJson(
  path: string,
  value: Record<string, unknown>,
  warn: ((message: string) => void) | undefined,
): Promise<void> {
  const json = JSON.stringify(dropUndefined(value), null, 2)
  await writeFile(path, `${json}\n`, { mode: 0o600, flag: 'wx' })
  await restrictPermissions(path, 0o600, warn)
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_')
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return
    throw err
  }
  throw new Error(`Refusing to overwrite existing Haven credential file: ${path}`)
}

async function restrictPermissions(
  path: string,
  mode: 0o600 | 0o700,
  warn: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (err) {
    warn?.(
      `Warning: could not restrict permissions on ${path} to ${mode.toString(8)}. ` +
        `Move this credential to a private location or run chmod ${mode.toString(8)} ${path}. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
