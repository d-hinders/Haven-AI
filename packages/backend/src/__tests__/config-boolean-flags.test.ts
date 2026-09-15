import { describe, expect, it } from 'vitest'
import { parseBooleanFlag } from '../config.js'

/**
 * Boolean env flags (#3015), on the `parseAccountingEntitlementMode` pattern:
 * unset and empty land on the production-safe value; an unrecognised non-empty
 * value throws at import time and refuses the boot.
 *
 * The case these exist for is `TRUE`. Under the previous
 * `process.env.X === 'true'` it read as OFF, silently — which is how
 * `HAVEN_HOSTED=TRUE` left `config.hosted` false in production and made
 * `/accounting` tell users of the hosted service that the feed was
 * unavailable on a self-hosted deployment. `'TRUE'` throwing is the whole
 * point of this change, so it is asserted first and by name rather than
 * folded into a list of bad values.
 */
describe('parseBooleanFlag (#3015)', () => {
  it('REFUSES "TRUE" — the production incident this exists for', () => {
    expect(() => parseBooleanFlag('HAVEN_HOSTED', 'TRUE')).toThrow(/HAVEN_HOSTED is set to "TRUE"/)
  })

  it('is false when unset, null, or empty — an absent flag is off, and clearing one is not a third state', () => {
    expect(parseBooleanFlag('HAVEN_HOSTED', undefined)).toBe(false)
    expect(parseBooleanFlag('HAVEN_HOSTED', null)).toBe(false)
    expect(parseBooleanFlag('HAVEN_HOSTED', '')).toBe(false)
    expect(parseBooleanFlag('HAVEN_HOSTED', '   ')).toBe(false)
  })

  it('accepts the two literals, trimmed — a padded value is a dashboard paste artefact, not an unclear intent', () => {
    expect(parseBooleanFlag('HAVEN_HOSTED', 'true')).toBe(true)
    expect(parseBooleanFlag('HAVEN_HOSTED', 'false')).toBe(false)
    expect(parseBooleanFlag('HAVEN_HOSTED', ' true ')).toBe(true)
    expect(parseBooleanFlag('HAVEN_HOSTED', '\tfalse\n')).toBe(false)
  })

  it('REFUSES every other truthy-looking spelling rather than reading it as off', () => {
    for (const bad of ['TRUE', 'True', 'tRue', '1', 'yes', 'YES', 'on', 'y', 't', 'enabled']) {
      expect(() => parseBooleanFlag('HAVEN_FEE_ENABLED', bad), bad).toThrow(/is not a boolean/)
    }
  })

  it('REFUSES falsy-looking spellings too — reading "0" as false would be right by accident, and teaches the wrong contract', () => {
    for (const bad of ['FALSE', 'False', '0', 'no', 'off', 'disabled']) {
      expect(() => parseBooleanFlag('CATALOG_DISCOVERY_ENABLED', bad), bad).toThrow(/is not a boolean/)
    }
  })

  it('the refusal names the variable, so the operator can fix it from the log line alone', () => {
    expect(() => parseBooleanFlag('HAVEN_LEGACY_BOOKKEEPING_ENABLED', 'TRUE')).toThrow(
      /HAVEN_LEGACY_BOOKKEEPING_ENABLED/,
    )
    expect(() => parseBooleanFlag('CATALOG_DISCOVERY_ENABLED', '1')).toThrow(/CATALOG_DISCOVERY_ENABLED/)
  })

  it('the refusal quotes the offending value so whitespace and case are visible in the log', () => {
    // The bug it is diagnosing can be a single invisible character, so the
    // message must not print the raw value bare.
    expect(() => parseBooleanFlag('HAVEN_HOSTED', 'true;')).toThrow(/"true;"/)
    expect(() => parseBooleanFlag('HAVEN_HOSTED', 'tr ue')).toThrow(/"tr ue"/)
  })

  it('the refusal says what to do instead, both directions', () => {
    const run = () => parseBooleanFlag('HAVEN_FEE_ENABLED', 'yes')
    // How to say yes…
    expect(run).toThrow(/exactly "true" or "false", lower-case/)
    // …and how to say no without guessing.
    expect(run).toThrow(/Unset HAVEN_FEE_ENABLED to get false deliberately/)
  })
})
