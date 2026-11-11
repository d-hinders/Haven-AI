import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readAccountAddressEnv,
  readAccountAddressField,
  warnIfCredentialFilePermissive,
} from './credentials.js'

/**
 * #4792 characterization: the delegate-key credential-file handling the local
 * MCP and the edge signer each carry a copy of.
 *
 * This table is the SAME table as
 * `packages/mcp/src/credentials-characterization.test.ts` — every row must
 * answer identically in both packages before the shared module moves and after
 * it lands. Only the warning prefix differs, and it is a constant here rather
 * than a row, so the rows themselves stay byte-identical across the two files.
 *
 * The rows are the ones the issue names: credential objects with each accepted
 * spelling, several at once (agreeing and disagreeing), none and non-string
 * values; env objects with each accepted variable, both agreeing and both
 * disagreeing; file modes 0600 / 0640 / 0644 / 0400 on a non-Windows platform,
 * any mode on win32, a missing file; and a symlink to a 0600 file (silent) and
 * a symlink to a 0644 file (warns, and says 0644).
 */
const WARNING_PREFIX = 'haven-signer'

type RawAddressFields = {
  account_address?: unknown
  safe_address?: unknown
  safeAddress?: unknown
}

type FieldRow = { name: string; raw: RawAddressFields; expected: string | undefined }

const FIELD_ROWS: readonly FieldRow[] = [
  { name: 'account_address only', raw: { account_address: '0xNew' }, expected: '0xNew' },
  { name: 'safe_address only', raw: { safe_address: '0xOld' }, expected: '0xOld' },
  { name: 'safeAddress only', raw: { safeAddress: '0xOldCamel' }, expected: '0xOldCamel' },
  {
    name: 'all three, agreeing',
    raw: { account_address: '0xSame', safe_address: '0xSame', safeAddress: '0xSame' },
    expected: '0xSame',
  },
  {
    name: 'all three, disagreeing — account_address wins',
    raw: { account_address: 'a', safe_address: 'b', safeAddress: 'c' },
    expected: 'a',
  },
  { name: 'none', raw: {}, expected: undefined },
  {
    name: 'non-string values',
    raw: { account_address: 42, safe_address: null, safeAddress: {} },
    expected: undefined,
  },
  { name: 'blank string', raw: { account_address: '   ' }, expected: undefined },
  { name: 'surrounding whitespace is trimmed', raw: { account_address: '  0xTrim  ' }, expected: '0xTrim' },
]

type EnvRow = { name: string; env: NodeJS.ProcessEnv; expected?: string; throws?: RegExp }

const ENV_ROWS: readonly EnvRow[] = [
  { name: 'HAVEN_ACCOUNT_ADDRESS only', env: { HAVEN_ACCOUNT_ADDRESS: '0xNew' }, expected: '0xNew' },
  {
    name: 'HAVEN_WALLET_ADDRESS alone refuses',
    env: { HAVEN_WALLET_ADDRESS: '0xOld' },
    throws: /HAVEN_WALLET_ADDRESS is retired/,
  },
  {
    name: 'HAVEN_SAFE_ADDRESS alone refuses',
    env: { HAVEN_SAFE_ADDRESS: '0xOld' },
    throws: /HAVEN_SAFE_ADDRESS is retired/,
  },
  {
    name: 'both retired names alone refuse',
    env: { HAVEN_WALLET_ADDRESS: 'w', HAVEN_SAFE_ADDRESS: 's' },
    throws: /retired \(#2906\)/,
  },
  {
    name: 'both retired names agreeing with the new one',
    env: { HAVEN_ACCOUNT_ADDRESS: '0xABC', HAVEN_SAFE_ADDRESS: '0xabc' },
    expected: '0xABC',
  },
  {
    name: 'both retired names disagreeing with the new one',
    env: { HAVEN_ACCOUNT_ADDRESS: '0xabc', HAVEN_SAFE_ADDRESS: '0xdef' },
    throws: /different addresses/,
  },
  { name: 'none', env: {}, expected: undefined },
]

type ModeRow = {
  name: string
  mode: number | null
  platform: NodeJS.Platform
  expectedOctal: string | null
}

const MODE_ROWS: readonly ModeRow[] = [
  { name: '0600 owner-only', mode: 0o600, platform: 'linux', expectedOctal: null },
  { name: '0640 group-readable', mode: 0o640, platform: 'linux', expectedOctal: '0640' },
  { name: '0644 world-readable', mode: 0o644, platform: 'linux', expectedOctal: '0644' },
  { name: '0400 owner-read-only', mode: 0o400, platform: 'linux', expectedOctal: null },
  { name: '0644 on win32 is skipped', mode: 0o644, platform: 'win32', expectedOctal: null },
  { name: 'missing file', mode: null, platform: 'linux', expectedOctal: null },
]

/** The exact warning both packages emit, differing only in the prefix. */
function expectedWarning(path: string, octal: string): string {
  return (
    `${WARNING_PREFIX}: warning: credential file at ${path} is readable beyond the owner ` +
    `(mode ${octal}). Run: chmod 600 ${path}`
  )
}

async function credentialFile(mode: number | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'haven-credential-characterization-'))
  const file = join(dir, 'credentials.json')
  if (mode !== null) {
    await writeFile(file, '{}')
    await chmod(file, mode)
  }
  return file
}

describe('credential-file characterization (#4792)', () => {
  describe('readAccountAddressField', () => {
    for (const row of FIELD_ROWS) {
      it(row.name, () => {
        expect(readAccountAddressField(row.raw)).toBe(row.expected)
      })
    }
  })

  describe('readAccountAddressEnv', () => {
    for (const row of ENV_ROWS) {
      it(row.name, () => {
        if (row.throws) {
          expect(() => readAccountAddressEnv(row.env)).toThrow(row.throws)
        } else {
          expect(readAccountAddressEnv(row.env)).toBe(row.expected)
        }
      })
    }
  })

  describe('warnIfCredentialFilePermissive', () => {
    for (const row of MODE_ROWS) {
      it(row.name, async () => {
        const file = await credentialFile(row.mode)
        const logged: string[] = []
        await warnIfCredentialFilePermissive(file, (m) => logged.push(m), row.platform)
        if (row.expectedOctal === null) {
          expect(logged).toEqual([])
        } else {
          expect(logged).toEqual([expectedWarning(file, row.expectedOctal)])
        }
      })
    }

    it('a symlink to a 0600 file stays silent', async () => {
      const target = await credentialFile(0o600)
      const link = `${target}.link`
      await symlink(target, link)

      const logged: string[] = []
      await warnIfCredentialFilePermissive(link, (m) => logged.push(m), 'linux')
      expect(logged).toEqual([])
    })

    it('a symlink to a 0644 file warns, and says 0644', async () => {
      const target = await credentialFile(0o644)
      const link = `${target}.link`
      await symlink(target, link)

      const logged: string[] = []
      await warnIfCredentialFilePermissive(link, (m) => logged.push(m), 'linux')
      expect(logged).toEqual([expectedWarning(link, '0644')])
    })
  })
})
