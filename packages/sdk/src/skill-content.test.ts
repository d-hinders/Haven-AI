import { describe, expect, it } from 'vitest'
import { HAVEN_SKILL_MD, SKILL_FOLDER_NAME } from './skill-content.js'

describe('generic skill content', () => {
  it('contains no secrets and no per-agent values', () => {
    expect(HAVEN_SKILL_MD).not.toMatch(/0x[0-9a-fA-F]{40}/)
    expect(HAVEN_SKILL_MD).not.toMatch(/sk_agent_/)
    expect(HAVEN_SKILL_MD).not.toMatch(/delegate_key|private_key|HAVEN_API_KEY/)
    expect(HAVEN_SKILL_MD).not.toMatch(/\$\{/)
  })

  it('directs the agent to runtime tools for identity, budget, and payment', () => {
    expect(HAVEN_SKILL_MD).toContain('haven_get_agent')
    expect(HAVEN_SKILL_MD).toContain('haven_get_allowances')
    expect(HAVEN_SKILL_MD).toContain('haven_pay')
    expect(HAVEN_SKILL_MD).toContain('haven_quote_x402')
    expect(HAVEN_SKILL_MD).toContain('haven_pay_x402_quote')
    expect(HAVEN_SKILL_MD).toContain('haven_get_payment_status')
    expect(HAVEN_SKILL_MD).toContain('retry_original_x402_request')
    expect(HAVEN_SKILL_MD).toContain('mcp_transport')
    expect(HAVEN_SKILL_MD).toContain('expires_at')
    expect(HAVEN_SKILL_MD).toContain('PAYMENT_WINDOW_EXPIRED')
    expect(HAVEN_SKILL_MD).toContain('MERCHANT_REJECTED_AFTER_FUNDING')
    expect(HAVEN_SKILL_MD).toContain('PRICE_EXCEEDS_MAX')
    expect(HAVEN_SKILL_MD).toContain('local Haven signer')
    expect(HAVEN_SKILL_MD).not.toContain('Haven signs')
  })

  it('has valid skill frontmatter and the expected folder name', () => {
    expect(HAVEN_SKILL_MD.startsWith('---\nname: haven-pay\n')).toBe(true)
    expect(SKILL_FOLDER_NAME).toBe('haven-pay')
  })
})
