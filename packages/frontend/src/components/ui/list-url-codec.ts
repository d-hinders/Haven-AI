/**
 * The list-controls URL codec (#4110, epic #4108): one pure parse/serialize
 * pair for every list that uses `ListToolbar`. The hook that drives it from
 * the address bar is `useListUrlState`; the page owns that hook.
 *
 * The rules, in the order a reader of a URL needs them:
 *
 * - **No key means the page's default; an explicit `all` means All.** The
 *   default is not always All — Marketplace defaults its network facet to the
 *   user's chain — so "absent" and "all" are different answers and the
 *   serializer writes `all` only when All differs from the default.
 * - **Multi-select values are comma-joined** (`status=active,paused`), the
 *   encoding `lib/agent-list-filters.ts` has shipped since #3165, so existing
 *   Agents links keep parsing.
 * - **Keys this codec does not own are never touched** — Agents' `setup`
 *   hand-off, a page's tab key. Serialize starts from the current
 *   params and only sets or deletes its own keys.
 * - **Legacy aliases are read, never written.** Transactions has read `search`
 *   since #4095; it parses as `q` and is removed on the next write, so a link
 *   keeps working and the URL converges on one name.
 * - **Period values are `7d` / `30d` / `90d`** (`types/transactions.ts`), plus
 *   `from` / `to` as `YYYY-MM-DD` for a custom range.
 *
 * This is the URL codec ONLY. It is deliberately separate from any API param
 * builder: a page that renames a URL key must not change what it sends to the
 * backend, so a page maps `ListState` to its request itself.
 */

export type PeriodPreset = '7d' | '30d' | '90d'

export const periodPresets: readonly PeriodPreset[] = ['7d', '30d', '90d']

/**
 * A period selection. `{}` is All time; a preset is a rolling window; `from`
 * and `to` together are a custom range (both days included).
 */
export interface PeriodValue {
  preset?: PeriodPreset
  from?: string
  to?: string
}

/** The whole state of a list's controls. A facet's `[]` means All. */
export interface ListState {
  q: string
  facets: Record<string, string[]>
  sort?: string
  period?: PeriodValue
}

/** What the codec needs to know about one facet. `ListFacet` extends it. */
export interface FacetUrlSpec {
  /** The URL key — also the facet's id. `chainId` is the network key everywhere. */
  id: string
  /** Multi-select facets keep every value; single-select keeps the first. */
  selection?: 'single' | 'multi'
  /** The value when the key is absent. Omitted: `[]`, which is All. */
  defaultValue?: readonly string[]
  /**
   * The values this facet accepts. When given, unknown values are dropped on
   * read, so a stale link never filters on an option that no longer exists.
   * Omit it for a facet whose options load asynchronously (an agent id read
   * before the agent list arrives would otherwise be thrown away).
   */
  values?: readonly string[]
  /** Older keys read as this facet (never written). */
  aliases?: readonly string[]
  /**
   * The facet's "no filter" row (#4113). Omitted: "All". A string renames
   * it. `null` means the facet HAS no All — a single-select facet whose
   * every value is a real choice ("Archived: Hidden / Shown"); it needs a
   * `defaultValue`, an explicit `all` in the URL reads as that default, and
   * `[]` is never written.
   */
  allLabel?: string | null
}

export interface ListUrlSchema {
  /** The search key. Default `q`; aliases are legacy keys read as it. */
  search?: { key?: string; aliases?: readonly string[] }
  facets?: readonly FacetUrlSpec[]
  sort?: { values: readonly string[]; defaultValue: string }
  period?: {
    /** Presets this list offers. Default all three. */
    presets?: readonly PeriodPreset[]
    /** Whether All time is offered. When false, `all` is not accepted. */
    allowAllTime?: boolean
    /** Whether a custom `from`/`to` range is accepted. */
    allowCustom?: boolean
    /** The value when the key is absent. Default All time (`{}`). */
    defaultValue?: PeriodValue
  }
}

/** The explicit All token. */
export const allValue = 'all'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True for a calendar date the browser can parse and that round-trips. */
export function isIsoDate(value: string | undefined | null): value is string {
  if (!value || !DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function searchKey(schema: ListUrlSchema): string {
  return schema.search?.key ?? 'q'
}

function firstOf(params: URLSearchParams, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params.get(key)
    if (value !== null) return value
  }
  return null
}

/** Same set of values, order and duplicates aside. */
export function sameValues(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sb].every((v) => sa.has(v))
}

export function samePeriod(a: PeriodValue | undefined, b: PeriodValue | undefined): boolean {
  return (a?.preset ?? '') === (b?.preset ?? '') && (a?.from ?? '') === (b?.from ?? '') && (a?.to ?? '') === (b?.to ?? '')
}

/** True when the period is All time. */
export function isAllTime(period: PeriodValue | undefined): boolean {
  return !period?.preset && !(period?.from && period?.to)
}

