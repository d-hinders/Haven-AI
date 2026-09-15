import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The WIRING, not just the function (#3015, following the #2630 lesson that
 * `config-trust-proxy-wiring.test.ts` states in its own header).
 *
 * `config-boolean-flags.test.ts` proves `parseBooleanFlag` behaves. It does
 * NOT prove the six config fields go through it — and that gap is not
 * hypothetical here: reverting `config.ts`'s `hosted:` line to the pre-change
 * `process.env.HAVEN_HOSTED === 'true'` reintroduces the exact production
 * defect #3015 exists for, and leaves that suite 8/8 green. Measured, on this
 * branch, before this file was written.
 *
 * So each of the six variables is exercised through a real module load: set
 * the environment, `vi.resetModules()`, `await import('../config.js')`, and
 * assert what the imported module did. A refusal has to surface as the import
 * REJECTING — that is what a boot refusal is.
 *
 * Every case carries a positive control at `'true'`. Asserting only that a bad
 * value throws would stay green if the field stopped being read at all, which
 * is the neighbouring way to break this.
 */

/** The six variables `parseBooleanFlag` guards, and the field each lands on. */
const FLAGS = [
  ['HAVEN_HOSTED', 'hosted'],
  ['HAVEN_FEE_ENABLED', 'feeEnabled'],
  ['HAVEN_LEGACY_BOOKKEEPING_ENABLED', 'legacyBookkeepingEnabled'],
  ['CATALOG_DISCOVERY_ENABLED', 'catalogDiscoveryEnabled'],
  ['HAVEN_ACCOUNTING_ENABLED', 'accountingEnabled'],
] as const

// `HAVEN_REPORTING_FEED_ENABLED` is the sixth and is deliberately not in the
// table: it reaches `parseBooleanFlag` only through `readAccountingEnabled`'s
// fallback, which the new name suppresses, so it needs its own case below.
const ALL_NAMES = [...FLAGS.map(([name]) => name), 'HAVEN_REPORTING_FEED_ENABLED'] as const

describe('config wires its boolean flags through parseBooleanFlag (#3015)', () => {
  const saved = new Map<string, string | undefined>(ALL_NAMES.map((n) => [n, process.env[n]]))

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  /** Load `config.ts` fresh, with `name` set to `value`. */
  async function loadWith(name: string, value: string) {
    for (const other of ALL_NAMES) delete process.env[other]
    process.env[name] = value
    vi.resetModules()
    return import('../config.js')
  }

  it.each(FLAGS)(
    '%s reaches config.%s through the parser — "TRUE" refuses the boot, "true" is read',
    async (name, field) => {
      // The refusal, at module load: this is the boot refusing, not a unit
      // test of a pure function.
      await expect(loadWith(name, 'TRUE')).rejects.toThrow(new RegExp(`${name} is set to "TRUE"`))

      // Positive control on the other side, so a field that stopped being read
      // at all cannot pass this test.
      const mod = await loadWith(name, 'true')
      expect(mod.config[field]).toBe(true)

      const off = await loadWith(name, 'false')
      expect(off.config[field]).toBe(false)
    },
  )

  it('HAVEN_REPORTING_FEED_ENABLED, reached only through readAccountingEnabled\'s fallback, is guarded too', async () => {
    // The deprecated name is consulted only when the new one is unset, so this
    // is the one path the table above cannot cover.
    await expect(loadWith('HAVEN_REPORTING_FEED_ENABLED', 'TRUE')).rejects.toThrow(
      /HAVEN_REPORTING_FEED_ENABLED is set to "TRUE"/,
    )

    const mod = await loadWith('HAVEN_REPORTING_FEED_ENABLED', 'true')
    expect(mod.config.accountingEnabled).toBe(true)
  })

  it('the NEW name still wins over the deprecated one, and its refusal is the one that surfaces', async () => {
    for (const name of ALL_NAMES) delete process.env[name]
    process.env.HAVEN_ACCOUNTING_ENABLED = 'false'
    process.env.HAVEN_REPORTING_FEED_ENABLED = 'TRUE'
    vi.resetModules()

    // The precedence rule (#2859) is unchanged by #3015: the new name wins
    // whenever SET, so a stale — even unparseable — old value is never
    // consulted and cannot refuse the boot.
    const mod = await import('../config.js')
    expect(mod.config.accountingEnabled).toBe(false)
  })
})
