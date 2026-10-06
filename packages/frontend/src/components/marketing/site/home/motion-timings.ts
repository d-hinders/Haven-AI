/**
 * The mockup's timing constants, in a module without `'use client'` so both
 * the settled (server) components and the animated (client) controllers can
 * import them (#3575). Every value cites the mockup line it mirrors
 * (`docs/product/site-mockup/index.html`).
 */

/** The hero script's full cycle (its own timer, `index.html:103-118`). */
export const HERO_CYCLE_MS = 19_000

/** The how-it-works script's cycle (`loop(…, 12000, …)` at `index.html:277`). */
export const HOW_CYCLE_MS = 12_000

/** The accounting script's cycle (`loop(…, 11000, …)` at `index.html:293`). */
export const ACCOUNTING_CYCLE_MS = 11_000

/** The receipt's per-row stagger (`animationDelay` at `index.html:301`). */
export const RECEIPT_ROW_STAGGER_MS = 110

/** The hero payment amount the loop tweens the budget up by (`index.html:86`). */
export const HERO_PAYMENT = 12.5

/** The hero budget's monthly cap the percentages divide by (`index.html:86`). */
export const HERO_BUDGET_CAP = 250

/** The hero tween's duration (`tween(BASE, BASE+PAY, 900)`, `index.html:109`). */
export const HERO_TWEEN_MS = 900

/** Where the terminal's print sequence starts (the script's :283 offset). */
export const PRINT_START_MS = 5800

/** The stagger between the terminal's output lines (the mockup printed two). */
export const PRINT_STAGGER_MS = 550

/**
 * The developers band's 402-session offsets (mockup V19, artifact version
 * `1791288451-c24e`, script `index.html:289-298`): twelve reveal steps plus
 * the thirteenth, cursor-off step. V19 was never in
 * `docs/product/site-mockup/`, so this cites the artifact version, not the
 * repo convention (`design-system.md:1486`).
 */
export const DEV_STEPS_MS = [0, 700, 1500, 2600, 3300, 3900, 4600, 5200, 5900, 6500, 7500, 8200, 9400]

/** The 402 session's full cycle (mockup V19's script, `index.html:298`). */
export const DEV_CYCLE_MS = 13_000
