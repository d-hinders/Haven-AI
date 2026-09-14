/**
 * The v2 token palette as data (#2927).
 *
 * `THEME_TOKENS` mirrors the colour-valued tokens of `globals.css` — the
 * light values from `:root`, the dark values from the two byte-identical
 * dark blocks — so `/design-system` can render BOTH palettes and the
 * contrast tooling can measure both. It is DATA, not a second source of
 * truth: `src/lib/__tests__/theme-tokens.test.ts` parses the CSS and fails
 * the suite if this table drifts from it by a single value.
 *
 * Consumers:
 *   - `app/(authenticated)/design-system/page.tsx` — the dual-palette swatch
 *     table and the measured contrast ratios;
 *   - the vitest suite — the CSS pin above, plus the acceptance pairs;
 *   - `scripts/contrast-check.mjs` reads the CSS directly (it runs under
 *     plain node) and the same test cross-checks the two paths against each
 *     other, so neither can drift alone.
 *
 * Scope note: exactly the 39 colour-valued tokens — the 20 with `-rgb`
 * channel twins are listed by their hex form (the channel form is pinned to
 * the hex by `design-token-alpha.test.ts`); `--v2-safe-*` (env() lengths),
 * the shadows/gradients and every non-colour token are out of scope here.
 */

export interface TokenSpec {
  /** Token name without the `--v2-` prefix. */
  name: string
  light: string
  dark: string
}

export const THEME_TOKENS: TokenSpec[] = [
  // Ground & surfaces — elevation lightens, never darkens.
  { name: 'bg', light: '#ffffff', dark: '#12151c' },
  { name: 'surface', light: '#f6f9fc', dark: '#191d26' },
  { name: 'surface-2', light: '#eef2f7', dark: '#20252f' },
  { name: 'surface-hover', light: '#f0f4f9', dark: '#232837' },
  { name: 'surface-anchor', light: '#fafbfd', dark: '#1a1f29' },
  { name: 'surface-code', light: '#0b1120', dark: '#0b1120' },
  // Ink — the inverted text scale, measured against every ground.
  { name: 'ink', light: '#1a1f36', dark: '#f0f3f8' },
  { name: 'ink-2', light: '#525f7f', dark: '#b3bdcd' },
  { name: 'ink-3', light: '#5d6c85', dark: '#8f9cb0' },
  { name: 'ink-on-brand', light: '#ffffff', dark: '#1a1f36' },
  // Borders — lighter than the surface they divide.
  { name: 'border', light: '#e6ebf1', dark: '#2b3140' },
  { name: 'border-strong', light: '#d6dbe3', dark: '#3a4152' },
  { name: 'border-anchor', light: 'rgba(79, 70, 229, 0.10)', dark: 'rgba(165, 172, 255, 0.16)' },
  // Brand — lightened/desaturated for dark; #4f46e5 fails AA on a dark ground.
  { name: 'brand', light: '#4f46e5', dark: '#a5acff' },
  { name: 'brand-strong', light: '#4338ca', dark: '#b7bcff' },
  { name: 'brand-soft', light: '#eef2ff', dark: '#262b3f' },
  // Semantic pairs — the soft tints are redefined deep washes, not inverted.
  { name: 'success', light: '#047857', dark: '#34d399' },
  { name: 'success-soft', light: '#ecfdf5', dark: '#12312a' },
  { name: 'debit', light: '#0369a1', dark: '#38bdf8' },
  { name: 'debit-soft', light: '#f0f9ff', dark: '#0e2a3a' },
  { name: 'warning', light: '#b54708', dark: '#fcd34d' },
  { name: 'warning-soft', light: '#fef3c7', dark: '#33260e' },
  { name: 'danger', light: '#b42318', dark: '#f87171' },
  { name: 'danger-soft', light: '#fef2f2', dark: '#3a1512' },
  { name: 'modal-backdrop', light: 'rgba(26, 31, 54, 0.66)', dark: 'rgba(0, 0, 0, 0.6)' },
  // Chain identity — pills flip to translucent-border-on-deep-fill.
  { name: 'chain-base', light: '#0052ff', dark: '#3395ff' },
  { name: 'chain-gnosis', light: '#3e9b8f', dark: '#3e9b8f' },
  { name: 'chain-testnet', light: '#f59e0b', dark: '#fbbf24' },
  { name: 'chain-base-dot', light: '#0ea5e9', dark: '#0ea5e9' },
  { name: 'chain-base-fg', light: '#0369a1', dark: '#7dd3fc' },
  { name: 'chain-base-border', light: '#bae6fd', dark: 'rgba(125, 211, 252, 0.28)' },
  { name: 'chain-base-bg', light: '#f0f9ff', dark: '#12293b' },
  { name: 'chain-testnet-fg', light: '#b45309', dark: '#fcd34d' },
  { name: 'chain-testnet-border', light: '#fde68a', dark: 'rgba(252, 211, 77, 0.28)' },
  { name: 'chain-testnet-bg', light: '#fffbeb', dark: '#2e2410' },
  // Table chrome.
  { name: 'table-header-bg', light: '#f6f9fc', dark: '#191d26' },
  { name: 'table-header-ink', light: '#5d6c85', dark: '#97a3b6' },
  { name: 'table-row-border', light: '#e6ebf1', dark: '#2b3140' },
  { name: 'table-row-hover', light: '#f0f4f9', dark: '#20252f' },
]

