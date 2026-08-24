import { describe, expect, it } from 'vitest'
// The gate's pure scanner — the CLI wrapper lives in the same file.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the cast below
import { scanSource, scanElements } from '../../scripts/design-lint.mjs'

type Hit = { rule: string; line: number; match: string }
const scan = scanSource as (file: string, source: string) => Hit[]
const scanEl = scanElements as (file: string, source: string) => Hit[]

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

  it('exempts marketing/landing surfaces from ALL rules (#874)', () => {
    const src = 'const c = "#1a2332"; const cls = "text-amber-500 text-[10px]"'
    for (const file of [
      'src/components/marketing/Hero.tsx',
      'src/components/brand/Logo.tsx',
      'src/app/page.tsx',
      'src/app/protocols/x402/page.tsx',
      'src/app/investor-briefing/page.tsx',
      'src/app/how-it-works/page.tsx',
    ]) {
      expect(scan(file, src)).toEqual([])
    }
    // …while product-app files stay fully gated:
    expect(scan('src/components/X.tsx', src).map((h) => h.rule).sort()).toEqual([
      'hex-color',
      'micro-font',
      'raw-palette',
    ])
    // …and a nested product page named page.tsx is NOT the landing page:
    expect(scan('src/app/(authenticated)/dashboard/page.tsx', src)).toHaveLength(3)
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

  it('keeps scanning past a URL on the same line (#1204)', () => {
    // The comment-stripper must not read the `//` inside `https://` as a
    // comment opener — that blinded ALL rules to the rest of any line with a
    // URL on it. Same line, with and without the href, must agree.
    const withUrl =
      'const x = <a href="https://haven.example" className="bg-white text-[#123456] rounded-lg">go</a>'
    const withoutUrl =
      'const x = <a className="bg-white text-[#123456] rounded-lg">go</a>'
    expect(scan('src/components/X.tsx', withUrl)).toEqual(
      scan('src/components/X.tsx', withoutUrl),
    )
    expect(scan('src/components/X.tsx', withUrl).map((h) => h.rule)).toEqual(['hex-color'])
    // A real comment AFTER the URL is still prose:
    const urlThenComment = 'const u = "https://x.example" // prose about #1a2f3b'
    expect(scan('src/components/X.tsx', urlThenComment)).toEqual([])
  })

  it('flags micro font sizes', () => {
    const hits = scan('src/components/X.tsx', '<p className="text-[10px]" /><p className="text-[11px]" />')
    expect(hits.map((h) => h.match)).toEqual(['text-[10px]', 'text-[11px]'])
    expect(hits[0].rule).toBe('micro-font')
  })

  it('flags structural component bypass (#899): raw table/svg, header band, address slice', () => {
    expect(scan('src/components/X.tsx', '<table className="w-full">').map((h) => h.rule)).toContain('raw-table')
    expect(scan('src/components/X.tsx', '<svg viewBox="0 0 4 4" />').map((h) => h.rule)).toContain('raw-svg')
    expect(scan('src/components/X.tsx', 'const c = "border-b bg-[var(--v2-surface)]"').map((h) => h.rule)).toContain('header-band')
    // The PAIRED idiom counts as exactly ONE occurrence (was double-counted).
    expect(scan('src/components/X.tsx', 'return `${a.slice(0, 6)}…${a.slice(-4)}`').filter((h) => h.rule === 'address-truncation')).toHaveLength(1)
    // border-b-2 is still a bottom border:
    expect(scan('src/components/X.tsx', 'const c = "border-b-2 bg-[var(--v2-surface)]"').map((h) => h.rule)).toContain('header-band')
  })

  it('structural rules do not false-positive on lookalikes (code review 2026-07-13)', () => {
    // border-black is NOT a bottom border — `border-b` must not match inside it:
    expect(scan('src/components/X.tsx', '<div className="border-black/10 bg-[var(--v2-surface)] rounded" />')).toEqual([])
    // Array previews and generic suffixes are NOT address truncation:
    expect(scan('src/components/X.tsx', 'const preview = agents.slice(0, 6)')).toEqual([])
    expect(scan('src/components/X.tsx', 'const last = id.slice(-4)')).toEqual([])
  })

  it('structural rules honour the primitive-home + marketing exemptions', () => {
    // The primitives themselves are where these patterns legitimately live:
    expect(scan('src/components/ui/Table.tsx', '<table>')).toEqual([])
    expect(scan('src/components/ui/Card.tsx', 'border-b bg-[var(--v2-surface)]')).toEqual([])
    expect(scan('src/components/haven/Address.tsx', 'a.slice(0, 6)')).toEqual([])
    // Marketing/brand may hand-roll SVGs and headers:
    expect(scan('src/components/brand/Logo.tsx', '<svg />')).toEqual([])
    expect(scan('src/app/page.tsx', '<table>')).toEqual([])
    // …but a product component may not:
    expect(scan('src/components/Dash.tsx', '<svg />').map((h) => h.rule)).toEqual(['raw-svg'])
  })

  it('honours design-lint-disable-line for reviewed exceptions', () => {
    const src = '<p className="text-[10px]" /> {/* design-lint-disable-line */}'
    expect(scan('src/components/X.tsx', src)).toEqual([])
    // Shared escape semantics: the line ABOVE also works (same rule as
    // copy-lint-ignore — one convention across the lint gates).
    const above = '{/* design-lint-disable-line */}\n<p className="text-[10px]" />'
    expect(scan('src/components/X.tsx', above)).toEqual([])
  })
})

