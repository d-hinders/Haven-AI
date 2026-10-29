import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ampersendDemoApi,
  bergetAi,
  havenDemoStore,
} from '../../../e2e/fixtures/marketplace'
import { avatarTint, resolveAvatarTint, seriesColorForAgent } from '../avatar-tint'

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
 * `/marketplace` grid reads as three distinct circles. Since #4428 this hash
 * is the MERCHANT and CONTACT rule — an agent carries a stored tint instead
 * (see `resolveAvatarTint` below).
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

/**
 * The tint an entity wears (#4428): the STORED tint when it has one (an
 * agent), the name hash otherwise (a merchant or a contact). One rule, read by
 * both `Monogram` and `seriesColorForAgent`.
 */
describe('resolveAvatarTint', () => {
  it('prefers the stored tint over the name hash', () => {
    // 'Research agent' hashes to 6; the stored tint wins.
    expect(avatarTint('Research agent')).toBe(6)
    expect(resolveAvatarTint({ name: 'Research agent', avatarTint: 2 })).toBe(2)
  })

  it('falls back to the hash when there is no stored tint — merchants and contacts', () => {
    expect(resolveAvatarTint({ name: 'Berget AI' })).toBe(avatarTint('Berget AI'))
    expect(resolveAvatarTint({ name: 'Berget AI', avatarTint: null })).toBe(avatarTint('Berget AI'))
    expect(resolveAvatarTint({ name: 'Berget AI', avatarTint: undefined })).toBe(avatarTint('Berget AI'))
  })

  it('ignores a stored value outside 1..6 — a wire-shape guard, not a policy', () => {
    for (const bad of [0, 7, -1, 2.5, Number.NaN]) {
      expect(resolveAvatarTint({ name: 'Research agent', avatarTint: bad })).toBe(6)
    }
  })

  it('gives two hash-alike agents different tints when each carries its own', () => {
    // Both hash to 6 under djb2 mod 6 — the collision the epic removed.
    expect(avatarTint('Research agent')).toBe(avatarTint('Data-feed agent'))
    expect(resolveAvatarTint({ name: 'Research agent', avatarTint: 6 })).not.toBe(
      resolveAvatarTint({ name: 'Data-feed agent', avatarTint: 2 }),
    )
  })
})

/**
 * One colour per agent (#4331): the tint the `Monogram` wears is the SAME
 * token the agent's chart series is filled with, via `seriesColorForAgent`.
 * Since #4428 the helper takes the AGENT, not a bare name, so the stored tint
 * can win over the hash.
 */
describe('seriesColorForAgent', () => {
  it('gives a name the var() of the very tint its monogram wears', () => {
    for (const name of [
      'Research agent',
      'Ops agent',
      'Ampersend Demo API',
      'Haven Demo Store',
      'Berget AI',
      'Zoé Lambert',
    ]) {
      expect(seriesColorForAgent({ name })).toBe(`var(--v2-avatar-${avatarTint(name)})`)
    }
  })

  it('prefers the agent’s stored tint over the name hash', () => {
    expect(seriesColorForAgent({ name: 'Research agent', avatarTint: 2 })).toBe('var(--v2-avatar-2)')
    expect(seriesColorForAgent({ name: 'Research agent' })).toBe('var(--v2-avatar-6)')
  })

  it('draws two hash-alike agents in different colours — the rule #4428 changed', () => {
    const research = seriesColorForAgent({ name: 'Research agent', avatarTint: 6 })
    const dataFeed = seriesColorForAgent({ name: 'Data-feed agent', avatarTint: 2 })
    expect(avatarTint('Research agent')).toBe(avatarTint('Data-feed agent'))
    expect(research).not.toBe(dataFeed)
  })

  it('is rank-independent — a pure function of the name for a merchant, unmoved by any other entity', () => {
    // A merchant or a contact has no stored tint, so the colour does not
    // consult an ordering: the same call, with or without a second entity
    // "queued" ahead of it, reads the same token. (An agent's colour is its
    // stored tint, which is equally unmoved by rank — see the test above.)
    expect(seriesColorForAgent({ name: 'Research agent' })).toBe(seriesColorForAgent({ name: 'Research agent' }))
    expect(seriesColorForAgent({ name: 'Research agent' })).toBe('var(--v2-avatar-6)')
    expect(seriesColorForAgent({ name: 'Ops agent' })).toBe('var(--v2-avatar-5)')
  })

  it('lands the /design-system showcase pair on two different colours, so the monogram-beside-swatch row reads', () => {
    // The pair hashes ALIKE (both tint 6) and is separated by the stored tint
    // each agent carries — the specimen exists to show exactly that.
    expect(avatarTint('Research agent')).toBe(avatarTint('Data-feed agent'))
    expect(seriesColorForAgent({ name: 'Research agent', avatarTint: 6 })).not.toBe(
      seriesColorForAgent({ name: 'Data-feed agent', avatarTint: 2 }),
    )
  })

  it('normalises like avatarTint when it falls back to the hash', () => {
    expect(seriesColorForAgent({ name: '  Research \t agent ' })).toBe(
      seriesColorForAgent({ name: 'Research agent' }),
    )
  })
})
