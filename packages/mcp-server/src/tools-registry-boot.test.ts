/**
 * #2807 — the registry completeness guard is WIRED INTO SERVER BOOT.
 *
 * The detection logic has its own twin tests (`tools-registry.test.ts`). This
 * file proves the other half: `buildHostedMcpServer` actually CALLS
 * `assertHostedToolRegistry` before registering anything, so an incomplete
 * registry cannot boot. The handler map is broken via `vi.mock` (handlers
 * minus `haven_pay`) — which also keeps this file independent of the real
 * handler map, so the completeness twin above stays the instrument that goes
 * red on source mutations, not this wiring test.
 *
 * ## The imports are STATIC, and that is the fix for #2842
 *
 * They used to be `await import(...)` inside the `it`. Importing `server.js`
 * costs ~1.0-1.1s on an idle machine and 5-10s inside a loaded full suite, and
 * paying that inside the test body ran it against vitest's 5000ms default
 * `testTimeout` — so the test failed intermittently under a full suite and
 * passed every time it ran alone. It surfaced as the registry guard "not
 * throwing", which reads like the #2807 check regressing on a money-path
 * package rather than like a timer.
 *
 * The cost is NOT the `vi.mock` factory below, which is what a first
 * explanation of this claimed. Measured on paired idle runs: importing
 * `server.js` from a file with no `vi.mock` at all takes 1057/1048/1131ms
 * against 1066/1066/1295ms mocked — the factory adds no material share. It is
 * the plain transform and load of the SDK + server module graph, exactly as
 * `connector-channel.test.ts` already records. That graph grows with every
 * capability slice epic #2806 carves out, so the margin shrinks on its own.
 *
 * A static import moves the cost into vitest's COLLECT phase, which carries no
 * per-test and no per-hook budget — `testTimeout`/`hookTimeout` are attached to
 * task objects at collection and enforced only while running. That is why it is
 * immune rather than merely roomier: hoisting into `beforeAll` — the first fix
 * tried here — only traded the 5s test budget for the 10s hook budget.
 *
 * Durations rather than a pass/fail count, because the count is a draw and the
 * durations are not. Full suite, 28 spinning background processes, this file's
 * reported time:
 *
 *   original     7521ms, 5195ms   — both OVER the 5000ms test budget
 *   beforeAll    8722ms, 9796ms   — 87% and 98% of the 10000ms hook budget
 *   static         22ms,   96ms   — no budget applies
 *
 * A second measurement on another machine got 7584/8991/8009ms for `beforeAll`
 * against 16/149/207ms static, and saw no red in three runs where an earlier
 * run here did. That disagreement is the point: at 98% of budget whether it
 * goes red is a coin flip, so the durations are the claim and the count is not.
 *
 * Running the single FILE under load does not separate `beforeAll` from static
 * — both stay inside their (different) budgets. It does NOT follow that the
 * defect needs a full suite: the original form reproduces on the single file
 * too, at 5864ms against its 5000ms budget. The full suite is what separates
 * the two candidate FIXES, not what creates the bug.
 *
 * `vi.mock` is hoisted above every import in the file, static ones included, so
 * the mocked `./tools.js` is what `server.js` sees either way — verified by
 * moving these imports above the `vi.mock` call, which is also green, so a
 * formatter or an import-sorting tool cannot break this. `server.test.ts`
 * already imports `server.js` this way.
 *
 * One signal shape did change, and it is worth knowing in a file that exists
 * because a misleading signal cost time: if these imports ever fail to resolve,
 * the FILE fails and the test leaves the count entirely (`471 passed`, no line
 * naming it) rather than being reported as a failing test. CI is still red —
 * the run exits 1 — but the trail is shorter than a named assertion. The
 * `beforeAll` form reported that case as "skipped"; the static form does not
 * report it at all.
 *
 * Siblings checked: `tools-registry.test.ts` never imports `server.js` and does
 * not share this. `connector-channel.test.ts` DOES, and solves it with an
 * explicit 30s timeout instead — correct there and deliberately not copied
 * here, because it calls `vi.resetModules()` and re-imports per test by design,
 * so it has nothing to hoist and nothing to make static.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>()
  const { HavenClient } = await import('@haven_ai/sdk')
  const handlers = actual.createToolHandlers(
    new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' }),
  ) as Record<string, unknown>
  delete handlers.haven_pay
  return { ...actual, createToolHandlers: () => handlers }
})

import { buildHostedMcpServer } from './server.js'
import { HavenClient } from '@haven_ai/sdk'

describe('buildHostedMcpServer refuses to boot an incomplete registry (#2807)', () => {
  it('throws, naming the handler-less tool, before any registration', () => {
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    expect(() => buildHostedMcpServer(haven)).toThrow(
      /Hosted MCP tool registry is incomplete:[\s\S]*haven_pay[\s\S]*missing-handler/,
    )
  })
})
