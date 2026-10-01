/**
 * #3497 item 1 — no agent-visible response string contains internal issue
 * archaeology.
 *
 * `description-size.test.ts` has forbidden `#\d+` in tool descriptions and the
 * hosted instructions since #1591 ("the history is for maintainers — it lives
 * in code comments, and a Codex/GPT agent burning context on '#1308' learns
 * nothing from it"). The live purchase run on 2026-09-30 (#3497) found the
 * SAME archaeology in response prose the description scan never covered:
 * guidance `reason` strings ("…verifies its caveats against Haven's signed
 * context (#1455)…"), `signer_compatibility.check` ("(#1547)"), the
 * strict-input refusal `message`s ("(#3411)", "(#2366 added body…)", "(#3100)")
 * and the direct-sign reason ("a signer predating #3271"). This guard scans
 * the SOURCE for `#\d+` inside the emission shapes those responses are built
 * from, so the rule now covers what an agent READS, not only what it lists.
 *
 * Why a source scan and not result fixtures: the next-step fixtures in
 * `test-support/next-step-fixtures.ts` pin the STRUCTURE of refusals, not the
 * real strings — they cannot see a `#1455` that lives only in a live reason.
 * The scan reads every non-test file under `src/tools/` (the same surface the
 * queue-framing census guards) with comments stripped, and fails on any
 * `#\d+` — the red path is pinned by mutation on inline fixtures below.
 *
 * Allowed to name a NUMBER, not an issue: a signer VERSION (0.5.0-alpha.1)
 * is a fact the agent can act on; "#3271" is not. The scan is deliberately
 * total — allowlist NOTHING (the description-size rule's words).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = new URL('./tools/', import.meta.url)

/** Every non-test source file under src/tools/**, the agent-visible prose surface. */
function toolSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir))
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(readFileSync(new URL(entry.name, dir), 'utf8'))
      }
    }
  }
  walk(TOOLS_DIR)
  return out
}

/**
 * Strip what a maintainer may keep an issue number in: block comments, then
 * line comments. Comment-leading `*` lines (block-comment bodies) are dropped
 * line-wise; the `\x27` spellings below keep fixtures in this file from being
 * mistaken for the source they imitate.
 */
function stripMaintainerComments(source: string): string {
  let body = source.replace(/\/\*[\s\S]*?\*\//g, '')
  body = body
    .split('\n')
    .filter((line) => {
      const s = line.trim()
      return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))
    })
    .join('\n')
  return body
}

/** The guard itself, as a pure function so the mutation below can trip it. */
function scanSource(source: string): string[] {
  const cleaned = stripMaintainerComments(source)
  return [...cleaned.matchAll(/#\d+/g)].map((match) => match[0])
}

describe('agent-visible response strings carry no issue archaeology (#3497 item 1)', () => {
  it('no source string under src/tools/** contains a #N reference', () => {
    const offenders: string[] = []
    for (const body of toolSourceFiles()) {
      offenders.push(...scanSource(body))
    }
    expect(
      offenders,
      `issue archaeology found in agent-visible string sources: ${[...new Set(offenders)].join(', ')}. ` +
        'The history belongs in comments (which this scan strips) — in a response string an agent ' +
        'learns nothing from it and burns context. Name the fact the agent can act on instead ' +
        '(a version, a code, a route).',
    ).toEqual([])
  })

  /**
   * Mutation pin: the scan above is total, so a green run cannot distinguish
   * "clean" from "scan silently broken". Each fixture here would have been a
   * live leak in the 2026-09-30 run's shapes — flip the expectation to see
   * the green-path test fail.
   */
  it('the scan trips on archaeology inside emitted strings and ignores what maintainers keep', () => {
    // A guidance `reason` carrying the reference — the "#1355" shape from the
    // live run, on one line.
    expect(
      scanSource([
        "const reason = 'Sign locally: call next_tool with next_arguments EXACTLY as given (#1355: the '",
        "+ 'signer fetches payment_required itself.'",
      ].join('\n')),
    ).toEqual(['#1355'])
    // The same leak split across the string-concatenation lines these
    // messages are actually written with — the number sits whole inside the
    // second literal (the "#1549" shape from the live run).
    expect(
      scanSource(['const reason = \x27re-run with the SAME key, added VERBATIM, \x27 +', '\x27#1549), then settle.\x27'].join('\n')),
    ).toEqual(['#1549'])
    // The `signer_compatibility.check` shape, with the reference mid-sentence.
    expect(scanSource("check: 'The signer enforces this version itself (#1547): on its refusal, STOP.'")).toEqual([
      '#1547',
    ])
    // What maintainers keep: line comments, block comments and JSDoc bodies
    // are stripped — the history belongs there.
    expect(
      scanSource(['// #1234 maintainer note', '/* #5678 block */', '/**', ' * #9999 jsdoc body', ' */', 'const x = 1'].join('\n')),
    ).toEqual([])
    // Numbers an agent CAN act on are not archaeology: a signer version, a
    // color, an amount, an HTTP status.
    expect(scanSource(["const note = 'from a signer older than 0.5.0-alpha.1'", "const hex = '#ffffff'"].join('\n'))).toEqual([])
  })
})
