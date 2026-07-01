import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `.env.example` drift test (Phase 2 of the docs-quality system, epic #642).
 *
 * `.env.example` is the configuration mirror: the hand-maintained doc of every
 * environment variable a Haven deployment reads. For a payments product a silent
 * gap here is a real trap — an operator sets what the template lists, but the
 * code quietly reads a variable that was never documented (or the template keeps
 * advertising a knob the code stopped reading). This test pins the two together:
 *
 *   1. Every env var **read in the backend** (`packages/backend/src/**`) must be
 *      documented in `.env.example` — active `KEY=` or commented `# KEY=`.
 *   2. Every key **documented in `.env.example`** must be read somewhere in the
 *      repo's code (backend, frontend, scripts, or the qa/demo packages).
 *
 * Intentional exceptions live in the two `because:` allowlists below. Keep them
 * tight: the default is "document it correctly" / "delete the dead key", not
 * "add an exception". Each allowlist is self-checked so it can't rot — an entry
 * that no longer applies fails the suite.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'packages', 'backend', 'src')

// Roots scanned for "is this variable read anywhere?" (direction 2). Broad on
// purpose: a frontend-only or script-only variable still counts as read.
const READ_ROOTS = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'scripts')]

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js'])
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'out',
  '.turbo',
  '.git',
])

/** Recursively collect code files under `root` (missing roots yield nothing). */
function collectCodeFiles(root: string, opts: { includeTests: boolean }): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(root, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (IGNORED_DIRS.has(name)) continue
      if (!opts.includeTests && name === '__tests__') continue
      out.push(...collectCodeFiles(full, opts))
    } else if (CODE_EXTENSIONS.has(extname(name))) {
      if (!opts.includeTests && /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) continue
      out.push(full)
    }
  }
  return out
}

// Per-chain relayer keys (`RELAYER_PRIVATE_KEY_84532`) are one documented pattern
// backed by a dynamic `process.env[`RELAYER_PRIVATE_KEY_${chainId}`]` read; treat
// any numbered variant as the base key so the family matches in both directions.
function normalize(name: string): string {
  return name.replace(/^RELAYER_PRIVATE_KEY_\d+$/, 'RELAYER_PRIVATE_KEY')
}

const READ_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /\brequireEnv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\boptionalEnv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
]

/** Set of env var names read across the given files (via all four patterns). */
function readEnvVars(files: string[]): Set<string> {
  const found = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of READ_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        found.add(normalize(match[1]))
      }
    }
  }
  return found
}

/** Keys documented in `.env.example`, from active `KEY=` and commented `# KEY=`. */
function documentedKeys(): Set<string> {
  const raw = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8')
  const keys = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]*)=/)
    if (match) keys.add(normalize(match[1]))
  }
  return keys
}

// Read in the backend but intentionally NOT in `.env.example`.
const READ_BUT_UNDOCUMENTED: Array<{ name: string; because: string }> = [
  {
    name: 'NODE_ENV',
    because: 'Standard Node.js runtime variable, set by the runtime/test harness — not Haven config.',
  },
  {
    name: 'PUBLIC_API_URL',
    because: 'Legacy fallback alias for HAVEN_API_URL in agent-connection-setups; HAVEN_API_URL is the documented name.',
  },
  {
    name: 'MPP_DEMO_RECIPIENT_ADDRESS',
    because: 'Demo-only override for the MPP demo route (routes/demo-mpp.ts); not part of a normal deployment.',
  },
]

// Documented in `.env.example` but read only outside code the scan sees (or
// injected by the platform), so the "read somewhere" check would miss them.
const DOCUMENTED_BUT_UNREAD: Array<{ name: string; because: string }> = []

const allowedUndocumented = new Set(READ_BUT_UNDOCUMENTED.map((e) => e.name))
const allowedUnread = new Set(DOCUMENTED_BUT_UNREAD.map((e) => e.name))

const documented = documentedKeys()
const backendReads = readEnvVars(collectCodeFiles(BACKEND_SRC, { includeTests: false }))
const repoReads = new Set<string>()
for (const root of READ_ROOTS) {
  for (const v of readEnvVars(collectCodeFiles(root, { includeTests: true }))) repoReads.add(v)
}

describe('.env.example ↔ backend env reads stay in sync', () => {
  it('reads a non-trivial number of documented keys and backend vars', () => {
    // Guard against a broken scan silently passing with empty sets.
    expect(documented.size).toBeGreaterThanOrEqual(10)
    expect(backendReads.size).toBeGreaterThanOrEqual(10)
  })

  it('documents every env var the backend reads', () => {
    const missing = [...backendReads]
      .filter((v) => !documented.has(v) && !allowedUndocumented.has(v))
      .sort()
    expect(
      missing,
      `Backend reads these env vars but .env.example does not document them:\n` +
        missing.map((v) => `  - ${v}`).join('\n') +
        `\nAdd them to .env.example (active or commented), or allowlist them in ` +
        `READ_BUT_UNDOCUMENTED with a reason.`,
    ).toEqual([])
  })

  it('reads every env var .env.example documents', () => {
    const unread = [...documented]
      .filter((v) => !repoReads.has(v) && !allowedUnread.has(v))
      .sort()
    expect(
      unread,
      `.env.example documents these keys but no code reads them:\n` +
        unread.map((v) => `  - ${v}`).join('\n') +
        `\nRemove the dead key, or allowlist it in DOCUMENTED_BUT_UNREAD with a reason.`,
    ).toEqual([])
  })
})

describe('.env.example drift allowlists stay honest', () => {
  it('every READ_BUT_UNDOCUMENTED entry still applies', () => {
    for (const { name } of READ_BUT_UNDOCUMENTED) {
      const normalized = normalize(name)
      expect(backendReads.has(normalized), `${name} is allowlisted but the backend no longer reads it`).toBe(true)
      expect(documented.has(normalized), `${name} is allowlisted as undocumented but is now in .env.example`).toBe(false)
    }
  })

  it('every DOCUMENTED_BUT_UNREAD entry still applies', () => {
    for (const { name } of DOCUMENTED_BUT_UNREAD) {
      const normalized = normalize(name)
      expect(documented.has(normalized), `${name} is allowlisted but is no longer in .env.example`).toBe(true)
      expect(repoReads.has(normalized), `${name} is allowlisted as unread but code now reads it`).toBe(false)
    }
  })
})
