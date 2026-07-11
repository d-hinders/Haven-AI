import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * WCAG AA contrast guard for the v2 colour tokens (#851).
 *
 * Reads the real values out of globals.css so the test can never drift from
 * the shipped palette. Text-bearing tokens must clear 4.5:1 (AA, normal text)
 * against every background they are rendered on — white, their own -soft
 * fill, and the tinted surfaces.
 */

const css = readFileSync(resolve(__dirname, '../app/globals.css'), 'utf8')

function token(name: string): string {
  const match = css.match(new RegExp(`--v2-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`token --v2-${name} not found in globals.css`)
  return match[1]
}

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE = '#ffffff'
const AA = 4.5

describe('v2 token contrast (WCAG AA, normal text)', () => {
  const surfaces = () => [WHITE, token('surface'), token('surface-2'), token('surface-hover')]

  it('ink hierarchy is readable on white and all tinted surfaces', () => {
    for (const ink of ['ink', 'ink-2', 'ink-3']) {
      for (const bg of surfaces()) {
        expect(contrast(token(ink), bg), `--v2-${ink} on ${bg}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  it('table header ink is readable on the header band', () => {
    expect(contrast(token('table-header-ink'), token('table-header-bg'))).toBeGreaterThanOrEqual(AA)
  })

  it('semantic text tokens are readable on white and their -soft fills', () => {
    for (const name of ['brand', 'success', 'debit', 'warning', 'danger']) {
      expect(contrast(token(name), WHITE), `--v2-${name} on white`).toBeGreaterThanOrEqual(AA)
      expect(
        contrast(token(name), token(`${name}-soft`)),
        `--v2-${name} on its soft fill`,
      ).toBeGreaterThanOrEqual(AA)
    }
  })

  it('neutral badge text (ink-2 on surface-2) is readable', () => {
    expect(contrast(token('ink-2'), token('surface-2'))).toBeGreaterThanOrEqual(AA)
  })
})
