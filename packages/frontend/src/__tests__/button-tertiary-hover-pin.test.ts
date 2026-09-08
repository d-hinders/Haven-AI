// #2680 slice-2 guard — pins design-system.md § Buttons' tertiary-hover claim:
// the tertiary Button "reads as text and only resolves into a control on hover
// — which is also the only variant that shifts its *text* colour on hover
// (`ink-2` → `ink`)". Pinned by scanning the variant strings in Button.tsx:
// tertiary is the only variant whose hover list carries `hover:text-…`.
//
// Mutation-proven for #2680: pasting tertiary's hover:text- token into another
// variant reddens the count; restoring the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUTTON = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'components',
  'ui',
  'Button.tsx',
)

describe('Button tertiary hover (#2680 pin)', () => {
  const src = readFileSync(BUTTON, 'utf8')

  it('tertiary is the only variant that shifts text colour on hover', () => {
    // One assertion per variant string: every line that carries a `hover:`
    // class is a variant. Count lines with hover:text — tertiary's shape.
    const variantLines = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && /['"`]/.test(l) && l.includes('hover:'))
    expect(variantLines.length).toBeGreaterThanOrEqual(4)
    const hoverText = variantLines.filter((l) => l.includes('hover:text-'))
    expect(hoverText.length).toBe(1)
    // It is the tertiary shape: bg-transparent, no shadow, ink-2 → ink.
    expect(hoverText[0]).toContain('bg-transparent')
    expect(hoverText[0]).toContain('text-[var(--v2-ink-2)]')
    expect(hoverText[0]).toContain('hover:text-[var(--v2-ink)]')
    expect(hoverText[0]).not.toContain('shadow-button')
  })
})
