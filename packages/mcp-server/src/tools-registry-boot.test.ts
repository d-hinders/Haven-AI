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
 * costs ~1.2-3.4s depending on machine load, and paying that inside the test
 * body ran it against vitest's 5000ms default `testTimeout` — so the test
 * failed intermittently under a full suite (4 red of 11 runs on clean `dev`)
 * and passed every time it ran alone. It surfaced as the registry guard "not
 * throwing", which reads like the #2807 check regressing on a money-path
 * package rather than like a timer.
 *
 * The cost is NOT the `vi.mock` factory below, which is what a first
 * explanation of this claimed. Measured: importing `server.js` from a file
 * with no `vi.mock` at all takes 2479ms, against 2500ms-ish mocked —
 * indistinguishable. It is the plain transform and load of the SDK + server
 * module graph, exactly as `connector-channel.test.ts` already records. That
 * graph grows with every capability slice epic #2806 carves out, so the
 * margin shrinks on its own.
 *
 * A static import moves the cost into vitest's COLLECT phase, which carries
 * no per-test and no per-hook budget. That is why it is immune rather than
 * merely roomier: hoisting into `beforeAll` — the first fix here — only
 * traded the 5s test budget for the 10s hook budget.
 *
 * Measured, both variants in the same full-suite runs against 28 spinning
 * background processes:
 *
 *   beforeAll      1 of 2 runs RED — `Hook timed out in 10000ms`, and the
 *                  test reports as SKIPPED inside a failed suite, which is a
 *                  harder trail than the `Test timed out in 5000ms` at the
 *                  `it` that it replaced
 *   static import  2 of 2 GREEN, 472/472
 *
 * Running the single FILE under the same load does not reproduce it — both
 * variants pass — because one file transforms its graph with no competition
 * from the other nineteen. The full suite is the experiment.
 *
 * `vi.mock` is hoisted above every import in the file, static ones included,
 * so the mocked `./tools.js` is what `server.js` sees either way.
 * `server.test.ts` already imports `server.js` this way.
 *
 * Siblings checked: `tools-registry.test.ts` never imports `server.js` and
 * does not share this. `connector-channel.test.ts` DOES, and solves it with
 * an explicit 30s timeout instead — correct there and deliberately not copied
 * here, because it calls `vi.resetModules()` and re-imports per test by
 * design, so it has nothing to hoist and nothing to make static.
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
