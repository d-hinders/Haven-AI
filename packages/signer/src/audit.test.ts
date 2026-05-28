import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendSigningAuditEntry,
  createSigningAuditEntry,
  defaultSigningAuditPath,
  hashPayloadForAudit,
} from './audit.js'

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
        safeAddress: '0x000000000000000000000000000000000000Cafe',
        chainId: 100,
      },
      new Date('2026-01-02T03:04:05.000Z'),
    )
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

  it('defaults to a credential sidecar when credentials are file-backed', () => {
    expect(defaultSigningAuditPath('/tmp/haven-agent.json')).toBe(
      '/tmp/haven-agent.json.signer-audit.jsonl',
    )
  })
})
