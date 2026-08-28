/**
 * #1681 — the tombstone mechanism. What is pinned here is the OPERATIONAL
 * contract, not the file shapes: the generated wrapper must run as a real
 * subprocess with no dependencies and produce the diagnosis the #1681
 * forensics had to reconstruct by hand (agent id, retirement, the
 * every-long-lived-host restart rule) on stderr with a greppable marker; it
 * must exit non-zero so hosts treat it as a failed spawn, not a hung server;
 * and writing it must never touch key material — connect reports, the user
 * revokes.
 */
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TOMBSTONE_FILENAME,
  TOMBSTONE_MARKER,
  defaultTombstonesDir,
  readAgentTombstone,
  readTombstoneRecords,
  writeAgentTombstone,
} from './tombstone.js'

const run = promisify(execFile)

const AGENT = 'agent-dead-uuid'
const SECRET_KEY = 'sk_agent_tombsecret'
const PRIVATE_KEY = '0x' + '11'.repeat(32)

async function retiredDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'haven-tombstone-'))
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'identity.json'), JSON.stringify({ agent_id: AGENT, api_key: SECRET_KEY }))
  await writeFile(join(dir, 'signer.json'), JSON.stringify({ private_key: PRIVATE_KEY }))
  await writeFile(join(dir, 'bin', 'haven-signer.mjs'), '// the real wrapper')
  return dir
}

/** Isolated mirror root so tests never touch the real ~/.haven/tombstones. */
async function tempTombstonesDir() {
  return mkdtemp(join(tmpdir(), 'haven-tombstones-'))
}

describe('the tombstone script, run as the host would run it (#1681)', () => {
  it('MUTATION PROOF: exits 1 with the full diagnosis on stderr — marker, agent, reason, restart-every-host, doctor', async () => {
    const dir = await retiredDirectory()
    await writeAgentTombstone({
      directory: dir,
      agentId: AGENT,
      reason: 'superseded by re-run',
      replacedBy: 'agent-new',
      retiredAt: '2026-08-21T10:00:00.000Z',
      tombstonesDir: await tempTombstonesDir(),
    })

    const wrapper = join(dir, 'bin', 'haven-signer.mjs')
    let exitCode = 0
    let stderr = ''
    try {
      await run(process.execPath, [wrapper])
    } catch (err) {
      const failure = err as { code?: number; stderr?: string }
      exitCode = failure.code ?? 0
      stderr = failure.stderr ?? ''
    }

    // A zero exit would make the host treat the tombstone as a live server
    // and hang waiting for MCP frames — the exact masking this ends.
    expect(exitCode).toBe(1)
    expect(stderr).toContain(TOMBSTONE_MARKER)
    expect(stderr).toContain(AGENT)
    expect(stderr).toContain('superseded by re-run')
    expect(stderr).toContain('agent-new')
    expect(stderr).toContain('2026-08-21')
    // Finding B: one restart is not enough — every long-lived host holds its
    // own snapshot, each possibly parked on a different dead agent.
    expect(stderr).toMatch(/restart EVERY/i)
    expect(stderr).toMatch(/DIFFERENT old agent/)
    expect(stderr).toContain('--doctor')
  })

  it('the script and TOMBSTONE.json carry no secret material', async () => {
    const dir = await retiredDirectory()
    await writeAgentTombstone({ directory: dir, agentId: AGENT, reason: 'reset', tombstonesDir: await tempTombstonesDir() })

    for (const file of [join(dir, 'bin', 'haven-signer.mjs'), join(dir, TOMBSTONE_FILENAME)]) {
      const content = await readFile(file, 'utf8')
      expect(content).not.toContain(SECRET_KEY)
      expect(content).not.toContain(PRIVATE_KEY)
    }
  })

  it('MUTATION PROOF: key material is left byte-for-byte untouched — connect never revokes or deletes', async () => {
    const dir = await retiredDirectory()
    const identityBefore = await readFile(join(dir, 'identity.json'), 'utf8')
    const signerBefore = await readFile(join(dir, 'signer.json'), 'utf8')

    await writeAgentTombstone({ directory: dir, agentId: AGENT, reason: 'reset', tombstonesDir: await tempTombstonesDir() })

    expect(await readFile(join(dir, 'identity.json'), 'utf8')).toBe(identityBefore)
    expect(await readFile(join(dir, 'signer.json'), 'utf8')).toBe(signerBefore)
  })

  it('works on a directory whose bin/ was already deleted — the keys-already-gone reset shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-tombstone-bare-'))
    await writeAgentTombstone({ directory: dir, agentId: AGENT, reason: 'reset', tombstonesDir: await tempTombstonesDir() })

    const script = await readFile(join(dir, 'bin', 'haven-signer.mjs'), 'utf8')
    expect(script).toContain(TOMBSTONE_MARKER)
  })
})

