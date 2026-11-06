import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../app/globals.css'), 'utf8')

function blockStartingAt(source: string, opener: string): string {
  const start = source.indexOf(opener)
  if (start < 0) throw new Error(`missing CSS block: ${opener}`)
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') depth -= 1
    if (depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced CSS block: ${opener}`)
}

describe('step halo motion gate', () => {
  it('defines and applies the halo only inside the no-preference media block', () => {
    const haloClassAt = css.indexOf('.v2-step-halo')
    const mediaStart = css.lastIndexOf('@media (prefers-reduced-motion: no-preference)', haloClassAt)
    const media = blockStartingAt(css.slice(mediaStart), '@media (prefers-reduced-motion: no-preference)')
    expect(media).toContain('@keyframes v2-step-halo')
    expect(media).toMatch(/\.v2-step-halo\s*{[^}]*animation:\s*v2-step-halo 1\.8s/)
    expect(css.slice(0, mediaStart) + css.slice(mediaStart + media.length)).not.toMatch(/\.v2-step-halo\s*{/)
  })

  it('grows and fades in one direction rather than breathing back in', () => {
    const keyframes = blockStartingAt(css, '@keyframes v2-step-halo')
    expect(keyframes).toMatch(/0%\s*{\s*box-shadow:\s*0 0 0 0 color-mix\(in srgb, var\(--v2-ink-2\) 30%, transparent\)/)
    expect(keyframes).toMatch(/70%,\s*100%\s*{\s*box-shadow:\s*0 0 0 8px transparent/)
    expect(keyframes).not.toMatch(/[^0-9]0%,\s*100%/)
  })
})
