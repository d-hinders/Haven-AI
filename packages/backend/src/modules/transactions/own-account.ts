/**
 * The name an own account carries on a folded move (#4265, #4268): its own
 * Haven name, or "Unnamed account" — never an address. One definition, read
 * by the `/transactions` fold (`orchestration.ts`) for the destination and by
 * the dashboard's Activity groups (`activity.ts`) for both ends, so the two
 * surfaces name the same account the same way.
 */
export function ownAccountDisplayName(name: string | null | undefined): string {
  return name?.trim() || 'Unnamed account'
}
