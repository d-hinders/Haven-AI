import { describe, expect, it } from 'vitest'
import { HAVEN_SKILL_MD, HAVEN_SKILL_BODY_MD, SKILL_FOLDER_NAME } from './skill-content.js'

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
    // #2145 gave the backend a real producer for this trigger
    // (agent-payment-status.ts emits it when the funding leg confirmed but no
    // merchant response was ever recorded). The skill must tell the agent to
    // gate on the structured field rather than claim the trigger is dead.
    expect(HAVEN_SKILL_MD).toContain("nextAction: 'retry_original_x402_request'")
    expect(HAVEN_SKILL_MD).toContain('instead of paying again')
    expect(HAVEN_SKILL_MD).toContain('mcp_transport')
    expect(HAVEN_SKILL_MD).toContain('expires_at')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_pay_mcp_tool')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_quote_mcp_tool')
    expect(HAVEN_SKILL_MD).toContain('mcp__haven__haven_quote_catalog_purchase')
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
    // A cap is REQUIRED on this tool, unlike the manual-fallback tools.
    expect(HAVEN_SKILL_MD).toMatch(/cap is REQUIRED/)
    // #1351: the skill teaches the human-unit spelling as the default, and
    // still says what the atomic one means — an agent that reads only this
    // must not write max_amount "1" meaning one dollar.
    expect(HAVEN_SKILL_MD).toContain('max_amount_human')
    expect(HAVEN_SKILL_MD).toMatch(/max_amount_human.*"1".*1 USDC/s)
    expect(HAVEN_SKILL_MD).toMatch(/0\.000001 USDC/)
  })

  it('teaches read-only MCP quotes before an explicit capped purchase (#1397)', () => {
    expect(HAVEN_SKILL_MD).toMatch(/haven_quote_catalog_purchase[\s\S]*?informational only/i)
    expect(HAVEN_SKILL_MD).toMatch(/haven_quote_mcp_tool[\s\S]*?fresh quote/i)
    expect(HAVEN_SKILL_MD).toMatch(/never reserves a price/i)
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
    expect(HAVEN_SKILL_MD).toContain('purchase_summary')
    expect(HAVEN_SKILL_MD).toMatch(/result[\s\S]*never use[\s\S]*whether[\s\S]*paid/i)
    expect(HAVEN_SKILL_MD).toMatch(/remaining post-purchase allowance/)
    expect(HAVEN_SKILL_MD).toMatch(/Do not\s+call[\s\S]*?again just to\s+report/)
  })

  // #1332: the body derivation is a regex over the canonical string; these pin
  // the invariants that make it safe, LOUDLY at the source. If a future edit
  // reformats the front matter so the strip stops matching, the first
  // assertion fails here rather than the Codex AGENTS.md write silently
  // carrying raw YAML as prose; if the front matter ever grows a block scalar
  // containing a literal `---` line, the truncated match leaks front-matter
  // fragments and the starts-with assertion fails.
  it('HAVEN_SKILL_BODY_MD is the canonical skill minus exactly the front matter (#1332)', () => {
    expect(HAVEN_SKILL_BODY_MD).not.toBe(HAVEN_SKILL_MD) // the strip DID something
    expect(HAVEN_SKILL_MD.endsWith(HAVEN_SKILL_BODY_MD)).toBe(true) // a pure prefix removal
    expect(HAVEN_SKILL_BODY_MD.startsWith('# Haven: pay from a Haven wallet')).toBe(true)
    expect(HAVEN_SKILL_BODY_MD).not.toContain('name: haven-pay')
    expect(HAVEN_SKILL_BODY_MD).not.toMatch(/^---/m) // no front-matter fragments leaked
  })
})
