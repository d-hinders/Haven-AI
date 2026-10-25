/**
 * The catalog ingestion monitor is built ONCE in index.ts (#4407).
 *
 * The per-host probe cooldown lives inside `createCatalogIngestMonitor`.
 * Building the monitor inside the tick closure, or calling
 * `runCatalogIngestTick()` directly, gives every tick a fresh cooldown: it
 * then spans nothing, and a failing merchant is probed on every 5-minute tick.
 * That was the production wiring from #1714 to #4407, while every module test
 * injected its own shared cooldown and passed.
 *
 * A source assertion rather than a boot, the same shape as
 * `passport/__tests__/anchor-seams-wired.test.ts`: importing `index.ts` builds
 * a Fastify app, opens a pool and starts timers. Comments are stripped first,
 * so a call that survives only as a comment does not count.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url)), 'utf8')
const CODE = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('catalog ingestion monitor wiring in index.ts (#4407)', () => {
  const create = /const\s+(\w+)\s*=\s*createCatalogIngestMonitor\s*\(\s*\)/g
  const created = [...CODE.matchAll(create)]

  it('builds the monitor exactly once', () => {
    expect(created).toHaveLength(1)
  })

  it('builds it BEFORE the tick closure, so it outlives every tick', () => {
    const closure = CODE.indexOf('const runCatalogIngest = async')
    expect(closure).toBeGreaterThan(-1)
    expect(created[0]!.index!).toBeLessThan(closure)
  })

  it('the leader-locked tick calls that monitor, not a bare runCatalogIngestTick', () => {
    const name = created[0]![1]
    const closure = CODE.slice(CODE.indexOf('const runCatalogIngest = async'))
    const body = closure.slice(0, closure.indexOf('setInterval(runCatalogIngest'))
    expect(body).toMatch(/runIfLeader\(\s*LEADER_LOCK_KEYS\.catalogIngest/)
    expect(body).toMatch(new RegExp(`\\b${name}\\.tick\\(\\s*\\)`))
    expect(CODE).not.toMatch(/\brunCatalogIngestTick\s*\(/)
  })
})
