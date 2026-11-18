'use client'

import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { Table } from '@/components/ui/Table'

/**
 * One breakdown of the period's revenue (By product, By payer) — the
 * Analytics `MerchantsTable` model (#4900): a Table from `lg` up, and below it
 * the same lines as a `Row` list, because a column collapse would silently
 * drop a figure the line exists to show. Each line is one name, its kind or
 * detail beneath, its revenue and its count of payments; the two layouts print
 * the same fields from the same array and are complements by construction
 * (`hidden lg:block` beside `lg:hidden`).
 */
export interface BreakdownLine {
  key: string
  /** The line's name. */
  name: string
  /** What the name is: a kind, a short address, or why the line exists. */
  detail?: ReactNode
  /** Revenue, already formatted. */
  revenue: string
  count: number
  /** A muted line is one that is not a real entity ("No product"). */
  muted?: boolean
}

const CELL = 'px-4 py-3'

export function SalesBreakdownCard({
  title,
  description,
  nameHeader,
  countHeader,
  countNoun,
  lines,
  testId,
}: {
  title: string
  description: string
  nameHeader: string
  countHeader: string
  /** Singular noun for the phone line ("sale" → "3 sales"). */
  countNoun: string
  lines: BreakdownLine[]
  testId: string
}) {
  return (
    <div data-testid={testId}>
    <Card hover={false} className="overflow-hidden">
      <Card.Header as="h2" title={title} description={description} />

      <div className="hidden lg:block">
        <Table>
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">{nameHeader}</Table.HeaderCell>
              <Table.HeaderCell align="right">Revenue</Table.HeaderCell>
              <Table.HeaderCell align="right">{countHeader}</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {lines.map((line) => (
              <tr key={line.key} className="transition-colors duration-150 hover:bg-[var(--v2-surface-hover)]">
                <td className={CELL}>
                  <span className="inline-flex flex-col">
                    <span className={`text-sm font-medium ${line.muted ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink)]'}`}>
                      {line.name}
                    </span>
                    {line.detail ? <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">{line.detail}</span> : null}
                  </span>
                </td>
                <td className={`${CELL} text-right`}>
                  <span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">{line.revenue}</span>
                </td>
                <td className={`${CELL} text-right`}>
                  <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">{line.count}</span>
                </td>
              </tr>
            ))}
          </Table.Body>
        </Table>
      </div>

      <div className="divide-y divide-[var(--v2-table-row-border)] lg:hidden">
        {lines.map((line) => (
          <div key={line.key} className="px-4 py-3">
            <Row
              title={<span className={`truncate ${line.muted ? 'text-[var(--v2-ink-3)]' : ''}`}>{line.name}</span>}
              subtitle={
                <span className="v2-tabular">
                  {line.count} {countNoun}
                  {line.count === 1 ? '' : 's'}
                  {line.detail ? <> · {line.detail}</> : null}
                </span>
              }
              trailing={<span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">{line.revenue}</span>}
              density="flush"
            />
          </div>
        ))}
      </div>
    </Card>
    </div>
  )
}
