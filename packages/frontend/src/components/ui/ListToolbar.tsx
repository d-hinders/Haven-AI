'use client'

import { SearchX, Search, SlidersHorizontal, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { FacetMenu, type ListFacet } from './FacetMenu'
import { PeriodPicker, isValidRange } from './PeriodPicker'
import {
  allOptionLabel,
  allTimeLabel,
  clearFiltersLabel,
  clearSearchLabel,
  customRangeLabel,
  customRangeHint,
  noMatchBody,
  periodPresetLabels,
  countLabel,
  facetValueLabel,
  loadingMoreLabel,
  showMoreLabel,
  filtersButtonLabel,
  noMatchTitle,
  periodLabel,
  searchPlaceholder,
  showResultsLabel,
  type ListCount,
  type ListNoun,
} from './list-controls-copy'
import { listFocusRing } from './list-menu'
import { listSearchDebounceMs } from './useListUrlState'
import {
  periodPresets,
  clearedListState,
  isAllTime,
  samePeriod,
  sameValues,
  type ListState,
  type ListUrlSchema,
  type PeriodPreset,
  type PeriodValue,
} from './list-url-codec'

export interface ListToolbarSort {
  options: { value: string; label: string }[]
}

export interface ListToolbarPeriod {
  /** The page's default period. Omitted: All time. */
  defaultValue?: PeriodValue
  presets?: readonly PeriodPreset[]
  allowAllTime?: boolean
  allowCustom?: boolean
}

export interface ListToolbarProps {
  /** The list's noun: "Search {things}", "12 of 60 {things}". */
  noun: ListNoun
  state: ListState
  onChange: (next: ListState) => void
  /**
   * Where this list filters (#4110). `server`: the search commits 300 ms
   * after typing pauses (Enter at once), so a server-filtered list sends one
   * request per pause. `browser`: every keystroke commits, so a small
   * in-memory list re-renders as you type — only its URL write waits (see
   * `useListUrlState`). Browser filtering is for small, unpaged lists with no
   * export.
   */
  filtering: 'server' | 'browser'
  facets?: ListFacet[]
  /** A Sort chip — only on lists without sortable column headers. */
  sort?: ListToolbarSort
  period?: ListToolbarPeriod
  /** What the search matches, for screen readers ("by name or address"). */
  searchDescription?: string
  /** Actions on the FILTERED list, such as Export CSV. Page actions stay in the header. */
  actions?: ReactNode
  /**
   * A clear generation owned by the page's list state (#4150). The page bumps
   * it when ITS clear path runs — the no-match `ListNoMatch` Clear filters —
   * so the search field drops a pending draft even when `q` was already
   * empty and the value the field watches did not change. The toolbar's own
   * epoch cannot reach a sibling the page renders. Each source is monotonic,
   * so the sum only ever rises and the field never misses a bump.
   */
  searchEpoch?: number
  /**
   * The count. `null` while the list loads. It renders on the list summary
   * line below the toolbar, and the phone sheet's footer names it too.
   */
  count: ListCount | null
  /**
   * The page's totals for the list summary line (#4196) — "Money in · Money
   * out", or Transactions' "N received · N sent" — drawn on the left of the
   * line, the count on the right. Pass the figures only; the toolbar owns
   * the line, so "filtered" is decided once, here.
   */
  summary?: ReactNode
  /**
   * `responsive` (the default) collapses to the phone layout below `sm`.
   * `phone` always uses it — for a narrow container on a wide screen, and for
   * showing the phone layout on `/design-system`.
   */
  layout?: 'responsive' | 'phone'
}

interface ActiveFilter {
  key: string
  label: string
  /** Counted on the phone "Filters (n)" button (search is not). */
  inSheet: boolean
  clear: () => void
}

/** The codec schema the toolbar's own props imply — for "Clear filters". */
function schemaOf(facets: ListFacet[], sort: ListToolbarSort | undefined, period: ListToolbarPeriod | undefined, state: ListState): ListUrlSchema {
  return {
    facets,
    sort: sort ? { values: sort.options.map((o) => o.value), defaultValue: state.sort ?? sort.options[0]?.value ?? '' } : undefined,
    period: period ? { presets: period.presets, allowAllTime: period.allowAllTime, allowCustom: period.allowCustom, defaultValue: period.defaultValue ?? ((period.allowAllTime ?? true) ? {} : state.period) } : undefined,
  }
}

/**
 * The list-controls pattern (#4110, epic #4108): one toolbar for every list,
 * so search, filters, sort, period, count and no-match look and behave the
 * same everywhere. Pages declare WHAT they filter; this owns HOW.
 *
 * Desktop anatomy (one card, then one line, directly above the list):
 * 1. search, then the actions slot (Export CSV);
 * 2. facets, then Sort and Period on the right; a pill facet gets its own row;
 * 3. the status row, only while a filter is active: removable chips for each
 *    active filter and Clear filters;
 * 4. outside the card, the list summary line (#4196): the page's `summary`
 *    totals on the left, the count on the right, announced politely.
 *
 * Below `sm` (640px) the facet row collapses into a "Filters (n)" button
 * that opens a bottom sheet with 44px rows. **Filters in the sheet apply
 * live**, as on desktop; the footer button only closes it and names the
 * applied result, so a server-filtered list makes no request per tap beyond
 * the one each change already costs.
 */
export function ListToolbar({
  noun,
  state,
  onChange,
  filtering,
  facets = [],
  sort,
  period,
  searchDescription,
  actions,
  count,
  summary,
  searchEpoch = 0,
  layout = 'responsive',
}: ListToolbarProps) {
  const phone = layout === 'phone'
  const [sheetOpen, setSheetOpen] = useState(false)
  const filtersButtonRef = useRef<HTMLButtonElement>(null)
  const closeSheet = useCallback(() => setSheetOpen(false), [])

  const setFacet = (id: string, values: string[]) => onChange({ ...state, facets: { ...state.facets, [id]: values } })
  const setPeriod = (next: PeriodValue) => onChange({ ...state, period: next })
  // Bumped when the toolbar itself clears the search (Clear filters, the
  // search chip), so the field drops its draft and any pending commit even
  // when q was already empty and the value it watches did not change.
  const [ownEpoch, setOwnEpoch] = useState(0)
  // The page can bump `searchEpoch` too (the no-match Clear filters, #4150);
  // both sources only ever rise, so the sum cannot alias one bump for another.
  const fieldEpoch = ownEpoch + searchEpoch
  const clearAll = () => {
    setOwnEpoch((n) => n + 1)
    onChange(clearedListState(state, schemaOf(facets, sort, period, state)))
  }

  const allowAllTime = period?.allowAllTime ?? true
  const visibleFacets = facets.filter((f) => f.options.length > 1)
  const menuFacets = visibleFacets.filter((f) => f.rendering !== 'pills')
  const pillFacets = visibleFacets.filter((f) => f.rendering === 'pills')

  const active: ActiveFilter[] = []
  if (state.q.trim()) {
    active.push({ key: 'q', label: `“${state.q.trim()}”`, inSheet: false, clear: () => {
      setOwnEpoch((n) => n + 1)
      onChange({ ...state, q: '' })
    } })
  }
  // A filter is ACTIVE when it differs from the page's default — the one rule
  // for the chip, the trigger tint, "Filters (n)" and the count (#4110
  // review): a page whose default is not All (Marketplace's network) opens
  // unfiltered. Removing a chip returns that facet to the default.
  // Every active facet gets a chip — including one hidden for having a single
  // option, because then the chip is the only way out of the filter.
  for (const facet of facets) {
    const values = state.facets[facet.id] ?? []
    const defaults = facet.defaultValue ?? []
    if (sameValues(values, defaults)) continue
    active.push({
      key: facet.id,
      label: `${facet.label}: ${facetValueLabel(values, facet.options, facet.allLabel ?? allOptionLabel, true)}`,
      // Only facets the sheet shows count on "Filters (n)": a pill facet
      // sits outside the sheet, and a hidden one-option facet is in neither.
      inSheet: facet.rendering !== 'pills' && facet.options.length > 1,
      clear: () => setFacet(facet.id, [...defaults]),
    })
  }
  // Without All time and with no declared default, the current value is its
  // own default — the PeriodPicker rule — so the period never raises a chip
  // that could only clear to a value this list does not offer.
  const periodDefault = period?.defaultValue ?? (allowAllTime ? {} : (state.period ?? {}))
  if (period && !samePeriod(state.period, periodDefault)) {
    active.push({
      key: 'period',
      label: `Period: ${periodLabel(state.period)}`,
      inSheet: true,
      clear: () => setPeriod({ ...periodDefault }),
    })
  }
  const filtered = active.length > 0
  const sheetCount = active.filter((a) => a.inSheet).length
  const hasSheetContent = menuFacets.length > 0 || Boolean(sort && sort.options.length > 1) || Boolean(period)

  return (
    <div className="flex flex-col gap-3" data-testid="list-controls">
      <div
        role="search"
        aria-label={`Filter ${noun.other}`}
        data-testid="list-toolbar"
        className="flex flex-col gap-3 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card sm:p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <ListSearchField
            noun={noun}
            value={state.q}
            filtering={filtering}
            description={searchDescription}
            epoch={fieldEpoch}
            onCommit={(q) => onChange({ ...state, q })}
          />
          {hasSheetContent && (
            <button
              ref={filtersButtonRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              aria-label={filtersButtonLabel(sheetCount)}
              onClick={() => setSheetOpen(true)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${phone ? '' : 'sm:hidden'} ${listFocusRing} ${
                sheetCount > 0
                  ? 'border-brand/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                  : 'border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)]'
              }`}
            >
              <Icon icon={SlidersHorizontal} className="h-4 w-4" />
              <span>Filters</span>
              {sheetCount > 0 && (
                <span
                  aria-hidden="true"
                  className="min-w-[18px] rounded-full bg-[var(--v2-brand)] px-1.5 text-center v2-text-meta font-semibold leading-[18px] text-[var(--v2-ink-on-brand)]"
                >
                  {sheetCount}
                </span>
              )}
            </button>
          )}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>

        {hasSheetContent && (
          <div className={`hidden flex-wrap items-center gap-2 ${phone ? '' : 'sm:flex'}`} data-testid="list-toolbar-facets">
            {menuFacets.map((facet) => (
              <FacetMenu
                key={facet.id}
                facet={facet}
                value={state.facets[facet.id] ?? []}
                onChange={(values) => setFacet(facet.id, values)}
              />
            ))}
            <span className="flex-1" />
            {sort && (
              <FacetMenu
                facet={{ id: 'sort', label: 'Sort', options: sort.options }}
                value={state.sort ? [state.sort] : []}
                onChange={(values) => values[0] && onChange({ ...state, sort: values[0] })}
                allLabel={null}
                align="right"
              />
            )}
            {period && (
              <PeriodPicker
                value={state.period ?? {}}
                onChange={setPeriod}
                presets={period.presets}
                allowAllTime={allowAllTime}
                defaultValue={period.defaultValue}
                allowCustom={period.allowCustom}
              />
            )}
          </div>
        )}

        {pillFacets.map((facet) => (
          <div key={facet.id} className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:overflow-visible sm:px-0">
            <FacetMenu facet={facet} value={state.facets[facet.id] ?? []} onChange={(values) => setFacet(facet.id, values)} />
          </div>
        ))}

        {/* The status row exists only to hold what is active (#4196): with no
            filter there is no row and no divider. */}
        {filtered && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-[var(--v2-border)] pt-3" data-testid="list-toolbar-status">
            {active.map((filter) => (
              <span
                key={filter.key}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--v2-surface-2)] py-0.5 pl-2.5 pr-0.5 text-xs text-[var(--v2-ink)]"
              >
                {/* `line-clamp-2` (+ `title` for pointer users): a chip whose
                    label is longer than its row wraps instead of losing its
                    tail — the status suffix stays visible with no hover
                    (#4150). */}
                <span className="line-clamp-2" title={filter.label}>
                  {filter.label}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${filter.label}`}
                  onClick={filter.clear}
                  // Painted 24px; the `::after` overlay gives the 44px phone
                  // hit area the way `Button` does — vertical only (#4150).
                  className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--v2-ink-3)] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] hover:bg-[var(--v2-border)] hover:text-[var(--v2-ink)] ${listFocusRing}`}
                >
                  <Icon icon={X} className="h-3 w-3" />
                </button>
              </span>
            ))}
            <Button size="sm" variant="tertiary" onClick={clearAll} className="!h-7 !px-2">
              {clearFiltersLabel}
            </Button>
          </div>
        )}

        {sheetOpen && (
          <FilterSheet
            noun={noun}
            state={state}
            count={count}
            facets={menuFacets}
            sort={sort}
            period={period}
            onFacet={setFacet}
            onSort={(value) => onChange({ ...state, sort: value })}
            onPeriod={setPeriod}
            onClear={clearAll}
            onClose={closeSheet}
            closeOnWide={!phone}
          />
        )}
      </div>

      {/* The list summary line (#4196): outside the search card, directly
          above the list. The count keeps one place whether or not a filter is
          active; `ml-auto` holds it right when the totals wrap or are absent. */}
      <div
        data-testid="list-summary"
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5 text-[13px] text-[var(--v2-ink-2)]"
      >
        {summary ? <div className="min-w-0">{summary}</div> : null}
        <span
          role="status"
          aria-live="polite"
          data-testid="list-toolbar-count"
          className="ml-auto tabular-nums text-[var(--v2-ink-3)]"
        >
          {count ? (
            countLabel(noun, count, filtered)
          ) : (
            <span className="inline-block h-3 w-24 animate-pulse rounded bg-[var(--v2-surface-2)]" aria-label={`Loading ${noun.other}`} />
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * The search field. Escape in the field clears it; the ✕ clears it too.
 * On a server-filtered list a draft commits 300 ms after typing pauses and
 * Enter commits at once; on a browser-filtered list every keystroke commits.
 */
function ListSearchField({
  noun,
  value,
  filtering,
  description,
  epoch,
  onCommit,
}: {
  noun: ListNoun
  value: string
  filtering: 'server' | 'browser'
  description?: string
  epoch: number
  onCommit: (q: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The last value THIS field committed. It separates our own commit echoing
  // back through the page from an EXTERNAL change (a removed chip, Clear
  // filters, back/forward), which must reset the field and cancel a pending
  // commit — or a stale timer could re-add a term the user just removed.
  const committed = useRef(value)
  // The LATEST commit callback. A debounced commit fires after later renders,
  // and the page's callback closes over that render's whole list state — so
  // calling the one captured at keystroke time would write back facets the
  // user has since changed (a removed chip, Clear filters). #4110 review.
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])
  const inputRef = useRef<HTMLInputElement>(null)
  const descriptionId = useId()

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  useEffect(() => {
    if (value === committed.current) return
    cancel()
    committed.current = value
    setDraft(value)
  }, [value, cancel])

  // A clear issued by the toolbar: drop the draft and any pending commit.
  const lastEpoch = useRef(epoch)
  useEffect(() => {
    if (epoch === lastEpoch.current) return
    lastEpoch.current = epoch
    cancel()
    committed.current = value
    setDraft(value)
  }, [epoch, value, cancel])

  useEffect(() => cancel, [cancel])

  const commit = (next: string) => {
    cancel()
    if (next === committed.current) return
    committed.current = next
    onCommitRef.current(next)
  }

  const handleChange = (next: string) => {
    setDraft(next)
    if (filtering === 'browser') return commit(next)
    cancel()
    timer.current = setTimeout(() => commit(next), listSearchDebounceMs)
  }

  return (
    <div className="relative min-w-0 flex-1 basis-48">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--v2-ink-3)]">
        <Icon icon={Search} className="h-4 w-4" />
      </span>
      <input
        ref={inputRef}
        type="search"
        value={draft}
        placeholder={searchPlaceholder(noun)}
        aria-label={searchPlaceholder(noun)}
        aria-describedby={description ? descriptionId : undefined}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(draft)
          } else if (event.key === 'Escape' && draft) {
            event.preventDefault()
            event.stopPropagation()
            setDraft('')
            commit('')
          }
        }}
        className="min-h-11 w-full rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] py-2 pl-9 pr-11 text-ellipsis text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:min-h-[38px] sm:pr-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {description && (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      )}
      {draft && (
        <button
          type="button"
          aria-label={clearSearchLabel}
          onClick={() => {
            setDraft('')
            commit('')
            inputRef.current?.focus()
          }}
          // 44px on a phone, 24px (the WCAG 2.5.8 floor) on desktop.
          className={`absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] sm:right-1.5 sm:h-6 sm:w-6 ${listFocusRing}`}
        >
          <Icon icon={X} className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

const SHEET_ROW_CLASSES =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2.5 text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/80'

const SHEET_INPUT_CLASSES = 'h-4 w-4 shrink-0 accent-[var(--v2-brand)] focus-visible:outline-none'

/**
 * The phone sheet. Native radios and checkboxes in fieldsets — a dialog of
 * form controls, not menus — each change applied as it happens. Escape, the
 * backdrop and the footer close it; focus returns to the Filters button.
 */
function FilterSheet({
  noun,
  state,
  count,
  facets,
  sort,
  period,
  onFacet,
  onSort,
  onPeriod,
  onClear,
  onClose,
  closeOnWide,
}: {
  noun: ListNoun
  state: ListState
  count: ListCount | null
  facets: ListFacet[]
  sort?: ListToolbarSort
  period?: ListToolbarPeriod
  onFacet: (id: string, values: string[]) => void
  onSort: (value: string) => void
  onPeriod: (next: PeriodValue) => void
  onClear: () => void
  onClose: () => void
  closeOnWide: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const name = useId()
  useFocusTrap(panelRef, true)
  useEscapeToClose(true, onClose)
  useBodyScrollLock(true)

  // The sheet is a phone layout; widening past `sm` puts the desktop row
  // back, so the sheet closes rather than trap focus over it.
  useEffect(() => {
    if (!closeOnWide || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(min-width: 640px)')
    const onChange = (event: MediaQueryListEvent) => event.matches && onClose()
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [onClose, closeOnWide])

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-end">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="list-filter-sheet"
        className="v2-animate-slide-in relative flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-[var(--v2-bg)] shadow-modal pl-[var(--v2-safe-left)] pr-[var(--v2-safe-right)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-4 py-2">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--v2-ink)]">
            Filters
          </h2>
          <Button size="sm" variant="tertiary" onClick={onClear} className="min-h-11">
            {clearFiltersLabel}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {facets.map((facet) => {
            const values = state.facets[facet.id] ?? []
            const multi = facet.selection === 'multi'
            return (
              <SheetGroup key={facet.id} legend={facet.label}>
                {!multi && facet.allLabel !== null && (
                  <label className={SHEET_ROW_CLASSES}>
                    <input
                      type="radio"
                      name={`${name}-${facet.id}`}
                      checked={values.length === 0}
                      onChange={() => onFacet(facet.id, [])}
                      className={SHEET_INPUT_CLASSES}
                    />
                    <span className="flex-1">{facet.allLabel ?? allOptionLabel}</span>
                  </label>
                )}
                {facet.options.map((option) => {
                  const checked = values.includes(option.value)
                  return (
                    <label key={option.value} className={SHEET_ROW_CLASSES}>
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        name={`${name}-${facet.id}`}
                        checked={checked}
                        onChange={() =>
                          onFacet(
                            facet.id,
                            multi
                              ? checked
                                ? values.filter((v) => v !== option.value)
                                : [...values, option.value]
                              : [option.value],
                          )
                        }
                        className={SHEET_INPUT_CLASSES}
                      />
                      {/* `line-clamp-2` + the `meta` slot (#4150): the row
                          wraps and the status suffix always shows — no
                          hover on a touch device. */}
                      <span className="line-clamp-2 flex-1 text-ellipsis" title={option.label}>
                        {option.label}
                      </span>
                      {option.meta && <span className="shrink-0 text-xs text-[var(--v2-ink-3)]">{option.meta}</span>}
                      {option.count !== undefined && (
                        <span className="text-xs tabular-nums text-[var(--v2-ink-3)]">{option.count}</span>
                      )}
                    </label>
                  )
                })}
              </SheetGroup>
            )
          })}

          {sort && sort.options.length > 1 && (
            <SheetGroup legend="Sort">
              {sort.options.map((option) => (
                <label key={option.value} className={SHEET_ROW_CLASSES}>
                  <input
                    type="radio"
                    name={`${name}-sort`}
                    checked={state.sort === option.value}
                    onChange={() => onSort(option.value)}
                    className={SHEET_INPUT_CLASSES}
                  />
                  <span className="flex-1">{option.label}</span>
                </label>
              ))}
            </SheetGroup>
          )}

          {period && <SheetPeriodGroup name={`${name}-period`} value={state.period ?? {}} period={period} onChange={onPeriod} />}
        </div>

        <div className="border-t border-[var(--v2-border)] px-4 pb-[max(0.75rem,var(--v2-safe-bottom))] pt-3">
          <Button variant="primary" size="lg" onClick={onClose} className="w-full">
            {showResultsLabel(noun, count)}
          </Button>
        </div>
      </div>
    </div>
  )
}

function SheetGroup({ legend, children }: { legend: string; children: ReactNode }) {
  // `min-w-0`: a fieldset's default `min-width` is `min-content`, so one long
  // option ("Quarterly procurement and vendor reconciliation agent") widened
  // the group past a 375px sheet and its row never truncated (#4111,
  // `e2e/transactions-list-controls.spec.ts`).
  return (
    <fieldset className="min-w-0 border-b border-[var(--v2-border)] py-2 last:border-b-0">
      <legend className="px-2.5 pb-1 pt-2 v2-text-meta font-medium text-[var(--v2-ink-3)]">
        {legend}
      </legend>
      {children}
    </fieldset>
  )
}

function SheetPeriodGroup({
  name,
  value,
  period,
  onChange,
}: {
  name: string
  value: PeriodValue
  period: ListToolbarPeriod
  onChange: (next: PeriodValue) => void
}) {
  const isCustom = Boolean(value.from && value.to)
  const [showCustom, setShowCustom] = useState(isCustom)
  const [from, setFrom] = useState(value.from ?? '')
  const [to, setTo] = useState(value.to ?? '')
  const presets = period.presets ?? periodPresets

  return (
    <SheetGroup legend="Period">
      {(period.allowAllTime ?? true) && (
        <label className={SHEET_ROW_CLASSES}>
          <input
            type="radio"
            name={name}
            checked={!showCustom && isAllTime(value)}
            onChange={() => {
              setShowCustom(false)
              onChange({})
            }}
            className={SHEET_INPUT_CLASSES}
          />
          <span className="flex-1">{allTimeLabel}</span>
        </label>
      )}
      {presets.map((preset) => (
        <label key={preset} className={SHEET_ROW_CLASSES}>
          <input
            type="radio"
            name={name}
            checked={!showCustom && !isCustom && value.preset === preset}
            onChange={() => {
              setShowCustom(false)
              onChange({ preset })
            }}
            className={SHEET_INPUT_CLASSES}
          />
          <span className="flex-1">{periodPresetLabels[preset]}</span>
        </label>
      ))}
      {period.allowCustom && (
        <>
          <label className={SHEET_ROW_CLASSES}>
            <input
              type="radio"
              name={name}
              checked={showCustom || isCustom}
              onChange={() => setShowCustom(true)}
              className={SHEET_INPUT_CLASSES}
            />
            <span className="flex-1">{customRangeLabel}</span>
          </label>
          {(showCustom || isCustom) && (
            <div className="flex flex-col gap-2 px-2.5 pb-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-[var(--v2-ink-3)]">
                  From
                  <input
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    className="min-h-11 rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] px-2 text-sm text-[var(--v2-ink)]"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--v2-ink-3)]">
                  To
                  <input
                    type="date"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="min-h-11 rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] px-2 text-sm text-[var(--v2-ink)]"
                  />
                </label>
              </div>
              <p className="text-xs text-[var(--v2-ink-3)]">{customRangeHint}</p>
              <Button size="md" variant="ghost" disabled={!isValidRange(from, to)} onClick={() => onChange({ from, to })}>
                Apply range
              </Button>
            </div>
          )}
        </>
      )}
    </SheetGroup>
  )
}

/**
 * The no-match state (#4110): one for every list. It sits where the rows
 * would be and never replaces the toolbar, so the user can still edit what
 * caused it. A list with NOTHING yet keeps its own page-specific empty state.
 */
export function ListNoMatch({ noun, onClear }: { noun: ListNoun; onClear: () => void }) {
  return (
    <EmptyState
      icon={<Icon icon={SearchX} className="h-5 w-5" />}
      tone="neutral"
      title={noMatchTitle(noun)}
      body={noMatchBody}
      action={
        <Button variant="ghost" size="sm" onClick={onClear}>
          {clearFiltersLabel}
        </Button>
      }
    />
  )
}

/**
 * The paging rule (#4196): a paged list's card ends with its last row, and
 * the next page is one ghost button centred below the card — "Show 25 more",
 * N being what the next page adds. Nothing renders once every page is loaded:
 * the list ending is the end. A truncated read keeps the page's own hedge
 * under the summary line; this button says nothing about it.
 *
 * `loaded` and `total` must be one source's figures (the feed's loaded rows
 * and its server total), so N never mixes two reads.
 */
export function ListShowMore({
  loaded,
  total,
  pageSize,
  hasMore,
  loading,
  onShowMore,
}: {
  loaded: number
  total: number
  pageSize: number
  hasMore: boolean
  loading: boolean
  onShowMore: () => void
}) {
  if (!hasMore) return null
  return (
    <div className="mt-4 flex justify-center" data-testid="list-show-more">
      <Button variant="ghost" onClick={onShowMore} disabled={loading} aria-busy={loading || undefined}>
        {loading ? loadingMoreLabel : showMoreLabel(total - loaded, pageSize)}
      </Button>
    </div>
  )
}
