'use client'

import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { RadioMark } from './FacetMenu'
import { allTimeLabel, customRangeLabel, customRangeHint, periodPresetLabels, periodLabel } from './list-controls-copy'
import { listMenuItemClasses, listMenuPanelClasses, listTriggerClasses, useListMenu } from './list-menu'
import { periodPresets, isAllTime, isIsoDate, type PeriodPreset, type PeriodValue } from './list-url-codec'

export interface PeriodPickerProps {
  value: PeriodValue
  onChange: (next: PeriodValue) => void
  /** The rolling presets offered. Default 7 / 30 / 90 days. */
  presets?: readonly PeriodPreset[]
  /** Offer "All time" (the absent filter). Default true; Analytics passes false. */
  allowAllTime?: boolean
  /** Offer a custom from/to range. Default false — only where the backend takes dates. */
  allowCustom?: boolean
  align?: 'left' | 'right'
  label?: string
}

const DATE_INPUT_CLASSES =
  'min-h-11 w-full rounded-md border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] px-2 py-1.5 text-sm text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:min-h-0'

/** Both dates set, start not after end — the rule the server answers with a 400. */
export function isValidRange(from: string, to: string): boolean {
  return isIsoDate(from) && isIsoDate(to) && from <= to
}

/**
 * The one Period control (#4110, epic #4108), for the list toolbar and the
 * Analytics header alike, with one wording: "Last 7 days", "Last 30 days",
 * "Last 90 days", "All time", "Custom range".
 *
 * Presets are rolling windows, `[now − N×24h, now)` — the rule the backend
 * already applies (`modules/transactions/period.ts`) — and their values stay
 * `7d` / `30d` / `90d`. All time is the absent filter, not a fourth value.
 *
 * A menu button with `menuitemradio` rows. "Custom range" swaps the panel
 * for two date fields (a form, not menu items) with Back and Apply; the
 * range applies only once both dates are valid.
 */
export function PeriodPicker({
  value,
  onChange,
  presets = periodPresets,
  allowAllTime = true,
  allowCustom = false,
  align = 'right',
  label = 'Period',
}: PeriodPickerProps) {
  const menu = useListMenu()
  const [custom, setCustom] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const fromRef = useRef<HTMLInputElement>(null)
  const isCustom = Boolean(value.from && value.to)

  // Every open starts on the list, whatever view the last one closed on.
  useEffect(() => {
    if (!menu.open) setCustom(false)
  }, [menu.open])

  useEffect(() => {
    if (custom) fromRef.current?.focus()
  }, [custom])

  const choose = (next: PeriodValue) => {
    onChange(next)
    menu.close(true)
  }

  const openCustom = () => {
    setFrom(value.from ?? '')
    setTo(value.to ?? '')
    setCustom(true)
  }

  const rows: { key: string; label: string; checked: boolean; onSelect: () => void }[] = []
  if (allowAllTime) rows.push({ key: 'all', label: allTimeLabel, checked: isAllTime(value), onSelect: () => choose({}) })
  for (const preset of presets) {
    rows.push({
      key: preset,
      label: periodPresetLabels[preset],
      checked: !isCustom && value.preset === preset,
      onSelect: () => choose({ preset }),
    })
  }
  if (allowCustom) rows.push({ key: 'custom', label: customRangeLabel, checked: isCustom, onSelect: openCustom })

  const active = allowAllTime ? !isAllTime(value) : true

  return (
    <div ref={menu.wrapperRef} className="relative inline-flex">
      <button {...menu.triggerProps} className={listTriggerClasses(active)}>
        <span className={active ? '' : 'text-[var(--v2-ink-3)]'}>{label}:</span>
        {' '}
        <span className="font-medium">{periodLabel(value)}</span>
        <Icon
          icon={ChevronDown}
          className={`h-3.5 w-3.5 shrink-0 motion-safe:transition-transform ${menu.open ? 'rotate-180' : ''}`}
        />
      </button>
      {menu.open && (
        <div
          ref={menu.panelRef}
          id={menu.menuId}
          role={custom ? 'group' : 'menu'}
          aria-labelledby={custom ? undefined : menu.triggerId}
          aria-label={custom ? customRangeLabel : undefined}
          onKeyDown={(event) => {
            // The custom form is fields, not menu items: Tab and the arrow
            // keys belong to the date inputs. Escape still closes.
            if (custom && event.key !== 'Escape') return
            menu.onPanelKeyDown(event)
          }}
          style={menu.panelStyle}
          className={`${listMenuPanelClasses} ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {!custom &&
            rows.map((row) => (
              <button
                key={row.key}
                type="button"
                role="menuitemradio"
                aria-checked={row.checked}
                tabIndex={-1}
                onClick={row.onSelect}
                className={listMenuItemClasses}
              >
                <RadioMark checked={row.checked} />
                <span className="truncate">{row.label}</span>
                <span />
              </button>
            ))}
          {custom && (
            <form
              className="flex w-[17rem] max-w-full flex-col gap-2 p-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (isValidRange(from, to)) choose({ from, to })
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-[var(--v2-ink-3)]">
                  From
                  <input
                    ref={fromRef}
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(event) => setFrom(event.target.value)}
                    className={DATE_INPUT_CLASSES}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--v2-ink-3)]">
                  To
                  <input
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(event) => setTo(event.target.value)}
                    className={DATE_INPUT_CLASSES}
                  />
                </label>
              </div>
              <p className="text-xs text-[var(--v2-ink-3)]">{customRangeHint}</p>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={() => {
                    setCustom(false)
                    requestAnimationFrame(() => menu.focusItem('checked'))
                  }}
                >
                  Back
                </Button>
                <Button size="sm" variant="primary" type="submit" disabled={!isValidRange(from, to)}>
                  Apply
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
