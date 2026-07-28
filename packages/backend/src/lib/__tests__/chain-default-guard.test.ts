/**
 * No bare numeric chain default comes back (#990 AC 5).
 *
 * The drift this closes was real and long-lived: CLAUDE.md documented Base as
 * the default while `chain_id` fell back to a literal in a handful of routes,
 * and nothing connected the two. Migration 034 fixed the column defaults and
 * #990 replaced the route literals with `DEFAULT_CHAIN_ID` — but a refactor
 * only holds if the next writer cannot quietly reintroduce what it removed.
 *
 * This reads source text rather than exercising behaviour, with precedent in
 * this repo (`agent-status-epoch.test.ts`, `agent-last-seen.test.ts`): the
 * property is about what every FUTURE writer must do, and no runtime test can
 * observe a line nobody has written yet.
 *
 * It deliberately does NOT flag comparisons. `chainId === 8453` asks "is this
 * Base" — a different question from "what do we use when nobody said". Folding
 * the two together would push writers to express a comparison through a
 * constant named "default", which is worse than the literal.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Files allowed to carry a bare chain default, each for a stated reason.
 * Adding an entry is a decision; it should be argued for in review, which is
 * why the reason lives here rather than in a comment at the call site.
 */
const ALLOWED: Record<string, string> = {
  // Base Sepolia, not Base. The delegation-rail onboarding is dark-launched and
  // provisions on testnet; aligning it to DEFAULT_CHAIN_ID would move new
  // hybrid accounts to MAINNET, which is a product decision tied to the #908
  // mainnet gate, not a consistency cleanup (owner call, 2026-07-28).
  'routes/hybrid-accounts.ts': 'dark-launched delegation onboarding defaults to Base Sepolia',
}

/**
 * A chain id used as a DEFAULT. Two shapes, and only two:
 *
 *   - a nullish/or fallback — `?? 8453`, `|| 100`;
 *   - a destructuring default — `{ chain_id = 8453, … }` or `{ … = 8453 }`,
 *     recognised by the `,` or `}` that must follow it.
 *
 * Everything else is deliberately out of scope, because the first draft of this
 * pattern matched more than it should and the self-test below caught it:
 *
 *   - **Comparisons** (`=== 8453`, `!== 100`) ask "is this Base", which is a
 *     different question. The lookbehind/lookahead exclude them.
 *   - **Plain assignments** (`const CHAIN_ID = 8453`) are a named constant, not
 *     a fallback — nothing lands there by omission. Flagging them would push
 *     writers to express "this demo is on Base" through a constant named
 *     "default", which is worse than the literal it replaced.
 */
const BARE_DEFAULT =
  /(?:\?\?|\|\|)\s*(?:100|8453|84532)\b|(?<![=!<>])=(?!=)\s*(?:100|8453|84532)\s*[,}]/g

/**
 * The match must sit on a line that mentions a chain.
 *
 * `100` is Gnosis AND an ordinary number: `max_x402_per_hour ?? 100` is a rate
 * limit, and the first version of this guard flagged both of those. That is not
 * a cosmetic false positive — misreading exactly those two sites as chain
 * fallbacks is what put a claim in #990 (and in CLAUDE.md) that route
 * fallbacks "still default chain_id to 100" when none ever did. A guard that
 * reproduces the bug it was written to prevent is worse than none.
 *
 * **Known limit, stated rather than papered over:** a fallback with no `chain`
 * token on its line — `const c = x ?? 100` — is missed. Widening to catch it
 * would re-flag every rate limit, and an overstated net is worse than a
 * known-partial one, because nobody compensates for a gap they believe is
 * closed. The realistic reintroduction path is a route reading `chain_id`, and
 * that is covered.
 */
const CHAIN_CONTEXT = /chain/i

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      // Migrations record history: 000_initial's `DEFAULT 100` is a fact about
      // what shipped, and 034 supersedes it. Rewriting either would falsify the
      // migration log.
      if (entry === 'migrations') continue
      sourceFiles(full, out)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('chain defaults go through DEFAULT_CHAIN_ID (#990)', () => {
  it('finds no bare numeric chain default in backend source', () => {
    const offenders: string[] = []
    let scanned = 0

    for (const file of sourceFiles(SRC)) {
      scanned += 1
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      if (ALLOWED[rel]) continue
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((lineText, i) => {
        if (!CHAIN_CONTEXT.test(lineText)) return
        for (const m of lineText.matchAll(BARE_DEFAULT)) {
          offenders.push(`${rel}:${i + 1}  ${m[0].trim()}`)
        }
      })
    }

    // Guard the guard. If the walk or the pattern breaks, this test would pass
    // vacuously and the invariant would be unprotected while looking covered —
    // the failure mode #1015 hit with a regex that stopped matching.
    expect(scanned).toBeGreaterThan(50)

    expect(
      offenders,
      'Bare numeric chain defaults. Import DEFAULT_CHAIN_ID from @haven_ai/core instead — ' +
        'the literal is how Base-vs-Gnosis drifted from the documented default in the first ' +
        'place (#990). A comparison (`=== 8453`) is fine and is not matched here; if this is a ' +
        'deliberate non-Base default, add it to ALLOWED with a reason.',
    ).toEqual([])
  })

  it('detects a bare default when one is present — the pattern actually works', () => {
    // Without this, a regex that silently stopped matching would make the test
    // above green forever. Asserts the detector on known-good and known-bad
    // input rather than trusting it.
    const flags = (s: string) =>
      CHAIN_CONTEXT.test(s) && new RegExp(BARE_DEFAULT.source).test(s)
    const bad = [
      'const chainId = agent.safe_chain_id ?? 8453',
      'const chainId = req.query.chain || 100',
      'const { chain_id = 84532 } = req',
      'const { chain_id = 8453, owner } = req.body',
    ]
    // The rate limits that the first version of this guard wrongly flagged, and
    // that #990's own premise misread as chain fallbacks. Regression case.
    const rateLimits = [
      'const maxPerHour = agentConfig.rows[0]?.max_x402_per_hour ?? 100',
      'const limit = row?.max_x402_per_hour ?? 100',
    ]
    // All of these mention a chain, so they isolate the SHAPE rule rather than
    // passing for lack of chain context — which is what makes them meaningful.
    const good = [
      'if (chainId === 8453) return',
      'if (chainId !== 100) throw',
      'if (status.chain_id !== 8453) return null',
      // A named constant, not a fallback — see the pattern's docstring.
      'const CHAIN_ID = 8453',
    ]
    for (const s of bad) expect(flags(s), s).toBe(true)
    for (const s of good) expect(flags(s), s).toBe(false)
    for (const s of rateLimits) expect(flags(s), `rate limit misread as a chain: ${s}`).toBe(false)
  })

  it('keeps the allowlist honest — every entry still exists and still matches', () => {
    // A stale allowlist entry is a silent hole: the file it named could be
    // deleted or fixed, and the entry would sit there permitting nothing while
    // implying something was reviewed.
    for (const [rel, reason] of Object.entries(ALLOWED)) {
      const full = path.join(SRC, rel)
      expect(() => statSync(full), `${rel} is allowlisted but does not exist`).not.toThrow()
      const text = readFileSync(full, 'utf8')
      const chainLines = text.split('\n').filter((l) => CHAIN_CONTEXT.test(l)).join('\n')
      expect(
        chainLines.match(new RegExp(BARE_DEFAULT.source)),
        `${rel} is allowlisted ("${reason}") but no longer has a bare default — remove the entry`,
      ).toBeTruthy()
    }
  })
})
