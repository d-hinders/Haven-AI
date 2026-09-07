/**
 * `planDeleteOrder` — the one derived thing in the #2211 reset path.
 *
 * It decides the ORDER in which `resetDb()` empties tables; the SET is always
 * every table the catalog reports, so this function cannot narrow coverage.
 * What it can get wrong is the ordering, and a wrong order shows up as a
 * foreign-key violation from the reset — which is why these cases are about
 * precedence and about the cycle that has no answer.
 *
 * DB-free by design: it is a pure function over a graph.
 */
import { describe, expect, it } from 'vitest'
import { planDeleteOrder, planEmptying } from '../db-harness.js'

const before = (order: string[], first: string, second: string): boolean =>
  order.indexOf(first) < order.indexOf(second)

describe('planDeleteOrder (#2211)', () => {
  it('puts a referencing table before the table it references', () => {
    const order = planDeleteOrder(
      ['users', 'agents'],
      [{ child: 'agents', parent: 'users' }],
    )
    expect(order).not.toBeNull()
    expect(before(order as string[], 'agents', 'users')).toBe(true)
  })

  it('orders a three-level chain child-first throughout', () => {
    const order = planDeleteOrder(
      ['users', 'agents', 'agent_allowances'],
      [
        { child: 'agents', parent: 'users' },
        { child: 'agent_allowances', parent: 'agents' },
      ],
    ) as string[]
    expect(order).not.toBeNull()
    expect(order).toEqual(['agent_allowances', 'agents', 'users'])
  })

  it('keeps every table in the plan — order is chosen, coverage is not', () => {
    const tables = ['a', 'b', 'c', 'd', 'e']
    const order = planDeleteOrder(tables, [
      { child: 'b', parent: 'a' },
      { child: 'c', parent: 'b' },
    ]) as string[]
    expect([...order].sort()).toEqual([...tables].sort())
  })

  it('returns null for a foreign-key cycle, so the caller can fall back', () => {
    expect(
      planDeleteOrder(
        ['cycle_a', 'cycle_b'],
        [
          { child: 'cycle_a', parent: 'cycle_b' },
          { child: 'cycle_b', parent: 'cycle_a' },
        ],
      ),
    ).toBeNull()
  })

  it('ignores a self-reference — one DELETE removes every row at once', () => {
    const order = planDeleteOrder(['tree'], [{ child: 'tree', parent: 'tree' }])
    expect(order).toEqual(['tree'])
  })

  it('ignores an edge pointing outside the schema it was given', () => {
    const order = planDeleteOrder(['agents'], [{ child: 'agents', parent: 'other_schema_users' }])
    expect(order).toEqual(['agents'])
  })

  it('tolerates a duplicated edge without deadlocking the in-degree count', () => {
    const order = planDeleteOrder(
      ['users', 'agents'],
      [
        { child: 'agents', parent: 'users' },
        { child: 'agents', parent: 'users' },
      ],
    ) as string[]
    expect(order).toEqual(['agents', 'users'])
  })
})

describe('planEmptying (#2354)', () => {
  it('is the DELETE order alone when there is no cycle', () => {
    expect(
      planEmptying(
        ['users', 'agents'],
        [{ child: 'agents', parent: 'users' }],
      ),
    ).toEqual({ deleteOrder: ['agents', 'users'], truncate: [] })
  })

  it("truncates only the cycle's footprint, and still DELETEs everything it could order", () => {
    // Before #2354 one cycle anywhere sent EVERY table down the TRUNCATE
    // path — the per-relation cost #2211 removed, back in full, on the one
    // reset shape that scales with both relations and concurrent workers.
    const { deleteOrder, truncate } = planEmptying(
      ['users', 'agents', 'cycle_a', 'cycle_b'],
      [
        { child: 'agents', parent: 'users' },
        { child: 'cycle_a', parent: 'cycle_b' },
        { child: 'cycle_b', parent: 'cycle_a' },
      ],
    )
    expect(deleteOrder).toEqual(['agents', 'users'])
    expect([...truncate].sort()).toEqual(['cycle_a', 'cycle_b'])
  })

  it('keeps a table a cycle member references on the TRUNCATE side — no DELETE order reaches it', () => {
    const { deleteOrder, truncate } = planEmptying(
      ['root', 'cycle_a', 'cycle_b', 'leaf'],
      [
        { child: 'cycle_a', parent: 'root' },
        { child: 'cycle_a', parent: 'cycle_b' },
        { child: 'cycle_b', parent: 'cycle_a' },
        { child: 'leaf', parent: 'cycle_a' },
      ],
    )
    // `leaf` references a cycle member and can be emptied first; `root` is
    // referenced BY a cycle member, so no DELETE order can reach it.
    expect(deleteOrder).toEqual(['leaf'])
    expect([...truncate].sort()).toEqual(['cycle_a', 'cycle_b', 'root'])
  })

  it('never narrows coverage — deleteOrder and truncate always partition the table list', () => {
    const tables = ['a', 'b', 'c', 'd', 'e']
    const { deleteOrder, truncate } = planEmptying(tables, [
      { child: 'b', parent: 'a' },
      { child: 'c', parent: 'd' },
      { child: 'd', parent: 'c' },
    ])
    expect([...deleteOrder, ...truncate].sort()).toEqual([...tables].sort())
    expect(deleteOrder.filter((t) => truncate.includes(t))).toEqual([])
  })
})
