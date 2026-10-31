/**
 * The StatusBadge vocabulary (#4567, epic #4560 slice 7).
 *
 * `docs/product/design-system.md` § StatusBadge publishes one label and one
 * tone per state, and it is the source of truth. This test walks those tables
 * and the code's maps TOGETHER, so a label or tone that drifts from a row goes
 * red here rather than waiting for the next reader to rediscover it — the
 * failure mode the tables were added to stop (#4563).
 *
 * It also holds the acceptance criterion that the retired words are gone from
 * the app's source: `'Executed'`, `'Synced'`, `'Not fed'`, `'Feeding…'`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_STATUS, PAYMENT_STATUS } from '@/lib/payment-status'
import { MACHINE_PAYMENT_PRESENTATION } from '@/lib/machine-payment-lifecycle'
import { accountingStatusPresentation } from '@/components/accounting/AccountingBadge'
import { en } from '@/lib/i18n/messages/en'

const repo = path.resolve(process.cwd(), '../..')
const DS = readFileSync(path.join(repo, 'docs/product/design-system.md'), 'utf8')

interface Row {
  state: string
  label: string
  tone: string
}

/**
 * The rows of the markdown table under one `####` heading, header and rule
 * dropped. Cells are un-decorated: backticks and `**` are markup, not content.
 */
function tableRows(heading: string): Row[] {
  const start = DS.indexOf(`\n${heading}\n`)
  expect(start, `no "${heading}" heading in design-system.md`).toBeGreaterThan(-1)
  const rest = DS.slice(start + heading.length + 2)
  const end = rest.search(/\n#{2,4} /)
  const block = end === -1 ? rest : rest.slice(0, end)
  const lines = block.split('\n').filter((line) => line.trim().startsWith('|'))
  // lines[0] is the header row, lines[1] the |---|---| rule.
  return lines.slice(2).map((line) => {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    return {
      state: cells[0].replace(/`/g, ''),
      label: cells[1].replace(/\*\*/g, '').replace(/`/g, ''),
      tone: cells[2].replace(/\*\*/g, '').replace(/`/g, ''),
    }
  })
}

function row(rows: Row[], state: string): Row {
  const found = rows.find((r) => r.state === state)
  expect(found, `no "${state}" row in the table`).toBeTruthy()
  return found!
}

/** `<Provider>` is the table's placeholder for the row's own provider name. */
function label(row: Row, provider = 'Fortnox'): string {
  return row.label.replace('<Provider>', provider)
}

describe('StatusBadge vocabulary — agents', () => {
  const rows = tableRows('#### Agents')

  it.each(Object.entries(AGENT_STATUS))('%s matches its published row', (state, presentation) => {
    const published = row(rows, state)
    expect(presentation).toEqual({ label: published.label, tone: published.tone })
  })

  it('publishes a row for every agent state the map can render', () => {
    for (const state of Object.keys(AGENT_STATUS)) {
      expect(rows.map((r) => r.state)).toContain(state)
    }
  })

  it('"Needs setup" is brand, not warning (#4567 owner decision)', () => {
    expect(AGENT_STATUS.pending_approval).toEqual({ label: 'Needs setup', tone: 'brand' })
  })
})

describe('StatusBadge vocabulary — payments', () => {
  const rows = tableRows('#### Payments')

  it.each(Object.entries(PAYMENT_STATUS))('%s matches its published row', (state, presentation) => {
    const published = row(rows, state)
    expect(presentation).toEqual({ label: published.label, tone: published.tone })
  })

  it('publishes a row for every payment state the map can render', () => {
    for (const state of Object.keys(PAYMENT_STATUS)) {
      expect(rows.map((r) => r.state)).toContain(state)
    }
  })

  it('a confirmed payment is "Sent" everywhere', () => {
    expect(PAYMENT_STATUS.confirmed).toEqual({ label: 'Sent', tone: 'success' })
  })

  it.each(['confirming_merchant', 'needs_attention'] as const)(
    'the machine-payment lifecycle row for %s matches its map',
    (state) => {
      const published = row(rows, state)
      expect(MACHINE_PAYMENT_PRESENTATION[state]).toEqual({
        label: published.label,
        tone: published.tone,
      })
    },
  )

  it('a settled machine payment carries no badge, as the table says', () => {
    expect(row(rows, 'paid').label).toBe('no badge')
    expect(MACHINE_PAYMENT_PRESENTATION.paid).toBeNull()
  })
})

describe('StatusBadge vocabulary — accounting sync', () => {
  const rows = tableRows('#### Accounting sync')
  const copy = en.accountingBadge

  it('pushed and live → In <Provider>', () => {
    const published = row(rows, 'pushed')
    expect(
      accountingStatusPresentation({ status: 'pushed', provider: 'fortnox' }, copy, {
        liveSyncReady: true,
      }),
    ).toEqual({ label: label(published), tone: published.tone })
  })

  it('pushed to a record-only provider → Evidence archived', () => {
    const published = row(rows, 'pushed, record-only connector')
    expect(
      accountingStatusPresentation({ status: 'pushed', provider: 'accounted' }, copy, {
        liveSyncReady: true,
      }),
    ).toEqual({ label: published.label, tone: published.tone })
  })

  it('pushed with the connector not live → Tracked (SR:1583)', () => {
    const published = row(rows, 'pushed, connector not live')
    expect(
      accountingStatusPresentation({ status: 'pushed', provider: 'fortnox' }, copy, {
        liveSyncReady: false,
      }),
    ).toEqual({ label: published.label, tone: published.tone })
  })

  it('pending → Sending…', () => {
    const published = row(rows, 'pending')
    expect(accountingStatusPresentation({ status: 'pending', provider: 'fortnox' }, copy)).toEqual({
      label: published.label,
      tone: published.tone,
    })
  })

  it.each(['failed', 'skipped'] as const)('%s → Not sent', (status) => {
    const published = row(rows, 'failed / skipped')
    expect(accountingStatusPresentation({ status, provider: 'fortnox' }, copy)).toEqual({
      label: published.label,
      tone: published.tone,
    })
  })

  it('the provider name comes from the row, never a hard-coded Fortnox', () => {
    expect(
      accountingStatusPresentation({ status: 'pushed', provider: 'bokio' }, copy, {
        liveSyncReady: true,
      }).label,
    ).toBe('In Bokio')
  })
})

describe('the retired words are gone from the app source', () => {
  const SRC = path.join(repo, 'packages/frontend/src')
  const RETIRED = ["'Executed'", "'Synced'", "'Not fed'", "'Feeding…'"]

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        // Tests pin the words they assert on; the public site's copies are out
        // of scope (#4567).
        if (entry === '__tests__' || entry === 'marketing') return []
        return sourceFiles(full)
      }
      return /\.(ts|tsx)$/.test(entry) ? [full] : []
    })
  }

  it.each(RETIRED)('%s appears in no source file', (word) => {
    const offenders = sourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes(word))
    expect(offenders.map((file) => path.relative(repo, file))).toEqual([])
  })
})
