/**
 * #4470: a 5xx `HavenApiError` reads "transient, re-call once" in the hosted
 * MCP unless it carries a cause. Nine SDK sites threw a literal 500/502 for an
 * answer that a retry cannot change (a missing field, the wrong shape), so
 * each now uses `HavenApiError.deterministic(...)`.
 *
 * This census keeps a new site from bypassing that: every
 * `new HavenApiError(` in non-test `packages/sdk/src` whose status argument
 * is a literal 5xx must be named below, with the reason it is left to the
 * status rule. Marked sites use the factory and never match.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('./', import.meta.url)

/** `file` + a substring of the call's text → why the status rule is right for it. */
const UNMARKED_5XX_ALLOWLIST: Array<{ file: string; match: string; reason: string }> = [
  {
    file: 'client.ts',
    match: 'did not establish an MCP session',
    reason: 'the merchant may establish a session on a re-call; no payment was created',
  },
  {
    file: 'merchant-completion.ts',
    match: 'is ready for merchant completion but has no Haven transaction hash',
    reason: 'a status read that is still catching up with the funding hash; one re-call may see it',
  },
  {
    file: 'x402-funding-leg.ts',
    match: 'is ready to retry but has no Haven transaction hash',
    reason: 'a status read that is still catching up with the funding hash; one re-call may see it',
  },
  {
    file: 'x402-protocol.ts',
    match: 'is ready to retry but has no Haven transaction hash',
    reason: 'a status read that is still catching up with the funding hash; one re-call may see it',
  },
  {
    file: 'client-tax-declaration.ts',
    match: '',
    reason: 'unreachable from any hosted step: swallowed by its only caller, which falls back to no declaration',
  },
]

type Site = { file: string; line: number; call: string; status: string }

/** The text of the call opened at `start` (its `(`), balanced over parens, strings skipped. */
function callText(src: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unbalanced call at ${start}`)
}

/** The second top-level argument of a call's text: the status. */
function statusArgument(call: string): string {
  let depth = 0
  let quote: string | null = null
  const commas: number[] = []
  for (let i = 1; i < call.length - 1; i++) {
    const ch = call[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) commas.push(i)
  }
  const end = commas[1] ?? call.length - 1
  return call.slice(commas[0] + 1, end).trim()
}

function sites(): Site[] {
  const out: Site[] = []
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()) {
    const src = readFileSync(new URL(file, SRC), 'utf8')
    const needle = 'new HavenApiError('
    for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
      const call = callText(src, at + needle.length - 1)
      out.push({ file, line: src.slice(0, at).split('\n').length, call, status: statusArgument(call) })
    }
  }
  return out
}

describe('HavenApiError 5xx census (#4470)', () => {
  const all = sites()
  const literal5xx = all.filter((s) => /^5\d\d$/.test(s.status))

  it('the instrument reads every site and its status (positive controls)', () => {
    // Known sites at origin/dev, read by the same scan the census uses: the
    // transport's 408 and status-0 throws, and a 409 in x402-protocol.ts.
    expect(all.find((s) => s.file === 'haven-api-transport.ts' && s.status === '408')).toBeDefined()
    expect(all.find((s) => s.file === 'haven-api-transport.ts' && s.status === '0')).toBeDefined()
    expect(all.find((s) => s.file === 'x402-protocol.ts' && s.status === '409')).toBeDefined()
    // And a literal 5xx it must count: the allowlisted no-session site.
    expect(literal5xx.find((s) => s.call.includes('did not establish an MCP session'))?.status).toBe('502')
  })

  it('every literal 5xx site is allowlisted with a reason; marked sites use HavenApiError.deterministic', () => {
    const unlisted = literal5xx.filter(
      (s) => !UNMARKED_5XX_ALLOWLIST.some((a) => a.file === s.file && s.call.includes(a.match)),
    )
    expect(unlisted.map((s) => `${s.file}:${s.line} (${s.status})`)).toEqual([])
  })

  it('every allowlist entry still matches a site, so a stale entry cannot excuse a new one', () => {
    for (const entry of UNMARKED_5XX_ALLOWLIST) {
      expect(literal5xx.some((s) => s.file === entry.file && s.call.includes(entry.match)), entry.file + ': ' + entry.match).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  it('the nine deterministic sites carry the mark', () => {
    const marked = new Map<string, number>()
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const n = readFileSync(new URL(file, SRC), 'utf8').split('HavenApiError.deterministic(').length - 1
      if (n) marked.set(file, n)
    }
    // client.ts ×3, x402-erc7710.ts ×3, merchant-completion.ts ×2,
    // x402-funding-leg.ts ×1 — plus payment-state.ts ×2, the variable-status
    // pending_approval and 5xx-fallback throws.
    expect(Object.fromEntries([...marked].sort())).toEqual({
      'client.ts': 3,
      'merchant-completion.ts': 2,
      'payment-state.ts': 2,
      'x402-erc7710.ts': 3,
      'x402-funding-leg.ts': 1,
    })
  })
})
