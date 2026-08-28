/**
 * The READINESS half of the capture harness (#2108).
 *
 * The defect these tests exist to keep fixed: `waitForServer` carried a single
 * hardcoded 90s budget against a cold `next dev` compile measured at
 * 315–448s under agent load, so on a contended cold worktree the harness
 * could not capture at all — and the message it printed named neither the
 * cause nor the remedy, so it looked exactly like the failures that ARE signal
 * (contention, a genuinely broken page, a `still-loading` floor refusal
 * (#2036)). A tool that fails for a reason unrelated to what it is measuring
 * teaches its users to discount its failures, which is the wrong lesson.
 *
 * Every assertion here is written so it can go RED. The two that would
 * otherwise be unfalsifiable — "the default is big enough" and "the floor
 * warns" — carry an explicit control that feeds the predicate a value it must
 * REJECT. A check that can only say yes is what this whole family of issues
 * has been about.
 */
import { describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the capture harness
import {
  COLD_COMPILE_RANGE_S,
  READINESS_DEFAULTS,
  describeReadinessFailure,
  formatRunResult,
  readinessBudgetProblems,
  resolveReadinessBudgets,
  waitForServer,
} from '../../scripts/screenshot.mjs'

describe('readiness budgets', () => {
  it('defaults the compile budget ABOVE the measured cold-start range', () => {
    // The load-bearing number. 90_000 was ~3.5–5x below this range, which is
    // why a cold worktree could never capture.
    expect(READINESS_DEFAULTS.readyTimeoutMs).toBeGreaterThan(COLD_COMPILE_RANGE_S.max * 1000)
    // …and with real headroom, not by a second. A budget that only just clears
    // the measured maximum fails on the first machine slower than the one it
    // was measured on.
    expect(READINESS_DEFAULTS.readyTimeoutMs).toBeGreaterThanOrEqual(COLD_COMPILE_RANGE_S.max * 1000 * 2)
  })

  it('keeps the LISTEN budget well below it, so a server that never comes up fails fast', () => {
    // The whole reason a ~16-minute compile budget is affordable. If these two
    // collapse into one number, a dead dev server takes the cold-start budget
    // to report — which is the "just raise the constant" answer this design
    // rejects.
    expect(READINESS_DEFAULTS.listenTimeoutMs).toBeLessThan(COLD_COMPILE_RANGE_S.min * 1000)
    expect(READINESS_DEFAULTS.listenTimeoutMs).toBeLessThan(READINESS_DEFAULTS.readyTimeoutMs)
  })

  it('the floor can say NO — the old 90s constant is rejected by it', () => {
    // POSITIVE CONTROL for the assertion above. Without this, "the shipped
    // default passes the floor" is satisfiable by a floor that passes
    // everything, and the test would be decoration.
    const problems = readinessBudgetProblems({ readyTimeoutMs: 90_000, listenTimeoutMs: 90_000 })
    expect(problems.join('\n')).toMatch(/below the MEASURED cold/)
    expect(problems.join('\n')).toMatch(/not shorter than readyTimeoutMs/)
    // And it says YES for the shipped defaults.
    expect(readinessBudgetProblems(READINESS_DEFAULTS)).toEqual([])
  })

  it('reads overrides from the environment and refuses a malformed one', () => {
    // `resolveReadinessBudgets` defaults its parameter to `process.env`, so TS
    // infers the full `ProcessEnv`; these fixtures are deliberately partial.
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
    expect(resolveReadinessBudgets(env({ SCREENSHOT_READY_TIMEOUT_MS: '1234' })).readyTimeoutMs).toBe(1234)
    expect(resolveReadinessBudgets(env({ SCREENSHOT_LISTEN_TIMEOUT_MS: '77' })).listenTimeoutMs).toBe(77)
    expect(resolveReadinessBudgets(env({})).readyTimeoutMs).toBe(READINESS_DEFAULTS.readyTimeoutMs)
    // A silently-ignored override reproduces the original bug with the reader
    // certain they had raised the budget.
    expect(() => resolveReadinessBudgets(env({ SCREENSHOT_READY_TIMEOUT_MS: '6OO000' }))).toThrow(
      /positive whole number/,
    )
    expect(() => resolveReadinessBudgets(env({ SCREENSHOT_READY_TIMEOUT_MS: '-5' }))).toThrow()
  })
})

describe('readiness failure messages', () => {
  const ctx = { url: 'http://127.0.0.1:3161', port: '3161', budgetMs: 985_600, elapsedS: 3, exitCode: 1 }

  it('names a dead process as a dead process, not as a timeout', () => {
    const msg = describeReadinessFailure('process-exited', ctx)
    expect(msg).toMatch(/PROCESS EXITED/)
    expect(msg, 'must deny the reading that sent three sessions the wrong way').toMatch(/NOT a timeout/)
    expect(msg, 'must name a remedy, not just a symptom').toMatch(/npm run build -w packages\/core|npm install/)
  })

  it('distinguishes "never bound a port" from "slow compile"', () => {
    const msg = describeReadinessFailure('never-listened', ctx)
    expect(msg).toMatch(/startup failure, not a slow\s+compile/)
    expect(msg).toMatch(/SCREENSHOT_LISTEN_TIMEOUT_MS/)
  })

  it('the compile timeout names the measured range and the pre-warm escape', () => {
    const msg = describeReadinessFailure('not-answering', ctx)
    expect(msg).toMatch(new RegExp(`${COLD_COMPILE_RANGE_S.min}–${COLD_COMPILE_RANGE_S.max}s`))
    expect(msg).toMatch(/SCREENSHOT_READY_TIMEOUT_MS/)
    expect(msg, 'the documented workaround must be IN the message, not only in a playbook').toMatch(
      /SCREENSHOT_BASE_URL=http:\/\/127\.0\.0\.1:3161/,
    )
    expect(msg, 'and it must say the evidence is still provably this worktree').toMatch(/#1800 identity check/)
  })

  it('the four causes do not print the same sentence', () => {
    const kinds = ['process-exited', 'never-listened', 'stopped-listening', 'not-answering']
    const msgs = kinds.map((k) => describeReadinessFailure(k, ctx))
    expect(new Set(msgs).size, 'collapsing two causes into one message is how this got misdiagnosed').toBe(4)
  })
})

describe('waitForServer', () => {
  const clock = () => {
    let t = 0
    return { now: () => t, sleepFn: async (ms: number) => void (t += ms) }
  }

  it('returns as soon as a listening server answers', async () => {
    const { now, sleepFn } = clock()
    const log = vi.fn()
    await expect(
      waitForServer('http://127.0.0.1:3161', {
        budgets: READINESS_DEFAULTS,
        probeListening: async () => true,
        probeAnswering: async () => 200,
        now,
        sleepFn,
        log,
      }),
    ).resolves.toBeUndefined()
    expect(log.mock.calls.flat().join('\n')).toMatch(/answered 200/)
  })

  it('waits out a long compile rather than giving up at the old 90s', async () => {
    // The regression that matters. `answerAfterMs` sits inside the measured
    // cold range and comfortably outside the constant this replaces: a harness
    // still carrying a 90s budget fails this test.
    const { now, sleepFn } = clock()
    const answerAfterMs = COLD_COMPILE_RANGE_S.min * 1000
    let elapsed = 0
    await expect(
      waitForServer('http://127.0.0.1:3161', {
        budgets: READINESS_DEFAULTS,
        probeListening: async () => true,
        probeAnswering: async () => {
          elapsed = now()
          if (elapsed < answerAfterMs) throw new Error('still compiling')
          return 200
        },
        now,
        sleepFn,
        log: () => {},
      }),
    ).resolves.toBeUndefined()
    expect(elapsed).toBeGreaterThanOrEqual(90_000)
  })

  it('reports a dead child IMMEDIATELY — not after the cold-start budget', async () => {
    // The other direction, and the reason the budget above is affordable.
    const { now, sleepFn } = clock()
    const child = { exitCode: 1, signalCode: null }
    await expect(
      waitForServer('http://127.0.0.1:3161', {
        budgets: READINESS_DEFAULTS,
        child,
        probeListening: async () => false,
        probeAnswering: async () => 200,
        now,
        sleepFn,
        log: () => {},
      }),
    ).rejects.toThrow(/PROCESS EXITED/)
    expect(now(), 'a dead server must not consume the cold-compile budget').toBeLessThan(
      READINESS_DEFAULTS.listenTimeoutMs,
    )
  })

  it('a server that never binds fails on the SHORT budget', async () => {
    const { now, sleepFn } = clock()
    await expect(
      waitForServer('http://127.0.0.1:3161', {
        budgets: READINESS_DEFAULTS,
        probeListening: async () => false,
        probeAnswering: async () => 200,
        now,
        sleepFn,
        log: () => {},
      }),
    ).rejects.toThrow(/never opened a socket/)
    expect(now()).toBeLessThan(COLD_COMPILE_RANGE_S.min * 1000)
  })

  it('a server that dies mid-compile is reported as that, not as a slow compile', async () => {
    const { now, sleepFn } = clock()
    let listening = true
    await expect(
      waitForServer('http://127.0.0.1:3161', {
        budgets: READINESS_DEFAULTS,
        probeListening: async () => listening,
        probeAnswering: async () => {
          listening = false
          throw new Error('socket hang up')
        },
        now,
        sleepFn,
        log: () => {},
      }),
    ).rejects.toThrow(/STOPPED listening/)
  })

  it('emits progress during a long wait, so it is visibly a wait and not a hang', async () => {
    const { now, sleepFn } = clock()
    const log = vi.fn()
    let answered = false
    await waitForServer('http://127.0.0.1:3161', {
      budgets: READINESS_DEFAULTS,
      probeListening: async () => true,
      probeAnswering: async () => {
        if (now() < 120_000) throw new Error('still compiling')
        answered = true
        return 200
      },
      now,
      sleepFn,
      log,
    })
    expect(answered).toBe(true)
    const progress = log.mock.calls.flat().filter((l) => /still compiling/.test(String(l)))
    expect(progress.length, 'silence for two minutes is indistinguishable from a hang').toBeGreaterThan(3)
    expect(String(progress[0])).toMatch(/not a hang/)
  })
})

describe('the pipe-proof result line', () => {
  it('states BOTH colours in stdout, because an exit code does not survive `| tail`', () => {
    expect(formatRunResult(true, '4 PNG(s) in .screenshots')).toMatch(/^screenshot: RESULT ok —/)
    // POSITIVE CONTROL: a formatter that can only say "ok" would restate the
    // false green this line exists to remove.
    expect(formatRunResult(false, 'dev server PROCESS EXITED')).toMatch(/^screenshot: RESULT FAILED —/)
    expect(formatRunResult(false, 'x')).not.toMatch(/RESULT ok/)
  })
})