describe('readAgentTombstone', () => {
  it('round-trips what writeAgentTombstone recorded', async () => {
    const dir = await retiredDirectory()
    const mirror = await tempTombstonesDir()
    const written = await writeAgentTombstone({
      directory: dir, agentId: AGENT, reason: 'reset', retiredAt: '2026-08-21T10:00:00.000Z',
      tombstonesDir: mirror,
    })
    // recordPath is the surviving mirror's path, not part of the in-place record
    const { recordPath, ...inPlace } = written
    expect(recordPath).toBe(join(mirror, `${AGENT}.json`))
    expect(await readAgentTombstone(dir)).toEqual(inPlace)
  })

  it('is null for an un-tombstoned directory and for a corrupt tombstone', async () => {
    const dir = await retiredDirectory()
    expect(await readAgentTombstone(dir)).toBeNull()
    await writeFile(join(dir, TOMBSTONE_FILENAME), 'not json')
    expect(await readAgentTombstone(dir)).toBeNull()
    await writeFile(join(dir, TOMBSTONE_FILENAME), JSON.stringify({ nope: true }))
    expect(await readAgentTombstone(dir)).toBeNull()
  })
})

describe('review hardening (#1681 findings 1 and 3)', () => {
  it('MUTATION PROOF: a secret pasted into --reason is redacted before it is persisted or embedded', async () => {
    const dir = await retiredDirectory()
    const mirror = await tempTombstonesDir()
    await writeAgentTombstone({
      directory: dir,
      agentId: AGENT,
      reason: 'leaked key sk_agent_leakedvalue123, rotated',
      replacedBy: 'agent-new sk_agent_alsoleaked1',
      tombstonesDir: mirror,
    })
    const files = [
      join(dir, 'bin', 'haven-signer.mjs'),
      join(dir, TOMBSTONE_FILENAME),
      // the surviving mirror must carry the same redaction discipline
      join(mirror, `${AGENT}.json`),
    ]
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      expect(content).not.toContain('sk_agent_leakedvalue123')
      expect(content).not.toContain('sk_agent_alsoleaked1')
      expect(content).toContain('sk_agent_[redacted]')
    }
  })

  it('refuses a directory that does not exist — a typo must not mint a fake retirement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-tombstone-typo-'))
    await expect(
      writeAgentTombstone({ directory: join(dir, 'no-such-agent'), agentId: AGENT, reason: 'x', tombstonesDir: await tempTombstonesDir() }),
    ).rejects.toThrow(/Not a directory/)
  })
})

describe('tombstone mirror (#1681 follow-up — record survives OUTSIDE the retired dir)', () => {
  it('writes a surviving record next to the in-place one and returns its path', async () => {
    const dir = await retiredDirectory()
    const mirror = await tempTombstonesDir()
    const info = await writeAgentTombstone({ directory: dir, agentId: AGENT, reason: 'reset', tombstonesDir: mirror })

    const recordPath = join(mirror, `${AGENT}.json`)
    expect(info.recordPath).toBe(recordPath)
    const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as { agent_id: string; reason: string }
    expect(parsed.agent_id).toBe(AGENT)
    expect(parsed.reason).toBe('reset')
  })

  it('readTombstoneRecords still lists a retiree whose directory was then DELETED — the case the in-place record cannot cover', async () => {
    const dir = await retiredDirectory()
    const mirror = await tempTombstonesDir()
    await writeAgentTombstone({ directory: dir, agentId: AGENT, reason: 'reset', tombstonesDir: mirror })

    // what a retirement flow does next: delete the whole agent directory
    await rm(dir, { recursive: true, force: true })

    const records = await readTombstoneRecords(mirror)
    expect(records).toHaveLength(1)
    expect(records[0].agent_id).toBe(AGENT)
    expect(records[0].recordPath).toBe(join(mirror, `${AGENT}.json`))
  })

  it('returns an empty list for a missing records root and ignores non-json/corrupt entries', async () => {
    const mirror = await tempTombstonesDir()
    expect(await readTombstoneRecords(mirror)).toEqual([])
    await writeFile(join(mirror, 'scrap.txt'), 'x')
    await writeFile(join(mirror, 'broken.json'), 'not json')
    expect(await readTombstoneRecords(mirror)).toEqual([])
  })

  it('defaultTombstonesDir lives outside the per-agent dirs, under ~/.haven', () => {
    expect(defaultTombstonesDir()).toMatch(/\.haven[/\\]tombstones$/)
  })
})
