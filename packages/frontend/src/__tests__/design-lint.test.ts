import { describe, expect, it } from 'vitest'
// The gate's pure scanner — the CLI wrapper lives in the same file.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the cast below
import { scanSource } from '../../scripts/design-lint.mjs'

type Hit = { rule: string; line: number; match: string }
const scan = scanSource as (file: string, source: string) => Hit[]

describe('design-lint scanner (#855)', () => {
  it('flags raw Tailwind palette classes', () => {
    const hits = scan('src/components/X.tsx', '<div className="text-amber-500 bg-sky-50" />')
    expect(hits.map((h) => h.match)).toEqual(['text-amber-500', 'bg-sky-50'])
    expect(hits[0].rule).toBe('raw-palette')
  })

  it('does not flag token-routed colours, white/black, or v2 utilities', () => {
    const src = '<div className="text-[var(--v2-ink)] bg-white border-black v2-tabular" />'
    expect(scan('src/components/X.tsx', src)).toEqual([])
  })

  it('flags hardcoded hex colours with line numbers', () => {
    const hits = scan('src/components/X.tsx', 'a\nconst c = "#1a2332"')
    expect(hits).toEqual([{ rule: 'hex-color', line: 2, match: '#1a2332' }])
  })

  it('exempts brand and marketing from the hex rule only', () => {
    const src = 'const c = "#1a2332"; const cls = "text-amber-500"'
    const hits = scan('src/components/marketing/Hero.tsx', src)
    expect(hits.map((h) => h.rule)).toEqual(['raw-palette'])
  })

  it('does not treat 0x addresses or route anchors as hex colours', () => {
    const src = 'const a = "0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C"; const href = "#agents"'
    expect(scan('src/components/X.tsx', src)).toEqual([])
  })

  it('does not treat issue references or comment prose as hex colours', () => {
    // All-digit short forms (#857) are issue refs, and line comments are prose.
    const src = 'const a = 1 // epic #859 uses #1a2332\nconst b = "#857"'
    expect(scan('src/components/X.tsx', src)).toEqual([])
    // …but a real short hex WITH a letter still counts:
    expect(scan('src/components/X.tsx', 'const c = "#fa3"')).toHaveLength(1)
  })

  it('flags micro font sizes', () => {
    const hits = scan('src/components/X.tsx', '<p className="text-[10px]" /><p className="text-[11px]" />')
    expect(hits.map((h) => h.match)).toEqual(['text-[10px]', 'text-[11px]'])
    expect(hits[0].rule).toBe('micro-font')
  })

  it('honours design-lint-disable-line for reviewed exceptions', () => {
    const src = '<p className="text-[10px]" /> {/* design-lint-disable-line */}'
    expect(scan('src/components/X.tsx', src)).toEqual([])
  })
})
