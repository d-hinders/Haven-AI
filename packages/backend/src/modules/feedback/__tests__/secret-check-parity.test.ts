import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Parity between the CLI's secret check and the backend's re-run (#3597).
 *
 * Two independent implementations exist on purpose: the CLI must stay
 * dependency-free (never importing `@haven_ai/connect`), and the backend must
 * never import `viem/accounts`'s signing-capable account constructors
 * (`non-custody.invariants.test.ts`'s Red Line #1/#2) — so each has its own
 * copy of layers 1, 3 and 4 rather than a shared module. "Two copies that
 * must agree" is exactly the shape that drifts silently, so this pins them.
 *
 * ## Why this asserts through TEXT rather than an import
 *
 * The backend's `tsconfig.json` sets `rootDir` to its own `src`; importing
 * `packages/cli/src/secret-check.ts` from here is a `tsc` error
 * (`connector-command-parity.test.ts` hit the identical wall and documents
 * it). So this reads the CLI file as a string and extracts the same literals
 * the backend module exports, rather than running the CLI's own functions.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_SECRET_CHECK = join(__dirname, '../../../../../cli/src/secret-check.ts')

/**
 * `re: /pattern/flags` — the CLI's `{ reason, re }` array entries.
 *
 * A single regex cannot extract a regex literal correctly: an unescaped `/`
 * inside a character class (`[^\s/@]`, as the url-credentials pattern has)
 * is literal, not a delimiter, and a naive `/(?:\\.|[^\\/])+/` stops there.
 * This walks the source tracking bracket depth, the same thing a real
 * tokenizer does.
 */
function extractCliLayer1Patterns(source: string): string[] {
  const out: string[] = []
  const marker = 're: /'
  let i = 0
  while (true) {
    const start = source.indexOf(marker, i)
    if (start < 0) break
    let j = start + marker.length // just past the opening '/'
    let inClass = false
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      j += 1
    }
    j += 1 // consume the closing '/'
    const flagsStart = j
    while (j < source.length && /[a-z]/.test(source[j])) j += 1
    out.push(source.slice(start + marker.length - 1, j))
    i = flagsStart
  }
  return out
}

describe('CLI/backend secret-check parity (#3597)', () => {
  it('layer 1: the backend\'s labelled-secret patterns are byte-identical to the CLI\'s', async () => {
    const cliSource = await readFile(CLI_SECRET_CHECK, 'utf8')
    const cliPatterns = extractCliLayer1Patterns(cliSource)

    // Positive control: the extractor must find something, or every
    // assertion below passes over an empty array and proves nothing.
    expect(cliPatterns.length).toBeGreaterThan(0)

    // The backend's own six patterns, written out exactly as they appear in
    // `secret-check.ts` — pinned here rather than re-derived, so a change to
    // either file's wording (not just its regex) is visible in a diff on
    // THIS line, the one place both copies are named side by side.
    const backendPatterns = [
      '/sk_agent_[A-Za-z0-9]/',
      '/hv_setup_[A-Za-z0-9]/',
      '/\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b/',
      '/\\b(api[_-]?key|key|token|secret)=[^&\\s"\'\\\\)]+/i',
      '/https?:\\/\\/[^\\s/@]+:[^\\s@]+@/i',
      '/\\/(?:rpc|v2)\\/[A-Za-z0-9_-]{16,}/',
    ]

    const backendSource = await readFile(
      join(__dirname, '../secret-check.ts'),
      'utf8',
    )
    for (const pattern of backendPatterns) {
      expect(backendSource, `backend source must still contain ${pattern}`).toContain(pattern)
    }

    expect(cliPatterns.sort()).toEqual([...backendPatterns].sort())
  })

  it('layer 3: the 64-hex token regex is byte-identical in both files', async () => {
    const HEX_TOKEN_REGEX_SOURCE = '/(?<![0-9a-fA-F])(0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g'
    const cliSource = await readFile(CLI_SECRET_CHECK, 'utf8')
    const backendSource = await readFile(join(__dirname, '../secret-check.ts'), 'utf8')
    expect(cliSource).toContain(HEX_TOKEN_REGEX_SOURCE)
    expect(backendSource).toContain(HEX_TOKEN_REGEX_SOURCE)
  })

  it('layer 4: the minimum recovery-phrase run length is identical in both files', async () => {
    const cliSource = await readFile(CLI_SECRET_CHECK, 'utf8')
    const backendSource = await readFile(join(__dirname, '../secret-check.ts'), 'utf8')
    const cliValue = cliSource.match(/MIN_RECOVERY_PHRASE_WORDS\s*=\s*(\d+)/)?.[1]
    const backendValue = backendSource.match(/MIN_RECOVERY_PHRASE_WORDS\s*=\s*(\d+)/)?.[1]
    expect(cliValue).toBeDefined()
    expect(cliValue).toBe(backendValue)
    expect(cliValue).toBe('12')
  })

  it('POSITIVE CONTROL: the layer-1 extractor can tell two patterns apart', () => {
    // If the extractor were broken into always-matching-everything, the test
    // above would pass for any two files. Proven against inline fixtures.
    const fixtureA = "{ reason: 'x', re: /abc/ },\n{ reason: 'y', re: /def/i },"
    expect(extractCliLayer1Patterns(fixtureA)).toEqual(['/abc/', '/def/i'])
  })
})