function parseFacet(params: URLSearchParams, spec: FacetUrlSpec): string[] {
  const raw = firstOf(params, [spec.id, ...(spec.aliases ?? [])])
  if (raw === null) return [...(spec.defaultValue ?? [])]
  if (raw === allValue) return spec.allLabel === null ? [...(spec.defaultValue ?? [])] : []
  const allowed = spec.values ? new Set(spec.values) : null
  const seen = new Set<string>()
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '' && v !== allValue && (!allowed || allowed.has(v)) && !seen.has(v) && seen.add(v))
  // A key that held only unknown values is a stale link, not a request for
  // All: fall back to the default, the same answer an absent key gets.
  if (values.length === 0) return [...(spec.defaultValue ?? [])]
  return spec.selection === 'multi' ? values : values.slice(0, 1)
}

function parsePeriod(params: URLSearchParams, schema: NonNullable<ListUrlSchema['period']>): PeriodValue {
  const presets = schema.presets ?? periodPresets
  const allowAllTime = schema.allowAllTime ?? true
  const fallback: PeriodValue = { ...(schema.defaultValue ?? {}) }
  const from = params.get('from')
  const to = params.get('to')
  if (schema.allowCustom && isIsoDate(from) && isIsoDate(to) && from <= to) return { from, to }
  const raw = params.get('period')
  if (raw === null) return fallback
  if (raw === allValue) return allowAllTime ? {} : fallback
  if ((presets as readonly string[]).includes(raw)) return { preset: raw as PeriodPreset }
  return fallback
}

/** Read a list's state from the URL. Pure: same params, same state. */
export function parseListState(params: URLSearchParams, schema: ListUrlSchema): ListState {
  const key = searchKey(schema)
  const q = firstOf(params, [key, ...(schema.search?.aliases ?? [])]) ?? ''

  const facets: Record<string, string[]> = {}
  for (const spec of schema.facets ?? []) facets[spec.id] = parseFacet(params, spec)

  const state: ListState = { q, facets }

  if (schema.sort) {
    const raw = params.get('sort')
    state.sort = raw !== null && schema.sort.values.includes(raw) ? raw : schema.sort.defaultValue
  }
  if (schema.period) state.period = parsePeriod(params, schema.period)
  return state
}

/**
 * Write a list's state into a COPY of `current`. Owned keys are set or
 * deleted; every other key is carried over untouched.
 */
export function serializeListState(
  state: ListState,
  schema: ListUrlSchema,
  current: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const next = new URLSearchParams(current)

  const key = searchKey(schema)
  for (const alias of schema.search?.aliases ?? []) next.delete(alias)
  const q = state.q.trim()
  if (q) next.set(key, q)
  else next.delete(key)

  for (const spec of schema.facets ?? []) {
    for (const alias of spec.aliases ?? []) next.delete(alias)
    const values = state.facets[spec.id] ?? []
    const defaults = spec.defaultValue ?? []
    // A facet without All has no `[]`: it reads as the default (#4113).
    if (sameValues(values, defaults) || (values.length === 0 && spec.allLabel === null)) next.delete(spec.id)
    else if (values.length === 0) next.set(spec.id, allValue)
    else next.set(spec.id, values.join(','))
  }

  if (schema.sort) {
    if (!state.sort || state.sort === schema.sort.defaultValue) next.delete('sort')
    else next.set('sort', state.sort)
  }

  if (schema.period) {
    const period = state.period ?? {}
    next.delete('from')
    next.delete('to')
    if (samePeriod(period, schema.period.defaultValue ?? {})) next.delete('period')
    else if (period.from && period.to) {
      next.delete('period')
      next.set('from', period.from)
      next.set('to', period.to)
    } else if (period.preset) next.set('period', period.preset)
    else next.set('period', allValue)
  }

  return next
}

/** The state every control starts from when the URL says nothing. */
export function defaultListState(schema: ListUrlSchema): ListState {
  return parseListState(new URLSearchParams(), schema)
}

/**
 * The state "Clear filters" goes to: the page's default view — search empty,
 * every facet and the period at the page default (All / All time unless the
 * page says otherwise). Sort is a view choice, not a filter, so it is kept.
 * "Filtered" is always measured against this same default (#4110 review),
 * so a cleared list never reads as filtered.
 */
export function clearedListState(state: ListState, schema: ListUrlSchema): ListState {
  const facets: Record<string, string[]> = {}
  for (const spec of schema.facets ?? []) facets[spec.id] = [...(spec.defaultValue ?? [])]
  const next: ListState = { q: '', facets }
  if (schema.sort) next.sort = state.sort ?? schema.sort.defaultValue
  if (schema.period) next.period = { ...(schema.period.defaultValue ?? {}) }
  return next
}

/** Rolling window for a preset: `[now − N×24h, now)`, the backend's rule. */
export function rollingWindow(preset: PeriodPreset, now: Date = new Date()): { from: Date; to: Date } {
  const days = Number(preset.replace('d', ''))
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now }
}
