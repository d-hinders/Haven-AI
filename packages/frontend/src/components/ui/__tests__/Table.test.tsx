import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Table, tableColumnClass, tableHideFromClass } from '@/components/ui/Table'

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

  it('revealAt keys the collapse on the CONTAINER, not the viewport (#1999)', () => {
    renderHeader(<Table.HeaderCell revealAt="md">Initiator</Table.HeaderCell>)
    const th = screen.getByRole('columnheader')
    expect(th.className).toContain('[@container_v2table_(min-width:718px)]:table-cell')
    // The point of the change: no viewport variant decides a column any more.
    expect(th.className).not.toContain('md:table-cell')
  })

  it('the xl stage is the wider container threshold', () => {
    renderHeader(<Table.SortableHeaderCell label="Date" direction={null} onSort={() => undefined} revealAt="xl" />)
    expect(screen.getByRole('columnheader').className).toContain(
      '[@container_v2table_(min-width:974px)]:table-cell',
    )
  })

  it('the <td> helper emits exactly the class the <th> does — header and body cannot drift (#1774/#1999)', () => {
    renderHeader(<Table.HeaderCell revealAt="md">Initiator</Table.HeaderCell>)
    const th = screen.getByRole('columnheader')
    for (const cls of tableColumnClass('md').split(' ')) {
      expect(th.className.split(/\s+/)).toContain(cls)
    }
    // and the relocated-content helper is the same stage, negated
    expect(tableHideFromClass('md')).toContain('[@container_v2table_(min-width:718px)]:hidden')
    expect(tableHideFromClass('xl')).toContain('[@container_v2table_(min-width:974px)]:hidden')
  })

  it('every stage carries its @supports-not viewport fallback, at the matching breakpoint', () => {
    // Without this pair, a browser that cannot parse `@container` keeps the
    // base `hidden` and NEVER reveals the column — a silent, total failure
    // rather than a graceful one. The breakpoint has to MATCH the stage: an
    // `md:` fallback under the `xl` stage would hand the wide columns back
    // 512px early on exactly the browsers that get no second chance.
    expect(tableColumnClass('md')).toContain('md:[@supports_not_(container-type:inline-size)]:table-cell')
    expect(tableColumnClass('xl')).toContain('xl:[@supports_not_(container-type:inline-size)]:table-cell')
    expect(tableColumnClass('xl')).not.toContain('md:[@supports')
    expect(tableHideFromClass('md')).toContain('md:[@supports_not_(container-type:inline-size)]:hidden')
    expect(tableHideFromClass('xl')).toContain('xl:[@supports_not_(container-type:inline-size)]:hidden')
  })

  it('EVERY table gets the named inline-size container — a revealAt column can never be orphaned', () => {
    // The footgun this closes: a table rendered WITHOUT the container, holding
    // a `revealAt` header, emits `@container v2table (...)` with no
    // container-named ancestor. Per spec that query never matches, so the base
    // `hidden` wins permanently, at every viewport, in every browser — silent
    // and total, and strictly worse than the unsupporting-browser case the
    // `@supports` fallback handles. It used to be reachable through a
    // `scrollable` prop; the prop is gone, because measurement showed the
    // containment it avoided does not actually defeat an `overflow-x-auto`
    // scroll. This asserts the state is now unrepresentable.
    const { container } = render(
      <Table>
        <Table.Head>
          <tr>
            <Table.HeaderCell revealAt="md">Initiator</Table.HeaderCell>
          </tr>
        </Table.Head>
        <Table.Body>
          <tr>
            <td className={tableColumnClass('md')}>row</td>
          </tr>
        </Table.Body>
      </Table>,
    )
    const table = container.querySelector('table')!
    const wrapper = table.parentElement!
    expect(wrapper.className).toContain('[container-type:inline-size]')
    expect(wrapper.className).toContain('[container-name:v2table]')

    // Every element carrying a `v2table` query must have that wrapper above
    // it. Walking the DOM is what makes this an assertion about REACHABILITY
    // rather than about two strings matching.
    const queriers = Array.from(container.querySelectorAll('*')).filter((el) =>
      el.className && String(el.className).includes('@container_v2table_'),
    )
    expect(queriers.length, 'the fixture must actually contain container-keyed cells').toBeGreaterThan(0)
    for (const el of queriers) {
      expect(
        el.closest('[class*="container-name:v2table"]'),
        `${el.tagName} carries a v2table query with no v2table ancestor`,
      ).not.toBeNull()
    }
  })

  it('Head collapses on the md container stage by default and stays visible with collapseWhenNarrow={false}', () => {
    const { container, rerender } = render(
      <Table>
        <Table.Head>
          <tr>
            <Table.HeaderCell>Token</Table.HeaderCell>
          </tr>
        </Table.Head>
      </Table>,
    )
    expect(container.querySelector('thead')!.className).toContain(
      'hidden [@container_v2table_(min-width:718px)]:table-header-group',
    )

    rerender(
      <Table>
        <Table.Head collapseWhenNarrow={false}>
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
