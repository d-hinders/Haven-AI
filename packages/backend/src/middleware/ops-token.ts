import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compare an operator token without exposing either its value or its length
 * through the comparison's timing. An unset configured token disables the
 * route entirely; callers must turn that into a 404 rather than an auth error.
 */
export function matchesOpsToken(configured: string, candidate: string | undefined): boolean {
  if (!configured || !candidate) return false

  const expected = createHash('sha256').update(configured, 'utf8').digest()
  const received = createHash('sha256').update(candidate, 'utf8').digest()
  return timingSafeEqual(expected, received)
}
