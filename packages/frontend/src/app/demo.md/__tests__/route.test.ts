import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockIsDemoPageVisible } = vi.hoisted(() => ({
  mockIsDemoPageVisible: vi.fn(),
}))

vi.mock('@/lib/demo-gate', () => ({
  isDemoPageVisible: () => mockIsDemoPageVisible(),
}))

import { GET, dynamic } from '../route'

/**
 * `/demo.md` route handler (#3477) — the `discovery-routes.test.ts` pattern:
 * call the handler, not just the content builder.
 */
describe('/demo.md route handler', () => {
  beforeEach(() => {
    mockIsDemoPageVisible.mockReset()
  })

  it('is dynamic — the gate is evaluated per-request, not baked in at build time', () => {
    expect(dynamic).toBe('force-dynamic')
  })

  it('404s when the gate is closed', async () => {
    mockIsDemoPageVisible.mockReturnValue(false)
    const response = GET()
    expect(response.status).toBe(404)
  })

  it('serves text/markdown with a noindex header when the gate is open', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('x-robots-tag')).toBe('noindex')
  })

  it('links to /for-agents.md for setup instead of duplicating them', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('(/for-agents.md)')
  })

  it("states 0.05 USDC/day explicitly and says it overrides for-agents.md's 25 USDC example", async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('0.05 USDC, Daily')
    // Names the runbook's example it is overriding, so the override reads as
    // a stated decision rather than an unexplained different number.
    expect(body).toMatch(/25 USDC.*override|override.*25 USDC/is)
  })

  it('marks the human-only steps and tells the agent to stop and ask', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toMatch(/HUMAN-only/)
    expect(body).toMatch(/Signup/)
    expect(body).toMatch(/Funding/)
    expect(body).toMatch(/Budget approval/)
    expect(body).toMatch(/Stop and ask your user/)
  })

  it('carries the signup link with no ?src=demo tracking param (owner decision)', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('/signup?next=/agents&via=agent')
    expect(body).not.toContain('src=demo')
  })

  it('names the step-7 refusal reason and recipient, and states the budget cap up front', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('delegation_budget_exceeded')
    expect(body).toContain('0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C')
    expect(body).toMatch(/test USDC|TEST money|test network/i)
  })

  it('links back to /demo', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('(/demo)')
  })
})
