import { describe, it, expect } from 'vitest'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_abc123',
    name: 'Research Agent',
    description: 'Pays for x402 APIs',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    safeName: 'Treasury Safe',
    chainId: 100,
  },
  policy: {
    allowances: [
      { tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 10080 },
      { tokenSymbol: 'EURe', amount: '10', resetPeriodMin: 1440 },
    ],
  },
  credentials: {
    apiKey: 'sk_agent_TESTKEY_NEVERREAL',
    delegatePrivateKey: '0xPRIVATEKEY_NEVERREAL',
  },
  apiBaseUrl: 'https://havenbackend.example',
  appBaseUrl: 'https://app.haven.example',
}

describe('buildAgentCredential', () => {
  it('produces JSON shaped like the @haven_ai/mcp credential loader expects', () => {
    const { json, jsonText, filename } = buildAgentCredential(BASE_INPUT)

    expect(json.api_key).toBe('sk_agent_TESTKEY_NEVERREAL')
    expect(json.delegate_key).toBe('0xPRIVATEKEY_NEVERREAL')
    expect(json.agent_id).toBe('agt_abc123')
    expect(json.safe_address).toBe('0xbf35beb0f587db2527b64e58d61f78bbf840860f')
    expect(json.api_url).toBe('https://havenbackend.example')

    // jsonText must round-trip and use snake_case keys (the MCP loader prefers
    // these — camelCase is accepted but snake_case is the documented shape).
    const reparsed = JSON.parse(jsonText)
    expect(reparsed.api_key).toBe(json.api_key)
    expect(reparsed.delegate_key).toBe(json.delegate_key)
    expect(reparsed.delegate_address).toBe(json.delegate_address)

    // Filename uses the slug, no spaces, no secrets in the name.
    expect(filename).toBe('haven-agent-research-agent.json')
    expect(filename).not.toContain('TESTKEY')
  })

  it('captures the allowance snapshot for later display', () => {
    const { json } = buildAgentCredential(BASE_INPUT)
    expect(json.budget_summary).toEqual([
      { token: 'USDC', amount: '25', reset_period_min: 10080 },
      { token: 'EURe', amount: '10', reset_period_min: 1440 },
    ])
  })

  it('includes schema, version, and non-custodial guidance notes', () => {
    const { json } = buildAgentCredential(BASE_INPUT)
    // Ownership-neutral URN, not a haven.ai URL (we don't own that domain — #594).
    expect(json.$schema).toBe('urn:haven:schema:agent-credential:v1')
    expect(json.$schema).not.toMatch(/haven\.ai/i)
    expect(json.version).toBe(1)
    expect(json.type).toBe('haven.agent_credential')
    // Notes exist so a future reader of the JSON understands the trust model.
    expect(json.notes.custody).toMatch(/non-custodial/i)
    expect(json.notes.budget_summary).toMatch(/snapshot/i)
    expect(json.notes.refresh).toMatch(/budget/i)
  })

  /**
   * #2106: this file leaves the browser and lands in `~/.haven/*.json`, so a
   * rail-blind claim in it outlives the session that wrote it. The note named
   * the Safe AllowanceModule to every agent on every rail — a primitive that
   * is RETIRED (#1440) and was never the authority on the delegation rail,
   * where a signed budget delegation's caveat enforcers are.
   *
   * The assertion is a name BAN plus the rail-independent claim, rather than a
   * match on delegation wording: this note is written once for both rails, so
   * pinning it to the other rail's vocabulary would be the same defect
   * mirrored.
   */
  it('names no retired rail primitive in the budget note (#2106)', () => {
    const { json, jsonText } = buildAgentCredential(BASE_INPUT)
    expect(json.notes.budget_summary).not.toMatch(/allowancemodule/i)
    expect(json.notes.budget_summary).not.toMatch(/\bSafe\b/)
    expect(json.notes.refresh).not.toMatch(/allowancemodule/i)
    // Whatever the rail, the on-chain policy is the gate and this file is not.
    expect(json.notes.budget_summary).toMatch(/on-chain policy is the authoritative gate/i)
    // The written artefact, not just the object the UI holds.
    expect(jsonText).not.toMatch(/AllowanceModule/i)
  })

  it('uses the app base URL to build the revoke link', () => {
    const { json } = buildAgentCredential(BASE_INPUT)
    expect(json.revoke_url).toBe('https://app.haven.example/agents')
  })

  it('refuses to build a credential without a delegate private key', () => {
    const input: HandoffInput = {
      ...BASE_INPUT,
      credentials: { apiKey: 'sk_x', delegatePrivateKey: null },
    }
    expect(() => buildAgentCredential(input)).toThrow(/delegate private key/i)
  })
})
