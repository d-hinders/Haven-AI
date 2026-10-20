import { describe, expect, it } from 'vitest'
import {
  clearedListState,
  defaultListState,
  isIsoDate,
  parseListState,
  rollingWindow,
  sameValues,
  serializeListState,
  type ListUrlSchema,
} from '../list-url-codec'

// A Transactions-shaped schema: `search` is its legacy key (#4095), the
// network facet is `chainId`, the period takes a custom range.
const TX: ListUrlSchema = {
  search: { aliases: ['search'] },
  facets: [
    { id: 'chainId', values: ['8453', '84532'] },
    { id: 'direction', values: ['in', 'out'] },
    { id: 'agentId' }, // options load later — no `values`, nothing dropped
  ],
  period: { allowCustom: true },
}

// An Agents-shaped schema: multi-select facets, a sort.
const AGENTS: ListUrlSchema = {
  facets: [
    { id: 'status', selection: 'multi', values: ['active', 'paused', 'revoked'] },
    { id: 'budget', selection: 'multi', values: ['recurring', 'none'] },
  ],
  sort: { values: ['name', 'seen'], defaultValue: 'name' },
}

// A Marketplace-shaped schema: the network facet defaults to the user's chain.
const MARKET: ListUrlSchema = {
  facets: [{ id: 'chainId', defaultValue: ['8453'], values: ['8453', '84532'] }],
}

const p = (s: string) => new URLSearchParams(s)

describe('parseListState', () => {
  it('reads an empty URL as the page defaults', () => {
    expect(parseListState(p(''), TX)).toEqual({
      q: '',
      facets: { chainId: [], direction: [], agentId: [] },
      period: {},
    })
    expect(parseListState(p(''), AGENTS).sort).toBe('name')
  })

  it('reads the legacy `search` key as q, and prefers q when both are present', () => {
    expect(parseListState(p('search=coffee'), TX).q).toBe('coffee')
    expect(parseListState(p('q=tea&search=coffee'), TX).q).toBe('tea')
  })

  it('no key means the page default; an explicit `all` means All', () => {
    expect(parseListState(p(''), MARKET).facets.chainId).toEqual(['8453'])
    expect(parseListState(p('chainId=all'), MARKET).facets.chainId).toEqual([])
    expect(parseListState(p('chainId=84532'), MARKET).facets.chainId).toEqual(['84532'])
  })

  it('reads comma-joined multi-select values, the agent-list-filters encoding', () => {
    expect(parseListState(p('status=active,paused'), AGENTS).facets.status).toEqual(['active', 'paused'])
  })

  it('drops unknown values; a key of only unknown values falls back to the default', () => {
    expect(parseListState(p('status=active,bogus'), AGENTS).facets.status).toEqual(['active'])
    expect(parseListState(p('chainId=999'), MARKET).facets.chainId).toEqual(['8453'])
  })

  it('keeps any value on a facet that declares no values (options not loaded yet)', () => {
    expect(parseListState(p('agentId=agent-123'), TX).facets.agentId).toEqual(['agent-123'])
  })

  it('a single-select facet keeps only its first value', () => {
    expect(parseListState(p('direction=in,out'), TX).facets.direction).toEqual(['in'])
  })

  it('reads period presets, `all`, and a valid custom range; ignores an invalid one', () => {
    expect(parseListState(p('period=30d'), TX).period).toEqual({ preset: '30d' })
    expect(parseListState(p('period=all'), TX).period).toEqual({})
    expect(parseListState(p('period=1y'), TX).period).toEqual({})
    expect(parseListState(p('from=2026-09-01&to=2026-10-20'), TX).period).toEqual({ from: '2026-09-01', to: '2026-10-20' })
    expect(parseListState(p('from=2026-10-20&to=2026-09-01'), TX).period).toEqual({})
    expect(parseListState(p('from=2026-02-30&to=2026-03-01'), TX).period).toEqual({})
  })

  it('without All time, `all` falls back to the default period', () => {
    const analytics: ListUrlSchema = { period: { allowAllTime: false, defaultValue: { preset: '30d' } } }
    expect(parseListState(p(''), analytics).period).toEqual({ preset: '30d' })
    expect(parseListState(p('period=all'), analytics).period).toEqual({ preset: '30d' })
    expect(parseListState(p('period=7d'), analytics).period).toEqual({ preset: '7d' })
  })

  it('an unknown sort falls back to the default', () => {
    expect(parseListState(p('sort=seen'), AGENTS).sort).toBe('seen')
    expect(parseListState(p('sort=bogus'), AGENTS).sort).toBe('name')
  })
})

