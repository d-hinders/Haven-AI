import type { ReactNode } from 'react'
import { TransactionActivityRow, type TransactionActivityDetail } from './TransactionActivityRow'

export function AgentActivityRow({
  title,
  description,
  amount,
  amountTone,
  status,
  statusTone,
  timestamp,
  details,
  action,
}: {
  title: string
  description: ReactNode
  amount: string
  amountTone?: 'success' | 'danger' | 'neutral'
  status: string
  statusTone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
  timestamp?: string
  details?: TransactionActivityDetail[]
  action?: ReactNode
}) {
  return (
    <TransactionActivityRow
      title={title}
      description={description}
      amount={amount}
      amountTone={amountTone}
      status={status}
      statusTone={statusTone}
      timestamp={timestamp}
      direction="neutral"
      details={details}
      action={action}
    />
  )
}
