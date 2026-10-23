'use client'

/**
 * The list-controls export action (#4328), an extension of the List controls
 * pattern: ONE owner for the whole export flow — the `exporting` and notice
 * state, the fetch (`api.getText`), the empty-body check (`hasCsvRecords`),
 * the download (`downloadCsv` + filename) and the failure notice — so no page
 * re-implements any of it. `useListExport` owns the state and the request;
 * `ListExportAction` is the bare ghost `sm` Button for the toolbar's actions
 * slot (the pattern owns the sizing — no width or height classes here);
 * `ListExportNotice` is the block the page renders where it places it.
 *
 * The page supplies only what differs:
 * - the request — `path` + `URLSearchParams` (memoised from its filters);
 * - whether export is enabled (`exportable` — `!loading && total > 0`);
 * - the empty-result copy (`emptyNotice`) — the outage arm vs "Nothing to
 *   export." for a ledger that cannot have one;
 * - the filename `prefix` (`haven-transactions`, `haven-agent-payments`, …).
 *
 * The notice clears when the request changes (a filter edit), so a stale
 * "Nothing to export." never sits under a new filter. Export on any list
 * page goes through this action — no feature duplication, per the owner
 * instruction of 2026-10-23 (#4328).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import {
  buildCsvFilename,
  downloadCsv,
  exportFailureNotice,
  hasCsvRecords,
  type ExportNotice,
} from '@/lib/csv-export'

/** The list export's request: the export route and its query. */
export interface ListExportRequest {
  path: string
  params: URLSearchParams
}

export interface ListExportOptions {
  /**
   * The request the current filters build. Pass a memoised object: the
   * notice clears when it changes, keyed on `path` + the serialised params.
   */
  request: ListExportRequest
  /** False disables the action — while the list loads or the count is 0. */
  exportable: boolean
  /** The saved name's prefix: `{prefix}-YYYYMMDD.csv`, built client-side. */
  filenamePrefix: string
  /**
   * What to show when the file has no records. A function is read when the
   * empty body arrives, so it can arm on the page's current state (the
   * explorer-outage copy) rather than the click-time one.
   */
  emptyNotice: ExportNotice | (() => ExportNotice)
}

export interface ListExportState {
  exporting: boolean
  exportable: boolean
  onExport: () => void
}

/**
 * The whole export flow, minus the markup. The page renders
 * `<ListExportAction state={export} />` in the toolbar's actions slot and
 * `<ListExportNotice notice={export.notice} />` where the notice belongs.
 */
export function useListExport({
  request,
  exportable,
  filenamePrefix,
  emptyNotice,
}: ListExportOptions): ListExportState & { notice: ExportNotice | null } {
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<ExportNotice | null>(null)

  // The LATEST request and empty copy, read at click time — the handler is
  // stable, so a render between the click and the resolve cannot leave it
  // behind.
  const requestRef = useRef(request)
  requestRef.current = request
  const emptyNoticeRef = useRef(emptyNotice)
  emptyNoticeRef.current = emptyNotice

  // A filter edit makes every prior notice assert something no longer true —
  // clear it, keyed on the request itself (a filter that does not move the
  // params does not raise a new request).
  const requestKey = `${request.path}?${request.params.toString()}`
  useEffect(() => {
    setNotice(null)
  }, [requestKey])

  const onExport = useCallback(async () => {
    const { path, params } = requestRef.current
    setExporting(true)
    setNotice(null)
    try {
      const csv = await api.getText(`${path}?${params.toString()}`)
      if (!hasCsvRecords(csv)) {
        const empty = emptyNoticeRef.current
        setNotice(typeof empty === 'function' ? empty() : empty)
        return
      }
      downloadCsv(csv, buildCsvFilename(new Date(), filenamePrefix))
    } catch (err) {
      setNotice(exportFailureNotice(err))
    } finally {
      setExporting(false)
    }
  }, [filenamePrefix])

  return { exporting, exportable, onExport, notice }
}

/**
 * The actions-slot Button: bare ghost `sm` — the pattern owns the sizing, so
 * no width or height classes are passed (its 44px phone target comes from
 * `Button`'s tap-target overlay). "Preparing…" is the busy label, with
 * `aria-busy` exposing the state to assistive tech.
 */
export function ListExportAction({ state }: { state: ListExportState }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void state.onExport()}
      disabled={!state.exportable || state.exporting}
      aria-busy={state.exporting || undefined}
    >
      {state.exporting ? 'Preparing…' : 'Export CSV'}
    </Button>
  )
}

/**
 * The notice block: a live region under the export's own words —
 * `role="alert"` for a refusal, `role="status"` for a neutral outcome
 * (design-system.md § Button, the busy-state rule). The page chooses the
 * placement; the margins ride `className`.
 */
export function ListExportNotice({
  notice,
  className,
}: {
  notice: ExportNotice | null
  className?: string
}) {
  if (!notice) return null
  const error = notice.tone === 'error'
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`${className ?? ''} rounded-lg border px-4 py-3 text-sm ${
        error
          ? 'border-danger/20 bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
          : 'border-[var(--v2-border)] bg-[var(--v2-surface)] text-[var(--v2-ink-2)]'
      }`}
    >
      <div className={error ? 'font-medium' : 'font-medium text-[var(--v2-ink)]'}>
        {notice.headline}
      </div>
      {notice.detail && <div className="mt-1 text-xs">{notice.detail}</div>}
    </div>
  )
}
