/**
 * The per-trial exact-value secret inventory (#4678).
 *
 * The throwaway identity creates FIVE secrets, not two: the owner key, the
 * delegate key, the signup password, the signup bearer token and the agent
 * API key (`lib/throwaway-identity.ts`). The transcript redactor loads exact
 * values only from NAMED env vars (`redact-sessions-cli.ts`), and a 32-byte
 * key has the shape of a transaction hash — which the transcripts must keep —
 * so no generic rule catches it. A secret that never reaches the redactor's
 * needle list is a secret that ships in a public artifact.
 *
 * So every generated secret is appended to a manifest BEFORE the agent
 * launches, and the redactor consumes that manifest FAIL-CLOSED: a manifest
 * that is missing, unreadable, empty or malformed refuses the whole redaction
 * and writes nothing.
 *
 * The file is mode `0600`, lives OUTSIDE every report and upload path, and is
 * deleted in an `always()` workflow step after the scan. The workflow guard
 * (`scripts/ci/agent-evals-workspace-deps.test.mjs`) proves it cannot be
 * printed or uploaded.
 *
 * Format: one JSON object per line, `{"name":"…","value":"…"}`. JSON Lines
 * rather than one array so an append is a single `write` + `fsync` — a crash
 * mid-run leaves every secret written so far, never a truncated array.
 */

import { appendFile, chmod, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RawSecret } from './redact-sessions.js'

/** One line of the manifest. */
interface ManifestLine {
  name: string
  value: string
}

/**
 * The manifest writer. `append` writes one line and fsyncs it, so a secret is
 * durable before the caller launches the agent that could echo it.
 */
export class SecretManifest {
  private constructor(private readonly path: string) {}

  /**
   * Create (or truncate) the manifest at `path`, mode `0600`, in a directory
   * created mode `0700`. The caller owns the path; it must sit outside every
   * report and upload path.
   */
  static async create(path: string): Promise<SecretManifest> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const handle = await open(path, 'w', 0o600)
    await handle.close()
    // `open`'s mode is masked by the umask; chmod is what actually pins 0600.
    await chmod(path, 0o600)
    return new SecretManifest(path)
  }

  get filePath(): string {
    return this.path
  }

  /** Append one secret and flush it to disk before returning. */
  async append(name: string, value: string): Promise<void> {
    if (!name || !value) return
    const line: ManifestLine = { name, value }
    await appendFile(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    // appendFile does not fsync; a crash between the write and the launch
    // would lose the secret from the inventory while the agent still holds
    // it. Flush explicitly.
    const handle = await open(this.path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Delete the manifest. Called in the workflow's `always()` step after the scan. */
  async remove(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

export type ReadManifestResult = { ok: true; secrets: RawSecret[] } | { ok: false; error: string }

/**
 * Read the manifest FAIL-CLOSED. Every failure mode is a refusal, never an
 * empty list: an empty list would redact nothing and still report clean.
 */
export async function readSecretManifest(path: string): Promise<ReadManifestResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    return { ok: false, error: `the secret manifest ${path} could not be read (${(err as Error).name})` }
  }
  const secrets: RawSecret[] = []
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    return { ok: false, error: `the secret manifest ${path} is empty — nothing would be redacted` }
  }
  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { ok: false, error: `the secret manifest ${path} line ${index + 1} is not JSON` }
    }
    const entry = parsed as Partial<ManifestLine>
    if (typeof entry.name !== 'string' || entry.name.length === 0 || typeof entry.value !== 'string' || entry.value.length === 0) {
      return { ok: false, error: `the secret manifest ${path} line ${index + 1} is not {name, value}` }
    }
    secrets.push({ name: entry.name, value: entry.value, required: true })
  }
  return { ok: true, secrets }
}
