'use client'

/**
 * Tabs — the canonical "switch between views of one surface" control (#4096,
 * epic #4093). The account page is the first consumer: its Overview / Agents /
 * Activity / … sections are one screen with several views, and a page-local
 * tab row would be the second hand-rolled copy of a shape the design system
 * did not yet own.
 *
 * ## Controlled, URL-blind
 *
 * `packages/ui` is also consumed by the ops console, so the primitive knows
 * nothing about URLs or panels: the caller owns `value` / `onChange` (and the
 * account page owns its `?tab=` param). Each entry is `{ value, label }` with
 * two optional adornments — a muted trailing `count` (a tab's OWN number,
 * rendered outside the label's accessible name is NOT the rule here: the
 * count is visible text and reads with the tab) and an amber `warningDot`
 * ("this view has something that needs you"), which is decorative to the
 * eye and named to the ear through its `sr-only` text.
 *
 * ## WAI-ARIA tabs pattern
 *
 * `role="tablist"` of `role="tab"` buttons with `aria-selected`. Roving
 * tabindex: only the selected tab is in the Tab order — pressing Tab from
 * anywhere in the list leaves it, exactly as the pattern requires. The arrow
 * keys move selection WITH focus (automatic activation: this primitive has
 * no lazy panels to defer), wrapping at both ends; Home/End jump. The list
 * is horizontally scrollable when it outgrows its container, so arrowing
 * past the visible edge scrolls the newly focused tab into view.
 *
 * ## The underline
 *
 * The selected tab carries a 2px brand underline that overlaps the list's
 * 1px border by 1px (`-mb-px`), so the two read as one continuous rule
 * rather than a floating dash. Every tab carries a transparent `::after`
 * that extends the HIT area to 44px vertically — never sideways, the tabs
 * abut — the same mechanism as `SegmentedControl`'s options (#4056); the
 * painted height stays 36px.
 */
import { useRef } from 'react'

export interface TabItem<T extends string> {
  value: T
  label: string
  /** Optional muted trailing count (e.g. the number of agents on a tab). */
  count?: number
  /** Optional amber dot marking "something here needs your attention". */
  warningDot?: boolean
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: ReadonlyArray<TabItem<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible name for the list, read before the tabs ("Account, tab…"). */
  ariaLabel: string
}) {
  const listRef = useRef<HTMLDivElement>(null)

  function selectAndFocus(next: T) {
    onChange(next)
    // Selection follows focus, so the newly selected tab — the tablist's one
    // tab stop — must carry focus after the caller re-renders. Indexed data
    // attribute, not a value selector: tab values are caller strings and
    // must never be interpreted as a CSS selector.
    const index = tabs.findIndex((tab) => tab.value === next)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab-index="${index}"]`)
      ?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const current = tabs.findIndex((tab) => tab.value === value)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % tabs.length
        break
      case 'ArrowLeft':
        next = (current - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    selectAndFocus(tabs[next].value)
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex items-stretch gap-1 overflow-x-auto border-b border-[var(--v2-border)]"
    >
      {tabs.map((tab, index) => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-tab-index={index}
            // Roving tabindex: the selected tab is the list's single Tab
            // stop; Tab from any tab moves on OUT of the list (pattern rule).
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={`relative -mb-px flex-shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${
              active
                ? 'border-[var(--v2-brand)] text-[var(--v2-brand)]'
                : 'border-transparent text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]'
            }`}
          >
            {tab.label}
            {typeof tab.count === 'number' ? (
              <span className="v2-tabular ml-1.5 text-xs text-[var(--v2-ink-3)]">{tab.count}</span>
            ) : null}
            {tab.warningDot ? (
              <>
                <span
                  aria-hidden="true"
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--v2-warning)]"
                />
                <span className="sr-only">Needs attention</span>
              </>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