/**
 * The acceptance pairs (#2927): every `ink*` on the three grounds ≥ 4.5:1,
 * ink-on-brand on brand ≥ 4.5:1, each `-soft` tint vs its foreground ≥ 3:1,
 * and the table header band ≥ 4.5:1 — asserted in BOTH themes.
 */
export interface ContrastPair {
  /** Token name (no prefix) of the foreground. */
  fg: string
  /** Token name (no prefix) of the background. */
  bg: string
  min: 3 | 4.5
}

export const CONTRAST_PAIRS: ContrastPair[] = [
  { fg: 'ink', bg: 'bg', min: 4.5 },
  { fg: 'ink', bg: 'surface', min: 4.5 },
  { fg: 'ink', bg: 'surface-2', min: 4.5 },
  { fg: 'ink-2', bg: 'bg', min: 4.5 },
  { fg: 'ink-2', bg: 'surface', min: 4.5 },
  { fg: 'ink-2', bg: 'surface-2', min: 4.5 },
  { fg: 'ink-3', bg: 'bg', min: 4.5 },
  { fg: 'ink-3', bg: 'surface', min: 4.5 },
  { fg: 'ink-3', bg: 'surface-2', min: 4.5 },
  { fg: 'ink-on-brand', bg: 'brand', min: 4.5 },
  { fg: 'table-header-ink', bg: 'table-header-bg', min: 4.5 },
  { fg: 'brand', bg: 'brand-soft', min: 3 },
  { fg: 'success', bg: 'success-soft', min: 3 },
  { fg: 'debit', bg: 'debit-soft', min: 3 },
  { fg: 'warning', bg: 'warning-soft', min: 3 },
  { fg: 'danger', bg: 'danger-soft', min: 3 },
]

/** Relative luminance (WCAG 2.1) of a `#rgb`/`#rrggbb` hex colour. */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two hex colours, rounded to 2 decimals. */
export function contrastRatio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

function tokenByName(name: string): TokenSpec {
  const hit = THEME_TOKENS.find((t) => t.name === name)
  if (!hit) throw new Error(`unknown token "${name}" in CONTRAST_PAIRS`)
  return hit
}

/** One measured row per pair per theme — what the page and the test print. */
export function contrastTable(): Array<{
  pair: ContrastPair
  theme: 'light' | 'dark'
  ratio: number
  pass: boolean
}> {
  const rows: ReturnType<typeof contrastTable> = []
  for (const pair of CONTRAST_PAIRS) {
    const spec = tokenByName(pair.fg)
    const ground = tokenByName(pair.bg)
    for (const theme of ['light', 'dark'] as const) {
      const ratio = contrastRatio(spec[theme], ground[theme])
      rows.push({ pair, theme, ratio, pass: ratio >= pair.min })
    }
  }
  return rows
}
