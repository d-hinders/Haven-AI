/**
 * Existing-agent wiring collision at setup (#2551).
 *
 * A second setup on one machine used to be resolved AFTER the fact: the
 * #1569 remove-first install overwrote the bare `haven` / `haven-signer`
 * pair, and the #1688 heads-up then told the user, in a run that had already
 * moved on, that their previous agent still held a live key. The connector
 * had the information all along — it just acted on it after the write.
 *
 * This module moves the decision to the moment of conflict, in the component
 * that can see it, and BEFORE anything is minted or written. Three rules:
 *
 * - **Local reads only.** Detection scans the credential root this run would
 *   write into — the same directories `--doctor` classifies — and never calls
 *   Haven. That is what lets it run ahead of `registerSetup`: a declined or
 *   refused run leaves no orphaned `pending_approval` agent behind, because
 *   nothing was registered.
 * - **The doctor's vocabulary, not a second definition.** A collision is a
 *   directory the doctor would call `wired` or `superseded` — one holding a
 *   USABLE key (an `identity.json` with an `api_key`) and no `TOMBSTONE.json`
 *   — that this run's bare pair would displace. `retired`, `orphaned` and
 *   `parked` directories never trigger it; nor does a NAMED directory, whose
 *   own `haven-<slug>` pair coexists with the bare one by construction
 *   (#1695). A `--name` run displaces nothing, so it never collides here;
 *   its one refusal (a taken slug) is `assertServerSlugAvailable`.
 * - **Connect never revokes.** The replace path retires the superseded
 *   directory LOCALLY — tombstone, then the same key-material teardown
 *   `--unwire` performs — and names the agent for the owner to revoke on the
 *   Haven agent page. `POST /agents/:id/revoke` is owner-authenticated; an
 *   agent credential revoking a sibling agent is exactly the "agent editing
 *   its own authority" the re-key routes refuse (#1694).
 *
 * "Usable" is decided locally, exactly as the doctor decides it before its
 * live probe: a key the owner already revoked in the dashboard still reads as
 * usable here. That is the honest limit of a check that makes no network
 * call, and the refusal names the ids so the owner can tell.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { assertValidServerSlug } from './server-names.js'
import { readRuntimeSidecar } from './signer-runtime.js'
import { defaultCredentialRoot } from './storage.js'
import { TOMBSTONE_FILENAME } from './tombstone.js'
import type { PromptIo } from './installed-clients.js'

export interface SupersededDirectory {
  directory: string
  /** Agent id from `identity.json`, or the directory name when it is missing. */
  agentId: string
}

export interface WiringCollision {
  /** Every bare-pair directory holding a usable key — what this run would displace. */
  superseded: readonly SupersededDirectory[]
  /**
   * A valid, collision-checked slug the user can take to install alongside
   * instead. Derived from the agent name Haven resolved for this setup, so
   * the proposal reads as the agent rather than as a counter.
   */
  suggestedServerName: string
}

export type WiringCollisionResolution =
  | { action: 'replace' }
  | { action: 'alongside'; serverName: string }
  | { action: 'abort' }

/**
 * Directories under the credential root that a BARE-pair setup would
 * displace. `null` when there is nothing to displace — a clean machine, a
 * machine holding only retired/orphaned/parked directories, or one holding
 * only named agents.
 */
export async function detectWiringCollision(input: {
  credentialsDir?: string
  agentName: string
}): Promise<WiringCollision | null> {
  const root = defaultCredentialRoot(input.credentialsDir)
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return null
  }
  const superseded: SupersededDirectory[] = []
  const taken = new Set<string>()
  for (const entry of entries) {
    const directory = join(root, entry)
    let identityRaw: string
    try {
      identityRaw = await readFile(join(directory, 'identity.json'), 'utf8')
    } catch {
      // No identity: retired-with-keys-removed, parked, or not an agent
      // directory at all. None of these holds a usable key.
      continue
    }
    taken.add(entry)
    let identity: { agent_id?: string; api_key?: string } | undefined
    try {
      identity = JSON.parse(identityRaw) as { agent_id?: string; api_key?: string }
    } catch {
      identity = undefined
    }
    // The doctor's `orphaned`: an identity that yields no usable key.
    if (!identity?.api_key) continue
    // The doctor's `retired` outranks everything else it can see.
    if (await pathExists(join(directory, TOMBSTONE_FILENAME))) continue
    // A NAMED agent owns `haven-<slug>`; the bare pair leaves it alone.
    const sidecar = await readRuntimeSidecar(directory)
    if (sidecar?.server_name) continue
    superseded.push({ directory, agentId: identity.agent_id ?? entry })
  }
  if (superseded.length === 0) return null
  return {
    superseded,
    suggestedServerName: proposeServerSlug(input.agentName, taken),
  }
}

