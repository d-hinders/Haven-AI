import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectWiringCollision,
  promptWiringCollisionResolution,
  proposeServerSlug,
  type WiringCollision,
} from './wiring-collision.js'
import type { PromptIo } from './installed-clients.js'

describe('proposeServerSlug (#2551)', () => {
  const none = new Set<string>()

  it('slugifies a display name into a valid --name', () => {
    expect(proposeServerSlug('Payment Agent', none)).toBe('payment-agent')
    expect(proposeServerSlug('  Ops -- Bot #2  ', none)).toBe('ops-bot-2')
    expect(proposeServerSlug('Ünïcödé Agent', none)).toBe('n-c-d-agent')
  })

  it('never proposes a reserved or empty slug', () => {
    // The validator refuses these; the proposal must not hand them back.
    expect(proposeServerSlug('haven', none)).toBe('agent')
    expect(proposeServerSlug('haven-signer', none)).toBe('agent')
    expect(proposeServerSlug('signer', none)).toBe('agent')
    expect(proposeServerSlug('signer-x', none)).toBe('agent')
    expect(proposeServerSlug('***', none)).toBe('agent')
    expect(proposeServerSlug('', none)).toBe('agent')
  })

  it('de-collides against directories already under the credential root', () => {
    expect(proposeServerSlug('Payment Agent', new Set(['payment-agent']))).toBe('payment-agent-2')
    expect(proposeServerSlug('Payment Agent', new Set(['payment-agent', 'payment-agent-2']))).toBe('payment-agent-3')
  })

  it('keeps a long name inside the 32-character slug limit, suffix included', () => {
    const long = 'a'.repeat(40)
    expect(proposeServerSlug(long, none)).toBe('a'.repeat(32))
    const suffixed = proposeServerSlug(long, new Set(['a'.repeat(32)]))
    expect(suffixed).toBe(`${'a'.repeat(30)}-2`)
    expect(suffixed.length).toBe(32)
  })
})

describe('detectWiringCollision (#2551)', () => {
  async function seed(root: string, name: string, files: Record<string, unknown>) {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content))
    }
    return dir
  }

  it('returns null for a missing or empty credential root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-2551-detect-empty-'))
    expect(await detectWiringCollision({ credentialsDir: root, agentName: 'A' })).toBeNull()
    expect(await detectWiringCollision({ credentialsDir: join(root, 'nope'), agentName: 'A' })).toBeNull()
  })

  it('names every bare directory holding a usable key, by agent id, with a de-collided proposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-2551-detect-'))
    const a = await seed(root, 'old-a', { 'identity.json': { api_key: 'sk_agent_a', agent_id: 'agent-a' } })
    const b = await seed(root, 'old-b', { 'identity.json': { api_key: 'sk_agent_b', agent_id: 'agent-b' } })
    // A corrupt identity is orphaned (not usable) — the #1688 heads-up names
    // such a directory, the collision check does not: it cannot spend.
    await seed(root, 'corrupt', { 'identity.json': '{not json' })
    await seed(root, 'payment-agent', { 'identity.json': { agent_id: 'no-key' } })

    const collision = await detectWiringCollision({ credentialsDir: root, agentName: 'Payment Agent' })

    expect(collision).not.toBeNull()
    expect([...collision!.superseded].sort((x, y) => x.agentId.localeCompare(y.agentId))).toEqual([
      { directory: a, agentId: 'agent-a' },
      { directory: b, agentId: 'agent-b' },
    ])
    // 'payment-agent' holds an identity.json (even keyless), so it is taken.
    expect(collision!.suggestedServerName).toBe('payment-agent-2')
  })

  it('falls back to the directory name when identity.json has no agent_id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-2551-detect-noid-'))
    await seed(root, 'mystery', { 'identity.json': { api_key: 'sk_agent_x' } })
    const collision = await detectWiringCollision({ credentialsDir: root, agentName: 'A' })
    expect(collision?.superseded.map((e) => e.agentId)).toEqual(['mystery'])
  })

  it('ignores retired, orphaned, parked and NAMED directories — the doctor\'s vocabulary, not a second one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-2551-detect-none-'))
    await seed(root, 'retired', { 'identity.json': { api_key: 'sk', agent_id: 'r' }, 'TOMBSTONE.json': { agent_id: 'r', retired_at: 'x', reason: 'y' } })
    await seed(root, 'retired-clean', { 'TOMBSTONE.json': { agent_id: 'rc', retired_at: 'x', reason: 'y' } })
    await seed(root, 'orphan', { 'identity.json': { agent_id: 'o' } })
    await seed(root, 'parked', { 'rekey-pending.json': { agent_id: 'p' } })
    await seed(root, 'ops', { 'identity.json': { api_key: 'sk', agent_id: 'ops' }, 'signer-runtime.json': { server_name: 'ops', wrapper_path: '/w' } })
    await writeFile(join(root, '.DS_Store'), 'junk')
    expect(await detectWiringCollision({ credentialsDir: root, agentName: 'A' })).toBeNull()
  })
})

describe('promptWiringCollisionResolution (#2551)', () => {
  const collision: WiringCollision = {
    superseded: [{ directory: '/x/old', agentId: 'agent-old' }],
    suggestedServerName: 'payment-agent',
  }

  function io(answers: Array<string | null>): PromptIo & { written: string[] } {
    const written: string[] = []
    const queue = [...answers]
    return {
      written,
      write: (text) => written.push(text),
      question: vi.fn(async () => (queue.length > 0 ? queue.shift()! : null)),
    }
  }

  it('names the superseded agent and both choices before asking', async () => {
    const fake = io(['r'])
    await promptWiringCollisionResolution(collision, 'Payment Agent', fake)
    const shown = fake.written.join('')
    expect(shown).toContain('agent-old')
    expect(shown).toContain('replace')
    expect(shown).toContain('alongside')
    expect(shown).toContain('payment-agent')
    expect(shown).toMatch(/revoke it on the Haven agent page/)
  })

  it.each([
    ['r', 'replace'],
    ['REPLACE', 'replace'],
    ['q', 'abort'],
    ['quit', 'abort'],
  ])('%s → %s', async (answer, action) => {
    expect((await promptWiringCollisionResolution(collision, 'A', io([answer]))).action).toBe(action)
  })

  it('"a" then Enter takes the proposed name; a typed name wins over it', async () => {
    expect(await promptWiringCollisionResolution(collision, 'A', io(['a', '']))).toEqual({ action: 'alongside', serverName: 'payment-agent' })
    expect(await promptWiringCollisionResolution(collision, 'A', io(['alongside', ' research ']))).toEqual({ action: 'alongside', serverName: 'research' })
  })

  it('an invalid typed slug is refused and the question is asked again', async () => {
    const fake = io(['a', 'Bad Name!', 'r'])
    const result = await promptWiringCollisionResolution(collision, 'A', fake)
    expect(fake.written.join('')).toMatch(/Invalid server name/)
    expect(result).toEqual({ action: 'replace' })
  })

  it('empty input is NOT a default, and three unrecognised answers abort', async () => {
    const fake = io(['', 'x', 'maybe'])
    expect((await promptWiringCollisionResolution(collision, 'A', fake)).action).toBe('abort')
    expect(fake.question).toHaveBeenCalledTimes(3)
  })

  it('EOF / Ctrl-C aborts at either question', async () => {
    expect((await promptWiringCollisionResolution(collision, 'A', io([null]))).action).toBe('abort')
    expect((await promptWiringCollisionResolution(collision, 'A', io(['a', null]))).action).toBe('abort')
  })
})
