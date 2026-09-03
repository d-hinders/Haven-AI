import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_CHANNEL_PATTERN,
  DEFAULT_CONNECTOR_CHANNEL,
  parseConnectorChannel,
} from '../config.js'
// #2423: imported statically, NOT with `await import()` inside the test. The
// SDK is a large module and its cold transform alone exceeded vitest's 5s
// per-test budget, so a dynamic import made this test fail for a reason that
// had nothing to do with its subject — the worst kind of red.
import { HAVEN_CONNECTOR_CHANNEL, resolveConnectorChannel } from '@haven_ai/sdk'

/**
 * `HAVEN_CONNECTOR_CHANNEL` parsing (#2422, epic #2420).
 *
 * The default is the thing under guard. Production never sets this variable,
 * so "unset ⇒ alpha" is the entire production blast radius of the change, and
 * a default that drifted would be invisible: every existing assertion in the
 * route suite is written against `CONNECTOR_PACKAGE` and would follow the
 * drift. The first test below pins the literal instead, and
 * `routes/__tests__/connector-channel-characterization.test.ts` pins the
 * rendered handout the same way, one layer up.
 */
describe('parseConnectorChannel — the default (#2422)', () => {
  it('is exactly "alpha", and that literal is written here rather than derived', () => {
    // Deliberately NOT `expect(...).toBe(DEFAULT_CONNECTOR_CHANNEL)`: an
    // assertion against the constant follows the constant and proves nothing
    // about which channel production hands out.
    expect(parseConnectorChannel(undefined)).toBe('alpha')
    expect(DEFAULT_CONNECTOR_CHANNEL).toBe('alpha')
  })

  it('treats an empty or whitespace-only value as unset, not as an error', () => {
    // Railway and every dashboard like it can store a cleared variable as the
    // empty string. "The operator cleared it" must land on the
    // production-safe value, not on a refusal to boot.
    expect(parseConnectorChannel('')).toBe('alpha')
    expect(parseConnectorChannel('   ')).toBe('alpha')
  })

  it('never returns anything but "alpha" for any absent-ish input', () => {
    for (const raw of [undefined, '', ' ', '\t', '\n', '  \n ']) {
      expect(parseConnectorChannel(raw)).toBe('alpha')
    }
  })
})

describe('parseConnectorChannel — accepted values (#2422)', () => {
  it('accepts the channel this epic exists to enable', () => {
    expect(parseConnectorChannel('dev')).toBe('dev')
  })

  it('accepts an explicit "alpha" and other well-formed dist-tags', () => {
    expect(parseConnectorChannel('alpha')).toBe('alpha')
    expect(parseConnectorChannel('latest')).toBe('latest')
    expect(parseConnectorChannel('next-rc')).toBe('next-rc')
    expect(parseConnectorChannel('a')).toBe('a')
    expect(parseConnectorChannel(`a${'b'.repeat(31)}`)).toBe(`a${'b'.repeat(31)}`)
  })

  it('trims surrounding whitespace from a paste', () => {
    expect(parseConnectorChannel('  dev  ')).toBe('dev')
    expect(parseConnectorChannel('\ndev\n')).toBe('dev')
  })
})

