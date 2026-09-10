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
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>()
  const { HavenClient } = await import('@haven_ai/sdk')
  const handlers = actual.createToolHandlers(
    new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' }),
  ) as Record<string, unknown>
  delete handlers.haven_pay
  return { ...actual, createToolHandlers: () => handlers }
})

/**
 * The imports are hoisted into `beforeAll` because they, not the assertion,
 * are what this test spends its time on (#2842).
 *
 * Measured: `import('./server.js')` takes **3423ms** and the SDK import 1ms,
 * of a 3442ms test — 99.4% of the budget in one import. It is not doing
 * anything slow on purpose; the `vi.mock` factory above has to `importOriginal`
 * and build the entire handler map before `server.js` can be evaluated, and
 * every capability slice #2806 adds makes that graph bigger.
 *
 * Paid inside the `it`, that cost ran against vitest's 5000ms default
 * `testTimeout`, so a 3.4s test had ~1.5s of headroom on an idle machine and
 * none on a busy one: it failed **3 of 5** full-suite runs on clean `dev` and
 * passed every time it ran alone. The failure surfaced as the registry guard
 * "not throwing", which reads like the completeness check regressing on a
 * money-path package rather than like a timer.
 *
 * A hook is the right home rather than a bigger number: the work happens once
 * either way, and moving it out of the test's timer both removes it from the
 * thing being measured and puts it under the hook budget, which is larger.
 * Verified rather than assumed — a deliberate 6s `beforeAll` passes here,
 * which a 5000ms budget would not.
 *
 * The sibling `tools-registry.test.ts` was checked and does NOT share this:
 * 10 tests in 17ms, because it exercises the detection logic directly and
 * never imports `server.js`.
 */
let buildHostedMcpServer: (typeof import('./server.js'))['buildHostedMcpServer']
let HavenClient: (typeof import('@haven_ai/sdk'))['HavenClient']

beforeAll(async () => {
  ;({ buildHostedMcpServer } = await import('./server.js'))
  ;({ HavenClient } = await import('@haven_ai/sdk'))
})

describe('buildHostedMcpServer refuses to boot an incomplete registry (#2807)', () => {
  it('throws, naming the handler-less tool, before any registration', () => {
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    expect(() => buildHostedMcpServer(haven)).toThrow(
      /Hosted MCP tool registry is incomplete:[\s\S]*haven_pay[\s\S]*missing-handler/,
    )
  })
})
