/**
 * Product copy for agent organisations (#3164). UI copy says
 * "Organisations" — never "groups" or "folders" (copy-guidelines: calm,
 * non-technical). British spelling (owner decision 2026-10-30, #4570): the
 * copy says "organisation" while the field and the wire keep `organization`.
 * Tone rules: no em-dashes, no exclamation marks, no emoji.
 */

/** Org picker placeholder in the agent editors. */
export const ORG_PICKER_LABEL = 'Organisation'

/** Org picker helper text: what the choice changes (placement, nothing else). */
export const ORG_PICKER_NOTE =
  'Files this agent under an organisation in your agents list. It changes nothing about what the agent can spend.'

/** Confirm body for deleting an organisation. The API promotes the contents. */
export function orgDeleteBody(childCount: number, agentCount: number): string {
  const parts: string[] = []
  if (childCount > 0) {
    parts.push(
      childCount === 1
        ? 'Its sub-organisation moves up one level.'
        : `Its ${childCount} sub-organisations move up one level.`,
    )
  }
  if (agentCount > 0) {
    parts.push(
      agentCount === 1
        ? 'Its agent moves up one level.'
        : `Its ${agentCount} agents move up one level.`,
    )
  }
  if (parts.length === 0) {
    return 'The organisation is empty and will be removed. Nothing else changes.'
  }
  return `The organisation is removed. ${parts.join(' ')} No agent is deleted and nothing about an agent's spending changes.`
}