describe('design-lint icon-size element rule (#1858)', () => {
  const F = 'src/components/X.tsx'

  it('accepts every rung of the scale and nothing else', () => {
    for (const cls of ['h-3 w-3', 'h-3.5 w-3.5', 'h-4 w-4', 'h-5 w-5', 'h-6 w-6', 'h-7 w-7']) {
      expect(scanEl(F, `<Icon icon={X} className="${cls}" />`)).toEqual([])
    }
    // …and the neighbouring Tailwind steps are NOT on it:
    for (const cls of ['h-2.5 w-2.5', 'h-2 w-2', 'h-8 w-8']) {
      expect(scanEl(F, `<Icon icon={X} className="${cls}" />`).map((h) => h.match)).toEqual([cls])
    }
  })

  it('flags every arbitrary pixel value — the cluster #1858 was filed over', () => {
    for (const px of [11, 13, 17, 18, 22]) {
      const hits = scanEl(F, `<Icon icon={X} className="h-[${px}px] w-[${px}px]" />`)
      expect(hits).toEqual([
        { rule: 'icon-size', line: 1, match: `h-[${px}px] w-[${px}px]` },
      ])
    }
  })

  it('flags a non-square pair and a single-axis size', () => {
    expect(scanEl(F, '<Icon icon={X} className="h-3 w-5" />')[0].match).toBe('h-3 w-5 (not square)')
    expect(scanEl(F, '<Icon icon={X} className="h-4" />')[0].match).toBe('h-4 w-? (one axis only)')
  })

  it('reads the size prop as pixels, on the same scale', () => {
    expect(scanEl(F, '<Icon icon={X} size={16} />')).toEqual([])
    expect(scanEl(F, '<Icon icon={X} size={13} />')[0].match).toBe('size={13}')
  })

  it('leaves container sizing and runtime-computed sizes alone', () => {
    expect(scanEl(F, '<Icon icon={X} className="h-full w-full" />')).toEqual([])
    // A size that is not statically knowable is out of this gate's reach —
    // documented as a blind spot rather than guessed at:
    expect(scanEl(F, '<Icon icon={X} size={size} />')).toEqual([])
  })

  it('sees a MULTILINE element whose className sits below the tag (#1858)', () => {
    // This is the case a line-based rule cannot reach, and the same case that
    // made an earlier line-regex census report 110 sized sites against 120.
    const src = ['<Icon', '  icon={ChevronRight}', '  className={`h-[13px] w-[13px] rotate-90`}', '/>'].join('\n')
    expect(scanEl(F, src)).toEqual([{ rule: 'icon-size', line: 1, match: 'h-[13px] w-[13px]' }])
    // Proof the gap is real and not asserted: the line-based form finds nothing.
    expect(src.split('\n').filter((l) => /<Icon.*h-\[13px\]/.test(l))).toEqual([])
  })

  it('does not mistake <IconSomething> for the wrapper', () => {
    expect(scanEl(F, '<IconBadge className="h-[13px] w-[13px]" />')).toEqual([])
  })

  it('does not read PROSE about <Icon> as a call site', () => {
    // Icon.tsx's own JSDoc documents this rule and therefore contains the
    // literal `<Icon>`. Counting it put three phantom entries in the census's
    // UNCLASSIFIED bucket — the one figure that is supposed to certify that
    // nothing was dropped.
    const doc = ['/**', ' * All `<Icon>` elements render at h-[13px] per the old rule.', ' */'].join('\n')
    expect(scanEl(F, doc)).toEqual([])
    expect(scanEl(F, '{/* an <Icon> here is h-[13px] */}')).toEqual([])
    expect(scanEl(F, '// <Icon className="h-[13px] w-[13px]" />')).toEqual([])
  })

  it('still sees a real element on the line after such a comment', () => {
    // Masking must preserve line numbers, or every violation below a comment
    // is reported at the wrong place.
    // The comment MUST span several lines: a single-line one is removed and
    // re-added as the same one line, so it cannot tell blanking from deletion.
    const src = [
      '/**',
      ' * Prose mentioning <Icon>,',
      ' * over four lines.',
      ' */',
      '<Icon icon={X} className="h-[13px] w-[13px]" />',
    ].join('\n')
    expect(scanEl(F, src)).toEqual([{ rule: 'icon-size', line: 5, match: 'h-[13px] w-[13px]' }])
  })

  it('does not treat the // in a URL as a comment (shared #1204 guard)', () => {
    const src = '<Icon icon={X} className="h-[13px] w-[13px]" /> // see https://x.test/a'
    expect(scanEl(F, src)[0].match).toBe('h-[13px] w-[13px]')
    // …nor a protocol-relative href, which is quote-preceded rather than
    // colon-preceded. Treating it as a comment blanks the rest of the line and
    // hides the real violation on it.
    const rel = '<a href="//cdn.test/x"><Icon icon={X} className="h-[13px] w-[13px]" /></a>'
    expect(scanEl(F, rel)[0].match).toBe('h-[13px] w-[13px]')
  })

  it('does not read a QUOTED CODE SAMPLE as a call site', () => {
    // `/design-system` renders the usage example as a string. It is on-scale
    // today, so it was invisible — but editing that documentation string to
    // show an off-scale value would have failed CI on a pure doc change, on
    // the page that teaches the rule.
    const sample = `<code>{'<Icon icon={Check} className="h-[13px] w-[13px]" />'}</code>`
    expect(scanEl(F, sample)).toEqual([])
  })

  it('an apostrophe in JSX TEXT does not hide later elements', () => {
    // The regression that a full string-state scanner introduces, and the
    // reason this is an adjacency test instead. A bare apostrophe in body text
    // opens a string that never closes, masking every element after it — two
    // live call sites went missing this way before it was caught. A false
    // negative reads exactly like a clean file.
    const src = [
      "<p>its own primitive's home file</p>",
      '<Icon icon={X} className="h-[13px] w-[13px]" />',
    ].join('\n')
    expect(scanEl(F, src)).toEqual([{ rule: 'icon-size', line: 2, match: 'h-[13px] w-[13px]' }])
  })

  it('terminates an element whose attribute string contains a brace', () => {
    // A `{` inside a string used to leave brace depth permanently above zero,
    // so the element never closed and its violation was dropped in silence.
    const src = '<Icon icon={X} title="weird { case" className="h-[13px] w-[13px]" />'
    expect(scanEl(F, src)[0].match).toBe('h-[13px] w-[13px]')
  })

  it('accepts the escape marker beside the SIZE, not just beside the tag', () => {
    // The shared convention is "the offending line or the one above". On a
    // multiline element those are different places, and an author will reach
    // for the one next to the className — an escape hatch that silently does
    // nothing on exactly the elements this rule exists to reach is worse than
    // no escape hatch.
    const atTag = [
      '{/* design-lint-disable-line */}',
      '<Icon',
      '  icon={X}',
      '  className="h-[13px] w-[13px]"',
      '/>',
    ].join('\n')
    expect(scanEl(F, atTag)).toEqual([])
    const atSize = [
      '<Icon',
      '  icon={X}',
      '  {/* design-lint-disable-line */}',
      '  className="h-[13px] w-[13px]"',
      '/>',
    ].join('\n')
    expect(scanEl(F, atSize)).toEqual([])
    // …and with no marker at all it still fires, so the two above are not
    // passing because the fixture is inert.
    const none = ['<Icon', '  icon={X}', '  className="h-[13px] w-[13px]"', '/>'].join('\n')
    expect(scanEl(F, none)).toHaveLength(1)
  })

  it('honours the marketing exemption and the escape marker', () => {
    expect(scanEl('src/app/page.tsx', '<Icon icon={X} className="h-[13px] w-[13px]" />')).toEqual([])
    const escaped = '{/* design-lint-disable-line */}\n<Icon icon={X} className="h-[13px] w-[13px]" />'
    expect(scanEl(F, escaped)).toEqual([])
  })
})
