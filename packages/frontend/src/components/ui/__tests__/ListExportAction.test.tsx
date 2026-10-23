/**
 * The shared export action (#4328): the states the issue pins — idle,
 * preparing (`aria-busy`), disabled, both empty-notice shapes, the failure
 * notice and a successful download — plus the rules that keep pages honest:
 * the filename prefix comes from the page, the notice clears when the
 * request changes, and the actions-slot Button carries no sizing classes
 * (the pattern owns the action's sizing).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ApiRequestError } from '@/lib/api'

const { mockGetText, mockDownloadCsv, buttonProps } = vi.hoisted(() => ({
  mockGetText: vi.fn(),
  mockDownloadCsv: vi.fn(),
  // Every render of the shared Button records its props, so the class-list
  // pin can assert the component passes NO className through.
  buttonProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { ...actual.api, getText: (...a: unknown[]) => mockGetText(...a) } }
})
vi.mock('@/lib/csv-export', async () => {
  const actual = await vi.importActual<typeof import('@/lib/csv-export')>('@/lib/csv-export')
  return { ...actual, downloadCsv: (...a: unknown[]) => mockDownloadCsv(...a) }
})
vi.mock('@/components/ui/Button', () => ({
  Button: (props: Record<string, unknown>) => {
    buttonProps.push(props)
    const { children, ...rest } = props
    return <button {...rest}>{children as string}</button>
  },
}))

import { ListExportAction, ListExportNotice, useListExport, type ListExportOptions } from '../ListExportAction'

function request(params = 'accountId=safe-1') {
  return { path: '/transactions/export.csv', params: new URLSearchParams(params) }
}

const PLAIN_EMPTY = { tone: 'info' as const, headline: 'Nothing to export.', detail: 'No transactions match these filters. Widen them and try again.' }
const OUTAGE_EMPTY = { tone: 'info' as const, headline: 'Nothing to export yet.', detail: 'Some account history failed to load, so there was nothing to write. Reload the page and try again.' }

function Probe(props: ListExportOptions) {
  const state = useListExport(props)
  return (
    <>
      <ListExportAction state={state} />
      <ListExportNotice notice={state.notice} className="mt-3" />
    </>
  )
}

type ProbeProps = ComponentProps<typeof Probe>

beforeEach(() => {
  mockGetText.mockReset()
  mockDownloadCsv.mockReset()
  buttonProps.length = 0
})

describe('ListExportAction — the Button', () => {
  const base: ProbeProps = { request: request(), exportable: true, filenamePrefix: 'haven-transactions', emptyNotice: PLAIN_EMPTY }

  it('renders the idle state: enabled, labelled Export CSV, not busy', () => {
    render(<Probe {...base} />)
    const button = screen.getByRole('button', { name: 'Export CSV' })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-busy')
  })

  it('disables the action while the list loads or holds nothing', () => {
    render(<Probe {...base} exportable={false} />)
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
  })

  it('marks the control busy and disabled while the request is in flight', async () => {
    let release: (v: string) => void = () => {}
    mockGetText.mockReturnValue(new Promise<string>((resolve) => { release = resolve }))
    render(<Probe {...base} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    // The label swap is the visible half; aria-busy is what makes it audible.
    const busy = screen.getByRole('button', { name: 'Preparing…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')

    release('\uFEFFsettled_at\r\n"x"')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled())
  })

  it('carries no width or height classes — the pattern owns the sizing', () => {
    render(<Probe {...base} />)
    // The one rule from design-system.md § List controls: a bare ghost `sm`
    // Button. Deleting the account tab's old size classes alone would not
    // pin this — the shared component must pass no className at all.
    expect(buttonProps).toHaveLength(1)
    expect(buttonProps[0].className).toBeUndefined()
  })
})

describe('useListExport — the flow', () => {
  const base: ProbeProps = { request: request(), exportable: true, filenamePrefix: 'haven-transactions', emptyNotice: PLAIN_EMPTY }

  it('downloads what the backend returns, under the page-supplied prefix', async () => {
    mockGetText.mockResolvedValue('\uFEFFsettled_at\r\n"x"')
    render(<Probe {...base} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockGetText).toHaveBeenCalledWith('/transactions/export.csv?accountId=safe-1')
    // The real `buildCsvFilename` ran: the page's prefix, today's UTC date.
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      '\uFEFFsettled_at\r\n"x"',
      expect.stringMatching(/^haven-transactions-\d{8}\.csv$/),
    )
  })

  it('passes a different prefix through (#4328, the agent-tab shape)', async () => {
    mockGetText.mockResolvedValue('\uFEFFsettled_at\r\n"x"')
    render(<Probe {...base} filenamePrefix="haven-agent-payments" />)

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      '\uFEFFsettled_at\r\n"x"',
      expect.stringMatching(/^haven-agent-payments-\d{8}\.csv$/),
    )
  })

  it('reports an empty result instead of downloading a header-only file', async () => {
    mockGetText.mockResolvedValue('\uFEFFsettled_at,type,status')
    render(<Probe {...base} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Nothing to export.')
    expect(notice).toHaveTextContent('No transactions match these filters')
    expect(mockDownloadCsv).not.toHaveBeenCalled()
    // Not a failure: it must not be painted as one.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('takes the outage arm of the empty copy from the page, read at response time', async () => {
    // The outage arm is the FUNCTION shape: the page arms it on its own
    // state, evaluated when the empty body arrives — not at click time.
    let outage = false
    mockGetText.mockResolvedValue('\uFEFFsettled_at,type,status')
    render(
      <Probe
        {...base}
        emptyNotice={() => (outage ? OUTAGE_EMPTY : PLAIN_EMPTY)}
      />,
    )

    outage = true
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Nothing to export yet.')
    expect(notice).toHaveTextContent('Some account history failed to load')
    expect(notice).not.toHaveTextContent('No transactions match these filters')
  })

  it('shows the row-cap refusal in full, in a live region', async () => {
    const details =
      'This export would contain 10,001 rows; the limit is 10,000. Narrow the ' +
      'filters — by account, agent, token, network or direction — and export again.'
    mockGetText.mockRejectedValue(
      new ApiRequestError('Export too large', 413, { error: 'Export too large', details }),
    )
    render(<Probe {...base} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Export too large')
    expect(alert).toHaveTextContent('10,001')
    expect(alert).toHaveTextContent('Narrow the filters')
    expect(mockDownloadCsv).not.toHaveBeenCalled()
  })

  it('does not surface a raw server string for any other failure', async () => {
    mockGetText.mockRejectedValue(new ApiRequestError('Internal Server Error', 500, {}))
    render(<Probe {...base} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The export could not be generated.')
    expect(alert).not.toHaveTextContent('Internal Server Error')
  })

  it('clears the notice when the request changes, so it cannot outlive its filters', async () => {
    mockGetText.mockRejectedValue(new ApiRequestError('Export too large', 413, {}))
    const { rerender } = render(<Probe {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await screen.findByRole('alert')

    // A filter edit: the request moves, and the stale refusal goes with it.
    rerender(<Probe {...base} request={request('accountId=safe-1&direction=out')} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps the notice when a re-render does not move the request', async () => {
    const details =
      'This export would contain 10,001 rows; the limit is 10,000. Narrow the ' +
      'filters — by account, agent, token, network or direction — and export again.'
    mockGetText.mockRejectedValue(
      new ApiRequestError('Export too large', 413, { error: 'Export too large', details }),
    )
    const { rerender } = render(<Probe {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await screen.findByRole('alert')

    // Same path and params: no new request was implied, nothing to clear.
    rerender(<Probe {...base} exportable={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Export too large')
  })
})

describe('ListExportNotice — the block', () => {
  it('renders nothing when there is no notice', () => {
    render(<ListExportNotice notice={null} />)
    expect(document.body.textContent).toBe('')
  })

  it('paints the two tones differently — error as alert, info as status', () => {
    const { rerender } = render(
      <ListExportNotice notice={{ tone: 'error', headline: 'Refused.', detail: 'Narrow the filters.' }} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Refused.')

    rerender(
      <ListExportNotice
        notice={OUTAGE_EMPTY}
        className="mt-3"
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Nothing to export yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
