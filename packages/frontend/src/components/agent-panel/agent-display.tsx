'use client'

import { Bot } from 'lucide-react'
import { Icon, type IconSize } from '@/components/ui/Icon'

/**
 * The category-level "agents" icon (#4208): a specific agent carries its
 * `Monogram`; a surface about agents in general keeps the robot.
 *
 * #4209 removed this file's budget helpers (`formatConfiguredAllowance`,
 * `tokenSymbol`, `tokenDecimals`, `timeUntil`) with their last caller, the
 * card's `ConfiguredAllowanceRow`: the card now draws the dashboard's
 * `AgentBudget`.
 */
export function BotIcon({ size = 16 }: { size?: IconSize }) {
  return (
    <Icon icon={Bot} size={size} className="flex-shrink-0" />
  )
}
