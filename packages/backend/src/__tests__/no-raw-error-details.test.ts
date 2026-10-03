/**
 * #3609 — no backend response carries a raw error as `details`.
 *
 * A viem/bundler error's `.message` is the whole request dump: callData,
 * signatures, paymaster data, and the RPC or bundler URL — which for hosted
 * providers embeds the API key. Measured live on prod 2026-10-02 at ~6 KB on
 * one 502. Every `details` built from a caught error goes through
 * `boundedErrorDetails` (`modules/payments/prepare-failure.ts`): vendor
 * secrets redacted FIRST, then bounded at 300 characters.
 *
 * This is a source scan, not a behaviour test, on purpose: thirteen sites
 * across seven files answered a raw error before #3609, plus seven local
 * `safeDetails` helpers that redacted without bounding and one `details`
 * fed from a variable, most with no test
 * reaching their failure branch. A new one reddens here whether or not
 * anything exercises it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** A `details:` whose value is a caught error's own text. */
const RAW_DETAILS = /\bdetails:\s*(?:redactVendorSecrets\(|String\(\s*\w+\s*\)|\(?\s*\w+\s+instanceof\s+Error|\w+\.message\b)/

/**
 * A `…Details` helper that returns a caught error's text without the bound —
 * the shape all seven local `safeDetails` helpers had before #3609 (six
 * redacted only, one did not even redact). Redaction alone is right for
 * STORAGE (the sign route and passport revocation redact before persisting),
 * so the rule is scoped to helpers whose job is a response `details`.
 */
const UNBOUNDED_DETAILS_HELPER =
  /function\s+\w*[Dd]etails\w*\s*\([^)]*\)[^{]*\{\s*return\s+(?:redactVendorSecrets\(|\(?\s*\w+\s+instanceof\s+Error)/

/** `const msg = err instanceof Error ? err.message : …` — a raw text bound to a name. */
const RAW_TEXT_BINDING = /\bconst\s+(\w+)\s*=\s*\(?\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Names bound to a raw error text that a `details:` then carries verbatim. */
function rawBoundDetails(source: string): string[] {
  const names = [...source.matchAll(RAW_TEXT_BINDING)].map((m) => m[1]!)
  return names.filter((name) => new RegExp(`\\bdetails:\\s*${name}\\b`).test(source))
}

describe('no raw error text as `details` (#3609)', () => {
  it('the pattern recognises every raw shape that shipped before #3609 — and not the bounded one', () => {
    // Positive control: a scan that cannot match proves nothing.
    for (const raw of [
      'details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),',
      'details: err instanceof Error ? err.message : String(err),',
      "return reply.code(502).send({ error: 'x', details: String(err) })",
      'details: e.message,',
    ]) {
      expect(RAW_DETAILS.test(raw), raw).toBe(true)
    }
    expect(RAW_DETAILS.test('details: boundedErrorDetails(err),')).toBe(false)
    expect(RAW_DETAILS.test('details: boundedMessage,')).toBe(false)
    expect(
      UNBOUNDED_DETAILS_HELPER.test(
        'function safeDetails(err: unknown): string {\n  return redactVendorSecrets(err instanceof Error ? err.message : String(err))\n}',
      ),
    ).toBe(true)
    expect(
      UNBOUNDED_DETAILS_HELPER.test('function safeDetails(err: unknown): string {\n  return err instanceof Error ? err.message : String(err)\n}'),
    ).toBe(true)
    expect(
      UNBOUNDED_DETAILS_HELPER.test("function safeDetails(err: unknown): string {\n  return boundedErrorDetails(err) ?? ''\n}"),
    ).toBe(false)
    expect(rawBoundDetails("const errorMsg = err instanceof Error ? err.message : String(err)\n{ details: errorMsg }")).toEqual([
      'errorMsg',
    ])
    expect(rawBoundDetails("const errorMsg = err instanceof Error ? err.message : String(err)\n{ details: boundedErrorDetails(err) }")).toEqual([])
  })

  it('no backend source file builds `details` from a raw error', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (RAW_DETAILS.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('no `…Details` helper returns a caught error without bounding it', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => UNBOUNDED_DETAILS_HELPER.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
    expect(offenders).toEqual([])
  })

  it('no `details:` carries a variable holding a raw error text', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      rawBoundDetails(readFileSync(file, 'utf8')).map((name) => `${relative(SRC, file)}: details: ${name}`),
    )
    expect(offenders).toEqual([])
  })
})
