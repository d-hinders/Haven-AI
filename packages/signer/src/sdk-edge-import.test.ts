import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #3173: the signer imports `@haven_ai/sdk/edge`, never the barrel. The barrel
 * pulls ethers, the x402 package and the HTTP client — ~1 s of module init on
 * every signer session for code the signer never calls. One import of the
 * barrel from a runtime file would bring all of it back silently.
 */
describe('signer runtime never imports the @haven_ai/sdk barrel (#3173)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const runtimeFiles = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))

  it('every runtime file that imports the SDK imports the edge subpath', () => {
    expect(runtimeFiles.length).toBeGreaterThan(5)
    const offenders: string[] = []
    let edgeImports = 0
    for (const f of runtimeFiles) {
      const src = readFileSync(join(here, f), 'utf8')
      if (/from '@haven_ai\/sdk'/.test(src)) offenders.push(f)
      if (/from '@haven_ai\/sdk\/edge'/.test(src)) edgeImports += 1
    }
    expect(offenders).toEqual([])
    // positive control: the instrument sees the subpath imports it expects
    expect(edgeImports).toBeGreaterThanOrEqual(5)
  })

  it('no runtime file imports x402/schemes STATICALLY — it is ~750 ms of module init, loaded on the merchant-header leg only', () => {
    const offenders: string[] = []
    let lazy = 0
    for (const f of runtimeFiles) {
      const src = readFileSync(join(here, f), 'utf8')
      if (/^import[^;]*from 'x402\//m.test(src)) offenders.push(f)
      if (/await import\('x402\/schemes'\)/.test(src)) lazy += 1
    }
    expect(offenders).toEqual([])
    expect(lazy).toBe(1)
  })
})
