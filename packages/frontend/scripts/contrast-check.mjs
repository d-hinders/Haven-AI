#!/usr/bin/env node
// Contrast acceptance for both palettes (#2927).
//
// Measures the WCAG pairs the issue fixes as acceptance — every `ink*` on
// `bg`/`surface`/`surface-2` ≥ 4.5:1, `ink-on-brand` on `brand` ≥ 4.5:1, and
// each `-soft` tint vs its foreground ≥ 3:1 — against the REAL values in
// `src/app/globals.css`, in BOTH themes. The pair list and the ratio math
// come from `src/lib/theme-tokens.ts`; the VALUES come from the CSS. The two
// are cross-checked: a token whose data-table entry drifts from the CSS
// fails here before it can fail a designer.
//
// Run in the frontend unit suite (src/lib/__tests__/theme-tokens.test.ts
// imports `contrastRowsFromCss`) and standalone for the PR-body table:
//
//   cd packages/frontend && node scripts/contrast-check.mjs
//
// (Plain `node` needs `--experimental-strip-types` on Node < 23 to load the
// .ts helper; vitest loads it natively either way.)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CONTRAST_PAIRS, contrastRatio } from '../src/lib/theme-tokens.ts'

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS_PATH = path.join(FRONTEND, 'src/app/globals.css')

/**
 * Extract the inner text of a `{ ... }` block that starts at `openBrace`
 * (the index of the `{`), honouring nesting. Returns { text, endIndex }.
 */
function innerBlock(src, openBrace) {
  let depth = 0
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return { text: src.slice(openBrace + 1, i), endIndex: i }
    }
  }
  throw new Error('unbalanced braces in globals.css')
}

/**
 * The three palette blocks of globals.css, as maps of
 * `--v2-<name>` → raw value (trimmed). Light is the first bare `:root`;
 * the dark pair is the media-gated block and the explicit-attribute block.
 * Comments are stripped FIRST — the palette block's documentation quotes the
 * selectors, and a selector quoted in prose must never be found instead of
 * the real one.
 */
export function blocksFromCss(rawCss) {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, ' ')
  function findBlock(opener) {
    const at = css.indexOf(opener)
    if (at < 0) throw new Error(`globals.css: block not found: ${opener}`)
    const openBrace = css.indexOf('{', at)
    return innerBlock(css, openBrace).text
  }
  function decls(blockText) {
    const map = {}
    for (const m of blockText.matchAll(/--v2-[a-z0-9-]+:\s*[^;]+;/g)) {
      const [name, value] = m[0].replace(/;$/, '').split(/:\s*/)
      map[name] = value.trim()
    }
    const scheme = blockText.match(/color-scheme:\s*([^;]+);/)
    if (scheme) map['color-scheme'] = scheme[1].trim()
    return map
  }
  return {
    light: decls(findBlock(':root {')),
    mediaDark: decls(findBlock(':root:not([data-theme="light"])')),
    explicitDark: decls(findBlock(':root[data-theme="dark"]')),
  }
}

const THEME_OF = { light: 'light', dark: 'dark' }

/**
 * Measure every acceptance pair from the CSS values. Returns one row per
 * pair per theme: { fg, bg, fgValue, bgValue, theme, min, ratio, pass }.
 * Throws if a pair token is missing from the CSS or is not a bare hex (the
 * ratio math is hex-only; every acceptance token is hex in both themes).
 */
export function contrastRowsFromCss(css) {
  const blocks = blocksFromCss(css)
  const rows = []
  for (const pair of CONTRAST_PAIRS) {
    for (const [theme, block] of [
      ['light', blocks.light],
      ['dark', blocks.explicitDark],
    ]) {
      const fgName = `--v2-${pair.fg}`
      const bgName = `--v2-${pair.bg}`
      const fgValue = block[fgName]
      const bgValue = block[bgName]
      if (!fgValue || !bgValue) {
        throw new Error(`globals.css: acceptance pair token missing (${fgName} / ${bgName}, ${theme})`)
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(fgValue) || !/^#[0-9a-fA-F]{6}$/.test(bgValue)) {
        throw new Error(`${fgName}/${bgName} (${theme}) is not #RRGGBB: "${fgValue}" / "${bgValue}"`)
      }
      const ratio = contrastRatio(fgValue, bgValue)
      rows.push({
        fg: pair.fg,
        bg: pair.bg,
        fgValue,
        bgValue,
        theme,
        min: pair.min,
        ratio,
        pass: ratio >= pair.min,
      })
    }
  }
  return rows
}

function printTable(rows) {
  console.log('token pair (fg on bg)          theme   ratio  min  pass')
  console.log('-----------------------------  ------  -----  ---  ----')
  for (const r of rows) {
    const name = `${r.fg} on ${r.bg}`.padEnd(29)
    console.log(
      `${name}  ${r.theme.padEnd(6)}  ${r.ratio.toFixed(2).padStart(5)}  ${String(r.min).padStart(3)}  ${r.pass ? 'yes' : 'NO'}`,
    )
  }
}

async function main() {
  const css = readFileSync(CSS_PATH, 'utf8')
  const rows = contrastRowsFromCss(css)
  printTable(rows)
  const failed = rows.filter((r) => !r.pass)
  if (failed.length > 0) {
    console.error(`\ncontrast-check: ${failed.length} pair(s) below threshold`)
    process.exit(1)
  }
  console.log(`\ncontrast-check: all ${rows.length} pairs pass in both themes`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
