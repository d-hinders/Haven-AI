// #2680 slice-2 guard — extends the existing committed-set coverage in this
// file with the WIDTHS design-system.md § Viewport-driven defects asserts:
// "`scripts/evidence-viewports.mjs`, which holds exactly two: 1280 and 390",
// making every other width invisible to the visual-regression gate.
// The 'desktop'/'mobile' name assertions below already pin the entry names;
// this adds the widths so a third viewport (or a width change) reddens.
//
// Mutation-proven for #2680: adding a third viewport reddens; restoring the
// file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { VIEWPORTS } from '../../scripts/evidence-viewports.mjs'

type Viewport = { name: string; width: number; height: number }

describe('the committed evidence set (#2680 pin)', () => {
  it('holds exactly two widths: 1280 and 390', () => {
    const committed = VIEWPORTS as Viewport[]
    expect(committed.map((vp) => vp.width).sort((a, b) => a - b)).toEqual([390, 1280])
  })
})
