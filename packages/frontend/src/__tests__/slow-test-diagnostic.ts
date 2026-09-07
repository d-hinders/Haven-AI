/**
 * The load diagnostic for a slow or timed-out frontend test (#2319).
 *
 * ## Why it exists
 *
 * Four suites — `DelegationSendModal`, `InfoModal`, `UnmanagedDelegateCard`,
 * `Modal` — once went red on `Test timed out in 5000ms` during a full-suite run
 * that took 336 s instead of the usual ~122 s. The first attribution, a new
 * `it.each` guard, measured at 146 ms against a 214 s delta: it could not have
 * been the cause. What those four share is that their FIRST test renders a
 * `ui/Modal`, and that first render in a freshly isolated file is the most
 * expensive thing the frontend suite does per test — 250–450 ms on an idle
 * machine, against a 5000 ms budget — so it is the first thing to cross the
 * line when the machine is oversubscribed, and it scales with the
 * oversubscription rather than with anything in the file.
 *
 * A timeout in that shape reports on the machine, not on the code, and the
 * bare vitest message says nothing about which it was. This diagnostic exists
 * so the log carries the distinguishing fact — the 1-minute load average
 * against the core count at the moment the test finished — next to the
 * failure, instead of leaving the reader to re-derive it from a `dev`
 * baseline comparison, which is what #2329 had to do on the backend.
 *
 * ## What it deliberately is not
 *
 * Not a bigger timeout. `testTimeout` stays at vitest's 5000 ms default —
 * `suite-timing-posture.test.ts` pins that — because a budget raised until a
 * contended run passes is a budget at which a genuinely hung test is no longer
 * detected, on every file at once. That was the backend's conclusion twice
 * (#2329, #2354) and it holds here for the same reason.
 *
 * Pure function over an explicit reading, so the message can be unit-tested
 * without a loaded machine; `setup.ts` supplies the live values.
 */

/** A test that takes longer than this gets a diagnostic even when it passes. */
export const SLOW_TEST_DIAGNOSTIC_MS = 2000

/**
 * The oversubscription ratio (1-minute load average ÷ cores) above which the
 * machine is called contended. CHOSEN, not derived: every ratio from about
 * 1.2 to 15 classifies the #2319 measurements identically (idle runs at ~1,
 * the timed-out runs at 17–34), so 1.5 sits comfortably above "every core
 * busy" — where a full frontend run alone lands on this pool size — and
 * comfortably below anything that has produced a timeout. On Linux (the CI
 * runner) the load average also counts threads in uninterruptible I/O wait
 * (D state), so a disk-bound neighbour raises it too; that is the right
 * direction for this diagnostic, since #2319's precedent was orphaned vitest
 * processes competing for one disk.
 */
export const CONTENDED_LOAD_RATIO = 1.5

/**
 * The most recent reading `setup.ts` handed to `describeSlowTest`, whether or
 * not it printed. Exists for `suite-timing-posture.test.ts`, which pins that
 * the hook's clock is REAL time even in a file that installed fake timers —
 * `@sinonjs/fake-timers` freezes `performance.now()` at install, and the hook
 * survives that only because setup-file hooks run outermost, after a file's
 * own `vi.useRealTimers()` cleanup. That ordering is a Vitest property nothing
 * else in this repo asserts, so it is asserted there.
 */
export const lastSlowTestReading: { current: SlowTestReading | null } = { current: null }

export interface SlowTestReading {
  /** `file > describe > test`, as the reporter would print it. */
  name: string
  durationMs: number
  /** The per-test budget the test ran under (`task.timeout`, or the default). */
  timeoutMs: number
  /** `true` when the test's recorded errors include vitest's timeout error. */
  timedOut: boolean
  /** `os.loadavg()[0]` at the moment the test finished. */
  loadAverage1m: number
  /** `os.availableParallelism()`. */
  cores: number
}

/**
 * The diagnostic line for a reading, or `null` when nothing is worth saying —
 * a passing test under the threshold. Always says something for a timed-out
 * test, however short its measured duration, because the timeout itself is
 * the event being explained.
 */
export function describeSlowTest(reading: SlowTestReading): string | null {
  const { name, durationMs, timeoutMs, timedOut, loadAverage1m, cores } = reading
  if (!timedOut && durationMs < SLOW_TEST_DIAGNOSTIC_MS) return null

  const ratio = cores > 0 ? loadAverage1m / cores : Number.POSITIVE_INFINITY
  const contended = ratio > CONTENDED_LOAD_RATIO
  const load = `1-minute load average ${loadAverage1m.toFixed(1)} on ${cores} cores (${ratio.toFixed(1)}x)`

  const what = timedOut
    ? `timed out against its ${timeoutMs} ms budget after ${Math.round(durationMs)} ms`
    : `took ${Math.round(durationMs)} ms (diagnostic threshold ${SLOW_TEST_DIAGNOSTIC_MS} ms, budget ${timeoutMs} ms)`

  const verdict = contended
    ? `The machine was CPU-contended: ${load}. A frontend test's cost scales with that — the first render in an isolated file is 250–450 ms idle — so this duration reports on the machine, not on the code. Re-run the file alone before reading it as a defect.`
    : `The machine was NOT contended: ${load}. Treat the duration as the test's own.`

  return `[#2319 slow-test] ${name} ${what}. ${verdict} See docs/contributing/ship-playbooks/frontend.md § 4, the #2319 paragraph.`
}
