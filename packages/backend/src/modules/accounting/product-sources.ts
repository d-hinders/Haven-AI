/**
 * #4877 (epic #4874): the product sources below the merchant's receipt lines.
 *
 * When the merchant's receipt states no product lines (#4875/#4876), the
 * accounting document still says what was bought, from the other sources
 * Haven already stores — each under a label that says who supplied it
 * (owner decisions of 2026-11-17 on #4874):
 *
 * 1. the merchant's receipt lines — #4876's block;
 * 2. Haven's catalog name, read server-side from `merchant_catalog.name` for
 *    the payment's resource URL — Haven's own data. The caller-supplied
 *    `catalogName` wire field on `POST /x402/authorize` is never used: it is
 *    unverified;
 * 3. the merchant's challenge description (`machine_metadata.description`,
 *    #3610) — caller-relayed, so it is the merchant's text "as reported by
 *    the agent";
 * 4. the agent's delivery reference (`delivery_reference`, #3778);
 * 5. otherwise, no product line.
 *
 * The product line is the highest source present; every other source present
 * is shown on its own labelled line. None is ever merged into the merchant's
 * receipt lines, and VAT is only ever the merchant's stated VAT.
 */

export interface ProductSources {
  catalogName: string | null
  quoteDescription: string | null
  deliveryReference: string | null
}

export const NO_PRODUCT_SOURCES: ProductSources = { catalogName: null, quoteDescription: null, deliveryReference: null }

/** The labels, the same wording everywhere they appear (modulo provider folding). */
export const PRODUCT_SOURCE_LABEL = {
  catalogName: 'Haven catalog',
  quoteDescription: "In the merchant's price quote, as reported by the agent",
  deliveryReference: 'Stated by the agent',
} as const

/** Code-point caps per source. The quote's matches `x402Description`; the reference keeps its 512. */
export const PRODUCT_SOURCE_MAX = { catalogName: 120, quoteDescription: 300, deliveryReference: 512 } as const

/** The ladder order, highest first. */
export const PRODUCT_SOURCE_ORDER = ['catalogName', 'quoteDescription', 'deliveryReference'] as const
export type ProductSourceKey = (typeof PRODUCT_SOURCE_ORDER)[number]

/**
 * Characters stripped from source text before it is stored on an entry,
 * printed or sent: C0 and C1 controls, DEL, line and paragraph separators,
 * bidirectional marks, overrides and isolates, the zero-width space and
 * invisible operators, and the BOM — the set #4875's receipt parser refuses.
 * Tabs and newlines read as spacing and become a space.
 */
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Clean and bound one source text (the cut marked "…", within the cap); null when nothing is left. */
export function cleanSourceText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\t\n\r]+/g, ' ').replace(STRIP, '').replace(/\s+/g, ' ').trim()
  if (cleaned === '') return null
  const points = [...cleaned]
  return points.length <= maxCodePoints ? cleaned : `${points.slice(0, maxCodePoints - 1).join('')}…`
}

/** The three sources of a payment, cleaned and bounded. */
export function productSourcesFrom(raw: {
  catalogName?: unknown
  quoteDescription?: unknown
  deliveryReference?: unknown
}): ProductSources {
  return {
    catalogName: cleanSourceText(raw.catalogName, PRODUCT_SOURCE_MAX.catalogName),
    quoteDescription: cleanSourceText(raw.quoteDescription, PRODUCT_SOURCE_MAX.quoteDescription),
    deliveryReference: cleanSourceText(raw.deliveryReference, PRODUCT_SOURCE_MAX.deliveryReference),
  }
}

/** The sources present, in ladder order. */
export function presentSources(sources: ProductSources): Array<{ key: ProductSourceKey; text: string }> {
  return PRODUCT_SOURCE_ORDER.flatMap((key) => (sources[key] ? [{ key, text: sources[key]! }] : []))
}
