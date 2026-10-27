/**
 * The seeded control row and control key shared by the recorder and the
 * instrument (#4471).
 *
 * They live in their own module because the recorder is a vitest setup file and
 * the instrument is a CLI: importing the instrument from the setup would run
 * its command dispatch against vitest's own argv. One definition, two readers.
 */

/** The route the recorder writes once at truncate time. */
export const CONTROL_ROUTE = '/__refusal-census-control'

/** The code that row carries — nothing in the hosted mapper answers it. */
export const CONTROL_CODE = 'refusal_census_control'

/** A key no mapper reads and no builder emits, for block 9's seeded control. */
export const CONTROL_KEY = 'refusal_census_control_key'