describe('serializeListState', () => {
  it('round-trips every kind of key', () => {
    const urls = [
      'q=coffee&chainId=8453&direction=out&agentId=a1&period=30d',
      'from=2026-09-01&to=2026-10-20',
      'period=all',
    ]
    for (const url of urls) {
      const state = parseListState(p(url), TX)
      expect(parseListState(serializeListState(state, TX), TX)).toEqual(state)
    }
    const agents = parseListState(p('status=active,paused&budget=none&sort=seen'), AGENTS)
    expect(serializeListState(agents, AGENTS).toString()).toBe('status=active%2Cpaused&budget=none&sort=seen')
  })

  it('leaves foreign params (`tab`, `setup`) untouched', () => {
    const state = parseListState(p('tab=activity&q=x'), TX)
    const next = serializeListState({ ...state, q: 'y' }, TX, p('tab=activity&q=x'))
    expect(next.get('tab')).toBe('activity')
    expect(next.get('q')).toBe('y')

    const agents = serializeListState(defaultListState(AGENTS), AGENTS, p('setup=abc&status=active'))
    expect(agents.toString()).toBe('setup=abc')
  })

  it('writes the canonical key and removes the legacy alias', () => {
    const state = parseListState(p('search=coffee'), TX)
    expect(serializeListState(state, TX, p('search=coffee')).toString()).toBe('q=coffee')
  })

  it('deletes a key at its default; writes `all` only when All is not the default', () => {
    const market = parseListState(p(''), MARKET)
    expect(serializeListState(market, MARKET).toString()).toBe('')
    expect(serializeListState({ ...market, facets: { chainId: [] } }, MARKET).toString()).toBe('chainId=all')
    const tx = parseListState(p('direction=in'), TX)
    expect(serializeListState({ ...tx, facets: { ...tx.facets, direction: [] } }, TX, p('direction=in')).has('direction')).toBe(false)
  })

  it('does not write a blank q, and a custom range replaces a preset', () => {
    const state = parseListState(p('period=7d'), TX)
    const next = serializeListState({ ...state, q: '   ', period: { from: '2026-09-01', to: '2026-09-30' } }, TX, p('period=7d'))
    expect(next.toString()).toBe('from=2026-09-01&to=2026-09-30')
  })
})

describe('clearedListState', () => {
  it('returns search, facets and the period to the page default, and keeps the sort', () => {
    const state = parseListState(p('q=x&status=active&sort=seen'), AGENTS)
    expect(clearedListState(state, AGENTS)).toEqual({ q: '', facets: { status: [], budget: [] }, sort: 'seen' })
    // Marketplace: the default is the user's chain, not All.
    expect(clearedListState(parseListState(p('chainId=84532'), MARKET), MARKET).facets.chainId).toEqual(['8453'])
    const analytics: ListUrlSchema = { period: { allowAllTime: false, defaultValue: { preset: '30d' } } }
    expect(clearedListState(parseListState(p('period=7d'), analytics), analytics).period).toEqual({ preset: '30d' })
    expect(clearedListState(parseListState(p('period=7d'), TX), TX).period).toEqual({})
  })
})

describe('sameValues', () => {
  it('compares as sets, symmetrically', () => {
    expect(sameValues(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameValues(['a', 'b'], ['a', 'a'])).toBe(false)
    expect(sameValues(['a', 'a'], ['a', 'b'])).toBe(false)
  })
})

describe('helpers', () => {
  it('isIsoDate accepts real calendar dates only', () => {
    expect(isIsoDate('2026-10-20')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('20-10-2026')).toBe(false)
  })

  it('rollingWindow is [now − N×24h, now)', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    expect(rollingWindow('7d', now)).toEqual({ from: new Date('2026-10-13T12:00:00Z'), to: now })
    expect(rollingWindow('90d', now).from.toISOString()).toBe('2026-07-22T12:00:00.000Z')
  })
})
