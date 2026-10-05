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

  it('marks all four human-only steps (matching for-agents.md) and tells the agent to stop and ask', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toMatch(/Four steps are HUMAN-only/)
    expect(body).toMatch(/Signup/)
    expect(body).toMatch(/Funding/)
    // The step the earlier draft omitted (F7): creating the agent and setting
    // its budget is a human action too, same as for-agents.md's own step 3.
    expect(body).toMatch(/[Cc]reating you as an agent and setting your budget/)
    expect(body).toMatch(/Budget approval/)
    expect(body).toMatch(/Stop and ask your user/)
  })

  it('carries the signup link with no ?src=demo tracking param (owner decision)', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('/signup?next=/agents&via=agent')
    expect(body).not.toContain('src=demo')
  })

  it('names the step-7 refusal signal accurately, and the recipient, and states the budget cap up front', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    // The real signal `haven_send` → `POST /payments` returns: an on-chain
    // policy error, not the `delegation_budget_exceeded` refusal-ledger code
    // (that is written server-side, never returned to the caller here).
    expect(body).toContain('transfer-amount-exceeded')
    expect(body).not.toContain('delegation_budget_exceeded')
    // \s+ rather than a literal space: this text wraps across lines in the
    // template literal, and the phrase must still be findable regardless of
    // exactly where the wrap falls.
    expect(body).toMatch(/not a\s+balance/i)
    expect(body).toContain('0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C')
    expect(body).toMatch(/test USDC|TEST money|test network/i)
  })

  it('describes the refusal message shape the hosted MCP actually returns (review round 2, n1/n2)', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    // #3503/#3504: the over-budget direct send is the typed
    // DELEGATION_BUDGET_EXCEEDED, whose hosted step says retrying cannot
    // succeed; #3609: its fallback (a budget read that failed) is the typed
    // PREPARE_REVERTED naming the enforcer — also a stop. The doc must name
    // both codes and never send the agent into a retry.
    expect(body).toContain('DELEGATION_BUDGET_EXCEEDED')
    expect(body).toContain('PREPARE_REVERTED')
    expect(body).not.toMatch(/its\s+`details`\s+carry/i)
    expect(body).toContain('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')
    expect(body).toMatch(/retrying\s+cannot\s+succeed/i)
    expect(body).toMatch(/never\s+a\s+retry/i)
  })

  it('links back to /demo', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('(/demo)')
  })

  it("names the faucet in the funding link's own text, not the chain (L4)", async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('[Circle\'s faucet](https://faucet.circle.com)')
    expect(body).not.toContain('[Base Sepolia](https://faucet.circle.com)')
  })

  it('describes the #3478 Add funds modal faucet card, not "no faucet link"', async () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const body = await GET().text()
    expect(body).toContain('Get test funds')
    expect(body).toMatch(/Open\s+Circle's faucet/)
    expect(body).not.toContain('no faucet link')
    expect(body).not.toMatch(/Buy with card/)
  })
})
