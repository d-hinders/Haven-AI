/**
 * Unit pins for the reservoir guard's pure half (#2622).
 *
 * The end-to-end proof — a schema drifted BEFORE a run, the run reporting green
 * today and red after this change — is in the PR body, because it needs a real
 * database in a known-bad state and cannot be expressed as an assertion inside
 * an always-green `it`. What is pinned here is everything that can go wrong
 * silently: a diff that reports nothing, and a message that omits the repair.
 */
import { describe, expect, it } from 'vitest'
import {
  diffFingerprints,
  driftMessage,
  type TableFingerprint,
} from '../schema-reference.js'

const table = (name: string, columns: string[], indexes: string[] = []): TableFingerprint => ({
  table: name,
  columns: columns.map((c) => ({ name: c, type: 'text', nullable: 'YES', default: null })),
  indexes,
})

describe('diffFingerprints (#2622)', () => {
  it('POSITIVE CONTROL: identical fingerprints report nothing', () => {
    // The zero this whole guard rests on. Without it, a diff that always
    // returned `[]` would pass every other test in this file.
    const shape = [table('agents', ['id', 'name']), table('payments', ['id'])]
    expect(diffFingerprints(shape, shape)).toEqual([])
  })

  it('names a table the reference does not have — the killed-run leftover', () => {
    expect(
      diffFingerprints([table('agents', ['id'])], [table('agents', ['id']), table('agent_allowances', ['id'])]),
    ).toEqual(['agent_allowances (table present that head does not have)'])
  })

  it('names a table head has that is gone', () => {
    expect(diffFingerprints([table('agents', ['id']), table('payments', ['id'])], [table('agents', ['id'])])).toEqual(
      ['payments (table head has that is missing)'],
    )
  })

  it('names a leaked COLUMN — the case a table-name diff cannot see', () => {
    // #2616's original guard compared table NAMES, so a table recreated with
    // the wrong columns passed. That is the reproduction from #2625 and it is
    // the reason this fingerprint is per-column rather than per-table.
    expect(diffFingerprints([table('agents', ['id'])], [table('agents', ['id', '__scratch'])])).toEqual([
      'agents (columns +__scratch)',
    ])
  })

  it('names a leaked INDEX with the columns unchanged', () => {
    expect(
      diffFingerprints([table('agents', ['id'], ['agents_pkey'])], [table('agents', ['id'], ['agents_pkey', 'ix_leak'])]),
    ).toEqual(['agents (indexes +ix_leak)'])
  })

  it('names a column whose TYPE changed under the same name', () => {
    const before = [table('agents', ['id'])]
    const after: TableFingerprint[] = [
      { table: 'agents', columns: [{ name: 'id', type: 'uuid', nullable: 'YES', default: null }], indexes: [] },
    ]
    // `~` rather than `+`/`-`: same name, different attributes. A set-of-names
    // diff would report nothing here at all.
    expect(diffFingerprints(before, after)).toEqual(['agents (columns ~id)'])
  })

  it('reports every differing table, not just the first', () => {
    expect(
      diffFingerprints(
        [table('a', ['id']), table('b', ['id'])],
        [table('a', ['id', 'x']), table('b', ['id', 'y'])],
      ),
    ).toEqual(['a (columns +x)', 'b (columns +y)'])
  })
})

describe('driftMessage (#2622)', () => {
  it('names the schema, the difference AND the repair command', () => {
    const message = driftMessage('test_w7', ['agents (columns +__scratch)'])
    expect(message).toContain('test_w7')
    expect(message).toContain('agents (columns +__scratch)')
    // The repair is the part that decides whether this message costs a minute
    // or an hour: the reader is meeting a schema they did not knowingly create,
    // carrying drift from a run they do not remember.
    expect(message).toContain('DROP SCHEMA test_w7 CASCADE;')
    expect(message).toContain('db:reap-test-schemas')
  })

  it('says the drift is INHERITED, not caused by this run', () => {
    // The whole diagnostic value. Without it the reader looks for the bug in
    // the file that failed, which is the mis-attribution #2616 exists to end.
    expect(driftMessage('test_w7', ['x'])).toMatch(/ALREADY off migration head when this run started/)
  })
})
