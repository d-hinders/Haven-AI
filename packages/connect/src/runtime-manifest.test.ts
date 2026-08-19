import { describe, expect, it } from 'vitest'
import { registeredToolNames } from '@haven_ai/mcp'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'

describe('MCP_RUNTIME_MANIFEST.requiredTools', () => {
  // Drift guard: the connect CLI's required-tools list MUST be exactly the
  // tools the local MCP actually exposes. An earlier hand-maintained list
  // drifted (advertised tools the local MCP no longer exposed, missed
  // `haven_pay_x402` when it landed), which made the consent screen and the
  // post-setup probe lie to users. This test would have caught the original
  // mismatch and will catch the next one.
  it('matches the canonical registered tool names from @haven_ai/mcp', () => {
    const canon = registeredToolNames()
    expect(MCP_RUNTIME_MANIFEST.requiredTools).toEqual(canon)
  })

  it('is non-empty (catches a degenerate empty-array drift)', () => {
    // A vacuous equality check would silently pass if both sides returned []
    // due to a module-load order bug. Assert the list is real before trusting
    // the equality above.
    expect(MCP_RUNTIME_MANIFEST.requiredTools.length).toBeGreaterThan(5)
  })

  it('contains haven_pay_x402 — the one-shot tool the manifest must advertise', () => {
    // Explicit anchor: this is the tool that the connect CLI previously failed
    // to advertise on day one, sending an agent into a ToolSearch detour. If
    // the canon ever loses this tool, fail loudly here rather than only at the
    // equality check (which would also fail but with a less obvious diff).
    expect(MCP_RUNTIME_MANIFEST.requiredTools).toContain('haven_pay_x402')
  })
})

describe('MCP_RUNTIME_MANIFEST.requiredSignerTools (#1587)', () => {
  it('is DERIVED from @haven_ai/signer, not a literal that can rot', async () => {
    const { toolSchemas } = await import('@haven_ai/signer')
    expect([...MCP_RUNTIME_MANIFEST.requiredSignerTools].sort()).toEqual(Object.keys(toolSchemas).sort())
  })

  it('is non-empty and anchors the signing tools the payment flow depends on', () => {
    expect(MCP_RUNTIME_MANIFEST.requiredSignerTools.length).toBeGreaterThan(0)
    expect(MCP_RUNTIME_MANIFEST.requiredSignerTools).toContain('haven_sign_x402')
    expect(MCP_RUNTIME_MANIFEST.requiredSignerTools).toContain('haven_sign')
  })
})
