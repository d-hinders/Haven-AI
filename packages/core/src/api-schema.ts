import type { components } from './api-types.js'

/**
 * Ergonomic alias over the generated wire shapes (#984):
 *
 *   type Tx = ApiSchema<'Transaction'>
 *
 * instead of `components['schemas']['Transaction']`. Hand-written in a
 * separate file so the generator can overwrite `api-types.ts` wholesale.
 */
export type ApiSchema<K extends keyof components['schemas']> = components['schemas'][K]