/**
 * A valid slug from a display name, de-collided against the directory names
 * already under the credential root. The slug is what a `--name` install is
 * keyed on (#1696), so it has to pass `assertValidServerSlug` and must not be
 * a directory that already holds credentials.
 *
 * A name that slugifies to nothing usable (empty, or one of the reserved
 * names the validator refuses) falls back to `agent`, and a taken candidate
 * gains a numeric suffix. The proposal is exactly that — a proposal: the user
 * types it back (or their own), and the ordinary `--name` path validates it
 * again before anything is written.
 */
export function proposeServerSlug(agentName: string, taken: ReadonlySet<string>): string {
  let base = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
    .replace(/-+$/g, '')
  if (!slugIsValid(base)) base = 'agent'
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/g, '')}${suffix}`
    if (slugIsValid(candidate) && !taken.has(candidate)) return candidate
  }
  // Unreachable in practice (999 same-named directories); never return a
  // taken or invalid slug, so refuse loudly rather than propose one.
  throw new Error(`Could not propose an unused server name for ${JSON.stringify(agentName)}.`)
}

function slugIsValid(slug: string): boolean {
  try {
    assertValidServerSlug(slug)
    return true
  } catch {
    return false
  }
}

/** Bounded so a piped-but-TTY-looking stdin cannot spin forever (the #1719 rule). */
const MAX_PROMPT_ATTEMPTS = 3

/**
 * The interactive choice at the conflict. Only reached through the #1719 gate
 * (`interactive` AND a TTY stdin) — a `--json`, CI or agent run never sees it
 * and gets the typed refusal instead.
 *
 * Empty input is NOT a default: replacing retires a working agent's local
 * key material, and installing alongside changes the server names every host
 * will see, so neither is the thing to do because someone pressed Enter.
 * Three unrecognised answers abort, having written nothing.
 */
export async function promptWiringCollisionResolution(
  collision: WiringCollision,
  agentName: string,
  io: PromptIo,
): Promise<WiringCollisionResolution> {
  const ids = collision.superseded.map((entry) => entry.agentId).join(', ')
  io.write(`This machine is already wired to a Haven agent with a live key: ${ids}.\n`)
  io.write(`Setting up "${agentName}" on the bare haven / haven-signer pair would replace that wiring.\n`)
  io.write('  r) replace — re-point haven / haven-signer at the new agent and retire the previous directory locally\n')
  io.write('     (tombstoned, local key files removed; you still revoke it on the Haven agent page)\n')
  io.write(`  a) alongside — install as a named agent (suggested: ${collision.suggestedServerName}) with its own\n`)
  io.write(`     haven-<name> / haven-signer-<name> pair, leaving the current wiring untouched\n`)
  io.write('  q) quit — nothing is written and the setup token stays unused\n')
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = await io.question('Replace, install alongside, or quit? [r/a/q]: ')
    if (answer === null) return { action: 'abort' }
    const trimmed = answer.trim().toLowerCase()
    if (trimmed === 'r' || trimmed === 'replace') return { action: 'replace' }
    if (trimmed === 'q' || trimmed === 'quit') return { action: 'abort' }
    if (trimmed === 'a' || trimmed === 'alongside') {
      const typed = await io.question(`Server name [${collision.suggestedServerName}]: `)
      if (typed === null) return { action: 'abort' }
      const serverName = typed.trim() === '' ? collision.suggestedServerName : typed.trim()
      try {
        assertValidServerSlug(serverName)
      } catch (err) {
        io.write(`${err instanceof Error ? err.message : String(err)}\n`)
        continue
      }
      return { action: 'alongside', serverName }
    }
    io.write(`"${trimmed}" is not one of r, a, q.\n`)
  }
  return { action: 'abort' }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
