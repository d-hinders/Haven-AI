/**
 * CRM guardrail word list for prospect ("coming soon") merchant copy (#3080,
 * epic #3077 decision 9).
 *
 * A `coming_soon` merchant is a company we are TALKING to, not one that has
 * agreed to anything — the CRM record for each is the ceiling for what may be
 * said about them externally, and none of them has cleared "partner",
 * "customer" or "integration" language. This is the ONE shared word list: the
 * global copy-lint (`scripts/frontend-copy-lint.mjs`) is a `src/app` +
 * `src/components` scan and would hit unrelated frontend files if widened to
 * cover this, so the guardrail lives here instead and a backend test checks
 * every seed against it directly (`089_marketplace_prospects.test.ts`).
 */

/**
 * The five words the CRM ceiling names (epic #3077 decision 9), as the
 * operator reads them. The guard matches each as a STEM with any trailing
 * inflection — partner/partners/partnership/partnered, customer/customers,
 * integration/integrations/integrated/integrating, plan → planned/planning/
 * plans, pilot/pilots/piloting — because the ceiling is about the language
 * in any form, and the sentence that breaches it is usually plural or
 * derived ("a Haven partnership, serving Haven customers", review of
 * #3080). The list runs over two short seed strings, so a false positive
 * ("planet" against `plan`) costs an operator a look; a false negative is
 * the failure the guard exists to prevent.
 */
export const PROSPECT_COPY_BANNED_WORDS: readonly string[] = [
  'partner',
  'customer',
  'integration',
  'planned',
  'pilot',
]

/** The stem each banned word is matched on: a word boundary, the stem, any word characters. */
const BANNED_STEMS: ReadonlyArray<{ word: string; stem: string }> = [
  { word: 'partner', stem: 'partner' },
  { word: 'customer', stem: 'customer' },
  { word: 'integration', stem: 'integrat' },
  { word: 'planned', stem: 'plan' },
  { word: 'pilot', stem: 'pilot' },
]

/**
 * The banned words `text` contains, in list order — empty when clean. A hit
 * is reported by the list word, whatever inflection matched.
 */
export function findBannedProspectWords(text: string): string[] {
  return BANNED_STEMS.filter(({ stem }) => new RegExp(`\\b${stem}\\w*`, 'i').test(text)).map(({ word }) => word)
}
