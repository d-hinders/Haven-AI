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

describe('buildHostedMcpServer refuses to boot an incomplete registry (#2807)', () => {
  it('throws, naming the handler-less tool, before any registration', async () => {
    const { buildHostedMcpServer } = await import('./server.js')
    const { HavenClient } = await import('@haven_ai/sdk')
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    expect(() => buildHostedMcpServer(haven)).toThrow(
      /Hosted MCP tool registry is incomplete:[\s\S]*haven_pay[\s\S]*missing-handler/,
    )
  })
})
