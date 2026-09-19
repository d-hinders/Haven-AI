import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_ROTATE_BYTES,
  appendSigningAuditEntry,
  createSigningAuditEntry,
  defaultSigningAuditPath,
  hashPayloadForAudit,
} from './audit.js'

const posix = process.platform !== 'win32'
const entryAt = (when: string) =>
  createSigningAuditEntry(
    'haven_sign',
    `0x${'bb'.repeat(32)}`,
    { delegateAddress: '0x000000000000000000000000000000000000dEaD' },
    new Date(when),
  )

describe('signing audit', () => {
  it('hashes payload objects deterministically', () => {
    const a = hashPayloadForAudit({ b: 2, a: { z: 3, y: [1, 2] } })
    const b = hashPayloadForAudit({ a: { y: [1, 2], z: 3 }, b: 2 })
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('builds an audit entry with no signing artifacts', () => {
    const entry = createSigningAuditEntry(
      'haven_sign',
      `0x${'aa'.repeat(32)}`,
      {
        delegateAddress: '0x000000000000000000000000000000000000dEaD',
        accountAddress: '0x000000000000000000000000000000000000Cafe',
        chainId: 100,
      },
      new Date('2026-01-02T03:04:05.000Z'),
    )
    // The in-memory context field is `accountAddress` (#2914); the
    // serialized JSONL key stays `safe_address` — a permanent, on-disk
    // spelling, distinct from the in-memory naming.
    expect(entry).toEqual({
      version: 1,
      timestamp: '2026-01-02T03:04:05.000Z',
      tool: 'haven_sign',
      payload_hash: `0x${'aa'.repeat(32)}`,
      delegate_address: '0x000000000000000000000000000000000000dEaD',
      safe_address: '0x000000000000000000000000000000000000Cafe',
      chain_id: 100,
    })
    expect(JSON.stringify(entry)).not.toContain('signature')
    expect(JSON.stringify(entry)).not.toContain('payment_header')
    expect(JSON.stringify(entry)).not.toContain('delegate_key')
  })

  it('appends JSONL entries locally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const entry = createSigningAuditEntry(
        'haven_sign',
        `0x${'bb'.repeat(32)}`,
        { delegateAddress: '0x000000000000000000000000000000000000dEaD' },
        new Date('2026-01-02T03:04:05.000Z'),
      )
      await appendSigningAuditEntry(entry, auditPath)
      const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
      expect(rows).toHaveLength(1)
      expect(JSON.parse(rows[0])).toEqual(entry)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('the sidecar is owner-only and bounded (#3172)', () => {
    it.skipIf(!posix)('creates the sidecar 0600 — the mode the credential beside it is expected to have', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-mode-'))
      const auditPath = join(dir, 'agent.json.signer-audit.jsonl')
      const logged: string[] = []
      try {
        // platform 'win32' disables the tighten step and the umask is pinned
        // to the common 022, so the ONLY thing that can make this file 0600
        // is the mode passed at creation — a restrictive umask on the test
        // machine cannot mask a dropped mode either.
        const previousUmask = process.umask(0o022)
        try {
          await appendSigningAuditEntry(entryAt('2026-01-02T03:04:05.000Z'), auditPath, { log: (m) => logged.push(m), platform: 'win32' })
        } finally {
          process.umask(previousUmask)
        }
        expect(((await stat(auditPath)).mode & 0o777).toString(8)).toBe('600')
        expect(logged).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it.skipIf(!posix)('a symlink planted at the sidecar path is never chmod-ed through — it is warned about', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-link-'))
      const target = join(dir, 'unrelated.txt')
      const auditPath = join(dir, 'agent.json.signer-audit.jsonl')
      const logged: string[] = []
      try {
        await writeFile(target, 'keep me group-readable\n')
        await chmod(target, 0o644)
        await symlink(target, auditPath)
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:05.000Z'), auditPath, { log: (m) => logged.push(m) })
        expect(((await stat(target)).mode & 0o777).toString(8)).toBe('644')
        expect(logged).toHaveLength(1)
        expect(logged[0]).toMatch(/not a regular file/)
        expect(logged[0]).toMatch(/chmod 600/)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('two appends racing at the bound both succeed — a produced signature is never lost to the rotation', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-race-'))
      const auditPath = join(dir, 'audit.jsonl')
      try {
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:05.000Z'), auditPath)
        const size = (await stat(auditPath)).size
        await expect(
          Promise.all([
            appendSigningAuditEntry(entryAt('2026-01-02T03:04:06.000Z'), auditPath, { rotateAtBytes: size }),
            appendSigningAuditEntry(entryAt('2026-01-02T03:04:07.000Z'), auditPath, { rotateAtBytes: size }),
          ]),
        ).resolves.toHaveLength(2)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it.skipIf(!posix)('tightens a pre-#3172 world-readable sidecar in place and says so once — because it is fixed, not because it stopped looking', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-mode-'))
      const auditPath = join(dir, 'agent.json.signer-audit.jsonl')
      const logged: string[] = []
      try {
        await writeFile(auditPath, `${JSON.stringify(entryAt('2026-01-01T00:00:00.000Z'))}\n`)
        await chmod(auditPath, 0o644)
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:05.000Z'), auditPath, { log: (m) => logged.push(m) })
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:06.000Z'), auditPath, { log: (m) => logged.push(m) })
        expect(((await stat(auditPath)).mode & 0o777).toString(8)).toBe('600')
        expect(logged).toHaveLength(1)
        expect(logged[0]).toContain('audit sidecar')
        expect(logged[0]).toMatch(/0644/)
        expect(logged[0]).toMatch(/tightened to 0600/)
        const rows = (await readFile(auditPath, 'utf8')).trim().split('\n')
        expect(rows).toHaveLength(3)
        // An operator loosening it mid-process is caught on the very next append.
        await chmod(auditPath, 0o644)
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:07.000Z'), auditPath, { log: (m) => logged.push(m) })
        expect(((await stat(auditPath)).mode & 0o777).toString(8)).toBe('600')
        expect(logged).toHaveLength(2)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rotates to <path>.1 when the live file reaches the bound, keeping one predecessor', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-rotate-'))
      const auditPath = join(dir, 'audit.jsonl')
      try {
        const first = entryAt('2026-01-02T03:04:05.000Z')
        await appendSigningAuditEntry(first, auditPath)
        const size = (await stat(auditPath)).size
        // Bound == current size: the NEXT append rotates before writing.
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:06.000Z'), auditPath, { rotateAtBytes: size })
        const live = (await readFile(auditPath, 'utf8')).trim().split('\n')
        const rotated = (await readFile(`${auditPath}.1`, 'utf8')).trim().split('\n')
        expect(live).toHaveLength(1)
        expect(JSON.parse(live[0]).timestamp).toBe('2026-01-02T03:04:06.000Z')
        expect(rotated).toHaveLength(1)
        expect(JSON.parse(rotated[0])).toEqual(first)
        // A second rotation REPLACES .1 — two generations, never three.
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:07.000Z'), auditPath, { rotateAtBytes: size })
        const rotated2 = (await readFile(`${auditPath}.1`, 'utf8')).trim().split('\n')
        expect(JSON.parse(rotated2[0]).timestamp).toBe('2026-01-02T03:04:06.000Z')
        expect(AUDIT_ROTATE_BYTES).toBe(8 * 1024 * 1024)
        if (posix) expect(((await stat(auditPath)).mode & 0o777).toString(8)).toBe('600')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it.skipIf(!posix)('a pre-#3172 world-readable sidecar that rotates is tightened as <path>.1 too — history is never left readable', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-rotate-'))
      const auditPath = join(dir, 'audit.jsonl')
      const logged: string[] = []
      try {
        await writeFile(auditPath, `${JSON.stringify(entryAt('2026-01-01T00:00:00.000Z'))}\n`)
        await chmod(auditPath, 0o644)
        const size = (await stat(auditPath)).size
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:05.000Z'), auditPath, { rotateAtBytes: size, log: (m) => logged.push(m) })
        expect(((await stat(`${auditPath}.1`)).mode & 0o777).toString(8)).toBe('600')
        expect(((await stat(auditPath)).mode & 0o777).toString(8)).toBe('600')
        expect(logged.some((m) => m.includes('audit sidecar') && /tightened to 0600/.test(m))).toBe(true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('does not rotate below the bound', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-audit-rotate-'))
      const auditPath = join(dir, 'audit.jsonl')
      try {
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:05.000Z'), auditPath)
        await appendSigningAuditEntry(entryAt('2026-01-02T03:04:06.000Z'), auditPath)
        expect((await readFile(auditPath, 'utf8')).trim().split('\n')).toHaveLength(2)
        await expect(stat(`${auditPath}.1`)).rejects.toThrow()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('defaults to a credential sidecar when credentials are file-backed', () => {
    expect(defaultSigningAuditPath('/tmp/haven-agent.json')).toBe(
      '/tmp/haven-agent.json.signer-audit.jsonl',
    )
  })
})