describe('parseConnectorChannel — refusal (#2422)', () => {
  /**
   * FAIL LOUDLY, not fall back. A silent fallback to `alpha` on a typo
   * (`HAVEN_CONNECTOR_CHANNEL=dve`) would make the dev backend keep handing
   * out the PRODUCTION connector while the environment looked fixed — the
   * exact defect this slice removes, reintroduced by a typo nobody sees.
   */
  const REFUSED: Array<[string, string]> = [
    ['a typo that is not a real tag but IS well-formed', 'dve'], // see below
    ['uppercase', 'Dev'],
    ['a leading digit', '1dev'],
    ['a leading hyphen', '-dev'],
    ['an underscore', 'dev_snapshot'],
    ['a dot (npm allows it; the shell-safety narrowing does not)', '0.0.0-dev'],
    ['a scope separator', 'dev@latest'],
    ['a path separator', 'dev/latest'],
    ['embedded whitespace', 'dev latest'],
    ['a shell command separator', 'dev; rm -rf /'],
    ['a shell substitution', 'dev$(id)'],
    ['a backtick substitution', 'dev`id`'],
    ['a background operator', 'dev & curl evil.example'],
    ['a quote that could escape the spec', "dev'"],
    ['33 characters (one over the cap)', `a${'b'.repeat(32)}`],
  ]

  for (const [label, value] of REFUSED) {
    it(`refuses ${label}`, () => {
      // 'dve' is the one entry that is WELL-FORMED and therefore accepted —
      // it is listed to record that this validation cannot catch a plausible
      // typo, only a malformed one. Assert what is actually true of it.
      if (value === 'dve') {
        expect(parseConnectorChannel('dve')).toBe('dve')
        return
      }
      expect(() => parseConnectorChannel(value)).toThrow(/HAVEN_CONNECTOR_CHANNEL/)
    })
  }

  it('names the variable and the offending value in the message', () => {
    let message = ''
    try {
      parseConnectorChannel('Dev')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('HAVEN_CONNECTOR_CHANNEL')
    expect(message).toContain('"Dev"')
  })

  it('says explicitly that it is NOT falling back to alpha', () => {
    // The message is what an operator reads at 3am. If it merely said
    // "invalid value", the natural assumption is that the service came up on
    // the default — which is the one thing it must not be assumed to have done.
    let message = ''
    try {
      parseConnectorChannel('Dev')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/[Rr]efusing to start/)
    expect(message).toContain('alpha')
  })

  it('refuses every shell metacharacter that could re-split the setup command', () => {
    // The package spec is interpolated into `npx -y <spec> …` UNQUOTED
    // (`shellQuote` covers the token and the API URL, not the spec), and that
    // command is pasted into a real terminal. So this pattern is a shell
    // boundary, not just a label check.
    for (const ch of [' ', '\t', ';', '&', '|', '$', '`', '(', ')', '<', '>', '"', "'", '\\', '/', '@', '\n']) {
      expect(() => parseConnectorChannel(`dev${ch}x`)).toThrow(/HAVEN_CONNECTOR_CHANNEL/)
    }
  })
})

describe('CONNECTOR_CHANNEL_PATTERN (#2422)', () => {
  it('is anchored at both ends', () => {
    // An unanchored pattern would accept `evil;dev` by matching the tail.
    expect(CONNECTOR_CHANNEL_PATTERN.source.startsWith('^')).toBe(true)
    expect(CONNECTOR_CHANNEL_PATTERN.source.endsWith('$')).toBe(true)
  })

  it('is not sticky or global, so repeated tests do not alternate', () => {
    // A /g regex carries lastIndex across .test() calls, which would make this
    // validator pass and fail on alternate boots for the same value.
    expect(CONNECTOR_CHANNEL_PATTERN.flags).toBe('')
  })
})

/**
 * Cross-package agreement (#2423, slice 3 of epic #2420).
 *
 * `HAVEN_CONNECTOR_CHANNEL` now has THREE readers: this backend
 * (`parseConnectorChannel` above), the hosted MCP server, and
 * `resolveConnectorChannel` in `@haven_ai/sdk` — which the hosted server and
 * every published package resolve through. Each was written to the same
 * pattern, the same default and the same refuse-rather-than-fall-back rule, and
 * three hand-maintained copies of one rule is precisely how the three start
 * disagreeing about what a valid channel is.
 *
 * So the agreement is EXECUTED rather than asserted in a comment: both
 * implementations are run over the same table, including the inputs where the
 * two could plausibly diverge — the empty string, whitespace, the boundary
 * lengths, and every excluded shell metacharacter. A comment claiming they
 * match is not a guard; this is.
 *
 * **Build precondition.** This block imports `@haven_ai/sdk`, so it needs
 * `packages/sdk/dist` to exist: in a FRESH clone, `npm ci` alone leaves it
 * unbuilt and the whole file fails to collect with
 * `Failed to resolve entry for package "@haven_ai/sdk"` — which reads like a
 * broken test rather than a missing build. Run:
 *
 *     npm run build -w packages/sdk
 *
 * CI builds the workspace before running suites, so this bites reviewers and
 * fresh checkouts rather than the pipeline. Recorded here because a reviewer
 * hit exactly this and could not verify these assertions as a result.
 */
describe('the backend and @haven_ai/sdk agree about what a channel is (#2423)', () => {
  const CASES: (string | undefined)[] = [
    undefined, '', '   ', '\t', 'alpha', 'dev', 'latest', 'next-2', 'a',
    'a'.repeat(32), 'a'.repeat(33), 'Dev', 'DEV', '-dev', '9dev', 'dev.1',
    'dev/x', 'dev@x', 'dev x', 'dev;x', 'dev|x', 'dev&x', 'dev$x', 'dev`x',
    'dev"x', "dev'x", 'dev\nx', 'dve',
  ]

  it('resolves identically, or refuses identically, on every input', () => {
    // Instrument self-test first: if the table cannot produce BOTH outcomes,
    // "they agree" would be vacuous.
    const outcomes = new Set(
      CASES.map((c) => {
        try {
          parseConnectorChannel(c)
          return 'resolved'
        } catch {
          return 'threw'
        }
      }),
    )
    expect(outcomes, 'the input table must exercise both acceptance and refusal').toEqual(
      new Set(['resolved', 'threw']),
    )

    for (const input of CASES) {
      let mine: string | Error
      let theirs: string | Error
      try {
        mine = parseConnectorChannel(input)
      } catch (err) {
        mine = err as Error
      }
      try {
        theirs = resolveConnectorChannel(input)
      } catch (err) {
        theirs = err as Error
      }

      const describeOutcome = (r: string | Error) => (r instanceof Error ? 'REFUSED' : r)
      expect(
        describeOutcome(theirs),
        `backend and SDK disagree on ${JSON.stringify(input)}: backend says ` +
          `${describeOutcome(mine)}, SDK says ${describeOutcome(theirs)}`,
      ).toBe(describeOutcome(mine))
    }
  })

  it('shares the default, so an unconfigured environment lands in the same place', () => {
    // Both literals, not both derived — see the note on the first test above.
    expect(DEFAULT_CONNECTOR_CHANNEL).toBe('alpha')
    expect(HAVEN_CONNECTOR_CHANNEL).toBe('alpha')
  })
})
