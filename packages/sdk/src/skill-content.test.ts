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
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_pay_mcp_tool')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven-signer__haven_sign_x402')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_settle_mcp_tool')
    expect(HAVEN_SKILL_MD).toContain('x402_expected')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven-signer__haven_sign')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_submit')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven-signer__haven_x402_sign_header')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_complete_mcp_tool')
    expect(HAVEN_SKILL_MD).toContain('PAYMENT_WINDOW_EXPIRED')
    expect(HAVEN_SKILL_MD).toContain('MERCHANT_REJECTED_AFTER_FUNDING')
    expect(HAVEN_SKILL_MD).toContain('PRICE_EXCEEDS_MAX')
    expect(HAVEN_SKILL_MD).toContain('local Haven signer')
    expect(HAVEN_SKILL_MD).not.toContain('Haven signs')
  })

  it('points the agent at the non-secret agent.json for fast first-turn orientation', () => {
    expect(HAVEN_SKILL_MD).toContain('agent.json')
    // The orientation note must steer the agent to the live tool before paying,
    // since the file only carries the configured (not remaining) budget.
    expect(HAVEN_SKILL_MD).toContain('live remaining')
  })

  it('names haven_get_agent as the one-shot bootstrap with a readiness signal', () => {
    expect(HAVEN_SKILL_MD).toContain('recommended first call')
    expect(HAVEN_SKILL_MD).toContain('needs_approval')
  })

  it('has valid skill frontmatter and the expected folder name', () => {
    expect(HAVEN_SKILL_MD.startsWith('---\nname: haven-pay\n')).toBe(true)
    expect(SKILL_FOLDER_NAME).toBe('haven-pay')
  })

  it('names the guided catalog-purchase flow as the primary MCP-merchant path (#1306)', () => {
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_discover_tools')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_prepare_catalog_purchase')
    expect(HAVEN_SKILL_MD).toContain('catalog_id')
    // max_amount is REQUIRED on this tool, unlike the manual-fallback tools.
    expect(HAVEN_SKILL_MD).toContain('max_amount')
    expect(HAVEN_SKILL_MD).toMatch(/max_amount.*REQUIRED/)
  })

  it('tells the agent to follow the response guidance fields first (#1308)', () => {
    expect(HAVEN_SKILL_MD).toContain('next_action')
    expect(HAVEN_SKILL_MD).toContain('next_tool')
    expect(HAVEN_SKILL_MD).toContain('next_arguments')
    expect(HAVEN_SKILL_MD).toMatch(/follow those fields first/i)
    expect(HAVEN_SKILL_MD).toContain('safe_to_continue')
  })

  it('signs and settles by payment_id only, never a bare merchant_url/tool_name pass', () => {
    // Signing: payment_id + payment_required only; typed_data is never relayed
    // by the agent on the preferred path.
    expect(HAVEN_SKILL_MD).toMatch(/payment_id[\s\S]*?payment_required[\s\S]*?ONLY/)
    expect(HAVEN_SKILL_MD).toContain('never relay')
    // Settling: payment_id + signature + payment_header only; merchant_url /
    // tool_name are the explicit version-skew fallback, both or none.
    expect(HAVEN_SKILL_MD).toMatch(/payment_id[\s\S]*?signature[\s\S]*?payment_header[\s\S]*?ONLY/)
    expect(HAVEN_SKILL_MD).toMatch(/both or\s+none/)
  })

  it('distinguishes stop-and-sweep from verify-then-sweep (#1300 mutation guard)', () => {
    expect(HAVEN_SKILL_MD).toContain('MERCHANT_UNRESPONSIVE_AFTER_FUNDING')
    expect(HAVEN_SKILL_MD).toContain('Stop-and-sweep')
    expect(HAVEN_SKILL_MD).toContain('Verify-then-sweep')
    expect(HAVEN_SKILL_MD).toContain('NOT proof of rejection')
    expect(HAVEN_SKILL_MD).toContain('ONCE')
    expect(HAVEN_SKILL_MD).toMatch(/only sweep|sweep only/i)
  })

  it('reports post-purchase results from agent_summary and remaining allowance, no extra calls (#1310)', () => {
    expect(HAVEN_SKILL_MD).toContain('agent_summary')
    expect(HAVEN_SKILL_MD).toMatch(/remaining post-purchase allowance/)
    expect(HAVEN_SKILL_MD).toMatch(/Do not\s+call[\s\S]*?again just to report/)
  })
})
