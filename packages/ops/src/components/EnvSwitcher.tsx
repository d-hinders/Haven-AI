'use client'

/**
 * The header environment switcher (#3515).
 *
 * Offers EXACTLY the environments in the registry — an environment absent
 * from it is not offered. The switcher changes the selected KEY; the token
 * isolation rule is origin-keyed in lib/api.ts and does not depend on this
 * control.
 */
import { SegmentedControl } from '@haven_ai/ui'
import type { OpsEnvironment } from '../lib/environments'

export function EnvSwitcher({
  environments,
  selectedKey,
  onSelect,
}: {
  environments: OpsEnvironment[]
  selectedKey: string
  onSelect: (key: string) => void
}) {
  if (environments.length === 0) return null
  return (
    <SegmentedControl
      ariaLabel="Environment"
      options={environments.map((environment) => ({ value: environment.key, label: environment.key }))}
      value={selectedKey}
      onChange={onSelect}
    />
  )
}
