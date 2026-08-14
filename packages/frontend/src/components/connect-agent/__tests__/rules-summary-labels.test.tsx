/**
 * #1431: ONE label set for the AgentRulesSummary row shape, across every
 * surface that renders it.
 *
 * The first attempt at this renamed three of five call sites, and the drift it
 * left was invisible to every existing test: each one asserts its own screen's
 * structure or behaviour, never the labels ACROSS screens. A user saw
 * "Agent name" on the connect Review step and "Agent" one click later on the
 * approval screen — same row shape, same session, same agent.
 *
 * So this file asserts the property directly, at the source: every call site
 * passing this component a name/wallet row uses the same words. It reads the
 * source rather than rendering, because the point is coverage of ALL call
 * sites — a rendering test only ever pins the screens someone remembered to
 * render, which is exactly how the drift survived.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND_SRC = join(process.cwd(), 'src')

/** Every file that renders <AgentRulesSummary …>, found rather than listed. */
function callSites(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.tsx')) continue
      const source = readFileSync(path, 'utf8')
      // The component's own file defines it; every other hit renders it.
      if (source.includes('<AgentRulesSummary')) found.push(path)
    }
  }
  walk(FRONTEND_SRC)
  return found
}

describe('AgentRulesSummary labels are one set everywhere (#1431)', () => {
  const RETIRED = ['Who can spend', 'From account', 'From wallet', "label: 'Agent'", "label: 'From'"]

  it('finds every call site (the guard is worthless if it only sees the ones we fixed)', () => {
    const sites = callSites()
    // 5 today: connect Review, connect approval, connect local-ready, agent
    // detail, design-system examples. A NEW call site should make someone read
    // this test and decide, not silently inherit whatever labels it copied.
    expect(sites.length).toBeGreaterThanOrEqual(5)
  })

  it.each(callSites().map((p) => [p.replace(FRONTEND_SRC, 'src'), p]))(
    '%s uses no retired label spelling',
    (_label, path) => {
      const source = readFileSync(path, 'utf8')
      for (const retired of RETIRED) {
        expect(source).not.toContain(retired)
      }
    },
  )

  it('the agent and wallet rows say "Agent name" and "Spend from" wherever they appear', () => {
    for (const path of callSites()) {
      const source = readFileSync(path, 'utf8')
      // Not every call site carries both rows, but a site that names the agent
      // or the wallet must use the shared words for it.
      if (/label: '[^']*[Aa]gent[^']*'/.test(source)) {
        expect(source).toContain("label: 'Agent name'")
      }
      if (/value: walletName|walletName \}/.test(source)) {
        expect(source).toContain("label: 'Spend from'")
      }
    }
  })
})
