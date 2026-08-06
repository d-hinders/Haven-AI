import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Table } from '@/components/ui/Table'

function renderHeader(ui: React.ReactNode) {
  return render(
    <Table>
      <Table.Head>
        <tr>{ui}</tr>
      </Table.Head>
      <Table.Body>
        <tr>
          <td>row</td>
        </tr>
      </Table.Body>
    </Table>,
  )
}

describe('Table (#857)', () => {
  it('SortableHeaderCell maps direction to aria-sort and an accessible label', () => {
    renderHeader(
      <Table.SortableHeaderCell label="Date" direction="desc" onSort={() => undefined} />,
    )
    const th = screen.getByRole('columnheader')
    expect(th.getAttribute('aria-sort')).toBe('descending')
    expect(screen.getByRole('button', { name: 'Sort by Date, currently descending' })).toBeTruthy()
  })

  it('inactive sort column reads aria-sort="none" / "unsorted"', () => {
    renderHeader(
      <Table.SortableHeaderCell label="Amount" direction={null} onSort={() => undefined} />,
    )
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('none')
    expect(screen.getByRole('button', { name: 'Sort by Amount, currently unsorted' })).toBeTruthy()
  })

  it('ascending direction flips both aria-sort and the label', () => {
    renderHeader(
      <Table.SortableHeaderCell label="Date" direction="asc" onSort={() => undefined} />,
    )
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('ascending')
    expect(screen.getByRole('button', { name: 'Sort by Date, currently ascending' })).toBeTruthy()
  })

  it('clicking the sort button calls onSort', () => {
    const onSort = vi.fn()
    renderHeader(<Table.SortableHeaderCell label="Date" direction={null} onSort={onSort} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onSort).toHaveBeenCalledOnce()
  })

  it('HeaderCell renders srLabel visually hidden for icon columns', () => {
    renderHeader(<Table.HeaderCell srLabel="Direction" />)
    const label = screen.getByText('Direction')
    expect(label.className).toContain('sr-only')
  })

  it('hideBelowMd applies the responsive-collapse pattern', () => {
    renderHeader(<Table.HeaderCell hideBelowMd>Initiator</Table.HeaderCell>)
    expect(screen.getByRole('columnheader').className).toContain('hidden md:table-cell')
  })

  it('Head collapses below md by default and stays visible with collapseBelowMd={false}', () => {
    const { container, rerender } = render(
      <Table>
        <Table.Head>
          <tr>
            <Table.HeaderCell>Token</Table.HeaderCell>
          </tr>
        </Table.Head>
      </Table>,
    )
    expect(container.querySelector('thead')!.className).toContain('hidden md:table-header-group')

    rerender(
      <Table>
        <Table.Head collapseBelowMd={false}>
          <tr>
            <Table.HeaderCell>Token</Table.HeaderCell>
          </tr>
        </Table.Head>
      </Table>,
    )
    const thead = container.querySelector('thead')!
    expect(thead.className).not.toContain('hidden')
    expect(thead.className).toContain('table-header-group')
  })

  it('Body carries the single row-border rule', () => {
    const { container } = render(
      <Table>
        <Table.Body>
          <tr>
            <td>row</td>
          </tr>
        </Table.Body>
      </Table>,
    )
    expect(container.querySelector('tbody')!.className).toContain('[&>tr:last-child>td]:border-b-0')
  })
})
