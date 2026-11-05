/**
 * #4678 — the per-trial exact-value secret inventory.
 *
 * The throwaway identity creates FIVE secrets, and the redactor's env-var
 * list names none of them. These tests pin the two halves that make the
 * manifest safe: it is written mode-0600 and flushed before launch, and it is
 * consumed FAIL-CLOSED — a manifest that cannot be read refuses the whole
 * redaction rather than redacting nothing and reporting clean.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretManifest, readSecretManifest } from './secret-manifest.js'
import { loadSecrets, redactSessionText, scanSessionText, totalOf } from './redact-sessions.js'

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-manifest-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The five secret classes the throwaway identity generates (#4678). */
const SECRETS = {
  throwaway_owner_key: `0x${'a1'.repeat(32)}`,
  throwaway_delegate_key: `0x${'b2'.repeat(32)}`,
  throwaway_signup_password: 'Qa-0123456789abcdef01234567',
  throwaway_signup_token: 'tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  throwaway_agent_api_key: 'sk_agent_7c6b5a4938271605f4e3d2c1b0a99887',
}

describe('SecretManifest', () => {
  it('writes mode 0600 and reads back every entry in order', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    const manifest = await SecretManifest.create(path)
    for (const [name, value] of Object.entries(SECRETS)) await manifest.append(name, value)

    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)

    const read = await readSecretManifest(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.secrets.map((s) => s.name)).toEqual(Object.keys(SECRETS))
    expect(read.secrets.every((s) => s.required)).toBe(true)
    expect(read.secrets.map((s) => s.value)).toEqual(Object.values(SECRETS))
  })

  it('flushes each append to disk before returning (a crash cannot lose a secret the agent already holds)', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    const manifest = await SecretManifest.create(path)
    await manifest.append('throwaway_owner_key', SECRETS.throwaway_owner_key)
    // Read the file WITHOUT closing the manifest: the line must already be there.
    expect(await readFile(path, 'utf8')).toContain(SECRETS.throwaway_owner_key)
  })

  it('remove() deletes the manifest', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    const manifest = await SecretManifest.create(path)
    await manifest.append('throwaway_owner_key', SECRETS.throwaway_owner_key)
    await manifest.remove()
    await expect(stat(path)).rejects.toThrow()
  })
})

describe('readSecretManifest — fail-closed', () => {
  it('refuses a missing manifest', async () => {
    const dir = await scratch()
    const read = await readSecretManifest(join(dir, 'nope.json'))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('could not be read')
  })

  it('refuses an EMPTY manifest — an empty list would redact nothing and still report clean', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    await writeFile(path, '\n\n', { mode: 0o600 })
    const read = await readSecretManifest(path)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('is empty')
  })

  it('refuses a malformed line', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    await writeFile(path, '{"name":"a","value":"b"}\nnot json\n', { mode: 0o600 })
    const read = await readSecretManifest(path)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('line 2 is not JSON')
  })

  it('refuses an entry without a name or value', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    await writeFile(path, '{"name":"","value":"b"}\n', { mode: 0o600 })
    const read = await readSecretManifest(path)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('is not {name, value}')
  })
})

describe('every generated secret class redacts from tool args, tool results and final text', () => {
  /** A stream-JSON session carrying all five secrets in all three places. */
  function session(): string {
    const [owner, delegate, password, token, apiKey] = Object.values(SECRETS)
    const lines = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__haven-eval__haven_get_agent',
              // tool ARGS
              input: { owner_key: owner, delegate_key: delegate, password, bearer: token, api_key: apiKey },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: [
                // tool RESULT
                { type: 'text', text: JSON.stringify({ echoed: { owner, delegate, password, token, apiKey } }) },
              ],
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            // final TEXT
            { type: 'text', text: `I used ${owner} / ${delegate} / ${password} / ${token} / ${apiKey}` },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: `done: ${owner} ${delegate} ${password} ${token} ${apiKey}` },
    ]
    return lines.map((l) => JSON.stringify(l)).join('\n')
  }

  it('redacts all five classes and the independent scan finds nothing', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    const manifest = await SecretManifest.create(path)
    for (const [name, value] of Object.entries(SECRETS)) await manifest.append(name, value)
    const read = await readSecretManifest(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return

    const loaded = loadSecrets({}, [], [], read.secrets)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const { text, counts } = redactSessionText(session(), { secrets: loaded.secrets })
    // Every class was actually found in the raw input (a positive control).
    expect(counts['secret-exact']).toBeGreaterThan(0)
    // No secret value survives anywhere.
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value)
    // The independent scanner agrees.
    expect(totalOf(scanSessionText(text, loaded.secrets))).toBe(0)
  })

  it('a manifest entry that is NOT redacted is caught by the scan (the fail-closed half)', async () => {
    const dir = await scratch()
    const path = join(dir, 'manifest.json')
    const manifest = await SecretManifest.create(path)
    for (const [name, value] of Object.entries(SECRETS)) await manifest.append(name, value)
    const read = await readSecretManifest(path)
    if (!read.ok) throw new Error(read.error)
    const loaded = loadSecrets({}, [], [], read.secrets)
    if (!loaded.ok) throw new Error('load failed')

    // Disable the exact-value rule: the scan must still catch the leak.
    const { text } = redactSessionText(session(), { secrets: loaded.secrets, disabled: new Set(['secret-exact']) })
    expect(totalOf(scanSessionText(text, loaded.secrets))).toBeGreaterThan(0)
  })
})
