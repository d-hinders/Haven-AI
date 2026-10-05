'use client'

/**
 * The Storage for handler/effect use (#3515). Effects and event handlers
 * never run in the server render pass, so this only ever resolves in the
 * browser; the `typeof window` guard keeps that fact explicit and the server
 * pass safe (the same pattern AgentPanel and DelegationBudgetCard use).
 * Shared by OpsApp and the pages (#3516) so there is exactly one copy.
 */
export function browserStorage(): Storage {
  if (typeof window === 'undefined') {
    throw new Error('sessionStorage is only available in the browser')
  }
  return window.sessionStorage
}
