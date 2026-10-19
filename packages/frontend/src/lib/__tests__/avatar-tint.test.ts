import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ampersendDemoApi,
  bergetAi,
  havenDemoStore,
} from '../../../e2e/fixtures/marketplace'
import { avatarTint } from '../avatar-tint'

/**
 * The showcase names, read out of the page's source rather than imported:
 * the page module graph pulls in the whole component tree (and `@haven_ai/core`
 * at runtime), which no unit test should need — the other design-system
 * showcase guards read the file as text for the same reason.
 */
const PAGE = readFileSync(
  resolve(__dirname, '../../app/(authenticated)/design-system/page.tsx'),
  'utf8',
)
const SHOWCASE_NAMES = (
  PAGE.match(/MONOGRAM_TINT_EXAMPLES = \[([\s\S]*?)\]/)?.[1]?.match(/'([^']+)'/g) ?? []
).map((s) => s.slice(1, -1))

/**
 * The avatar tint rule (#4066): a pure function of the trimmed name, landing
 * the three marketplace fixture merchants on three different tints so the
 * `/marketplace` grid reads as three distinct circles.
 */
describe('avatarTint', () => {
  it('is deterministic — the same name always gives the same tint', () => {
    for (const name of [
      'Ampersend Demo API',
      'Haven Demo Store',
      'Berget AI',
      'Acme Services',
      'Research API',
      'ada',
    ]) {
      expect(avatarTint(name)).toBe(avatarTint(name))
    }
  })

  it('normalises like merchantInitials — trim and collapsed whitespace', () => {
    expect(avatarTint('  Berget \t AI ')).toBe(avatarTint('Berget AI'))
  })

  it('stays inside the six tints for a spread of names', () => {
    for (const name of [
      'Acme Services',
      'Research API',
      'ada',
      'Zoé Lambert',
      '北村 洋子',
      'a',
      'zzzzzz',
      'The 47th Workshop on Very Long Named Entities',
    ]) {
      expect(avatarTint(name)).toBeGreaterThanOrEqual(1)
      expect(avatarTint(name)).toBeLessThanOrEqual(6)
    }
  })

  it('lands the three marketplace fixture merchants on three different tints', () => {
    const tints = [ampersendDemoApi, havenDemoStore, bergetAi].map((m) => avatarTint(m.name))
    expect(new Set(tints).size).toBe(3)
  })

  it('the /design-system showcase names cover all six tints', () => {
    expect(SHOWCASE_NAMES).toHaveLength(6)
    expect(new Set(SHOWCASE_NAMES.map(avatarTint)).size).toBe(6)
  })
})
