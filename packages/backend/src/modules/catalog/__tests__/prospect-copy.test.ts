/**
 * Guardrail word list (#3080, epic #3077 decision 9): pure unit tests for the
 * matcher itself, plus the CRM copy check over the migration's exported seed
 * constant — not the database, per the issue's acceptance criterion — so this
 * suite runs everywhere `npm run lint:db-mocks` and the harness are not
 * needed.
 */
import { describe, expect, it } from 'vitest'
import { findBannedProspectWords, PROSPECT_COPY_BANNED_WORDS } from '../prospect-copy.js'
import { PROSPECT_SEEDS } from '../../../db/migrations/089_marketplace_prospects.js'

describe('findBannedProspectWords', () => {
  it('is clean on text with none of the banned words', () => {
    expect(findBannedProspectWords('Sovereign Swedish inference on Swedish data centres.')).toEqual([])
  })

  it('matches a banned word case-insensitively', () => {
    expect(findBannedProspectWords('Our new Partner in the region.')).toEqual(['partner'])
    expect(findBannedProspectWords('A valued CUSTOMER base.')).toEqual(['customer'])
  })

  it('matches every inflection of a banned word, and nothing that merely contains its letters mid-word', () => {
    // The sentence that breaches every clause of the ceiling is plural or
    // derived — the first cut's exact-word rule passed it (review of #3080).
    expect(
      findBannedProspectWords('Grounding API — a Haven partnership, already serving Haven customers, with integrations piloting on dev'),
    ).toEqual(['partner', 'customer', 'integration', 'pilot'])
    expect(findBannedProspectWords('We are planning a workshop.')).toEqual(['planned'])
    expect(findBannedProspectWords('Serves customers directly.')).toEqual(['customer'])
    expect(findBannedProspectWords('Serves one customer directly.')).toEqual(['customer'])
    // A stem must start a word: "Berget AI", "sovereign", "compilation" are clean.
    expect(findBannedProspectWords('Sovereign Swedish inference; a compilation of open models.')).toEqual([])
  })

  it('finds every banned word present, in list order', () => {
    const text = 'A planned pilot integration for our customer partner.'
    expect(findBannedProspectWords(text)).toEqual(PROSPECT_COPY_BANNED_WORDS.slice())
  })
})

describe('the prospect seeds carry none of the banned words (#3080 acceptance criterion)', () => {
  it.each(PROSPECT_SEEDS.map((seed) => [seed.slug, seed] as const))(
    '%s: name and description are clean',
    (_slug, seed) => {
      expect(findBannedProspectWords(seed.name)).toEqual([])
      expect(findBannedProspectWords(seed.description)).toEqual([])
    },
  )

  it('mutation proof: a seed description containing a banned word reddens this check', () => {
    // Not a DB or seed mutation — this proves the ASSERTION can fail, per
    // #2506's rule that a guard must be shown red before it is trusted green.
    const mutated = { ...PROSPECT_SEEDS[0], description: `${PROSPECT_SEEDS[0].description} — our newest partner.` }
    const found = findBannedProspectWords(mutated.description)
    expect(found).toEqual(['partner'])
    expect(found).toHaveLength(1)
  })
})
