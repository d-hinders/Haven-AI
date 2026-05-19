import type { ReactNode } from 'react'
import {
  TransactionActivityRow,
  type AmountTone,
  type TransactionActivityDetail,
  type TransactionActivityDirection,
} from './TransactionActivityRow'

export function AgentActivityRow({
  title,
  description,
  amount,
  amountTone,
  status,
  statusTone,
  timestamp,
  direction = 'out',
  details,
  action,
}: {
  title: string
  description: ReactNode
  amount: string
  amountTone?: AmountTone
  status: string
  statusTone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'
  timestamp?: string
  direction?: TransactionActivityDirection
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
      direction={direction}
      details={details}
      action={action}
    />
  )
}
