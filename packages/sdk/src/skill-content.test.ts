import { describe, expect, it } from 'vitest'
import { HAVEN_SKILL_MD, HAVEN_SKILL_BODY_MD, SKILL_FOLDER_NAME } from './skill-content.js'
import {
  AGENT_APPROVAL_RELAY_JSON_SENTENCE,
  AGENT_COMMAND_MODIFICATION_SENTENCE,
  AGENT_SECRET_HYGIENE_SENTENCE,
  AGENT_WIRING_COLLISION_RELAY_SENTENCE,
} from './agent-guidance.js'

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

  it('never tells the agent to pass haven_complete_mcp_tool a `payment_required` (#2353)', () => {
    // The tool has never declared `payment_required`; since #1307 the 402 is
    // read from the stored record by payment_id. This skill told agents to
    // pass it anyway, the hosted server silently stripped it, and the call
    // succeeded — so the agent believed it had pinned the 402 it quoted.
    //
    // A blanket `not.toContain('payment_required')` is NOT available here:
    // the signer paragraph above legitimately names the field (the signer
    // fetches it, and an older backend needs it re-sent), and
    // `haven_pay_x402_quote` really does declare it. So this guards the one
    // sentence that was wrong, by the shape that made it wrong — an
    // imperative to PASS the field — rather than by the field's mere
    // presence.
    const complete = HAVEN_SKILL_MD.slice(HAVEN_SKILL_MD.indexOf('haven_complete_mcp_tool'))
    expect(complete).not.toMatch(/Pass\s+`payment_required`/)
    // And it says what to send instead, with the reason, so a future edit
    // that deletes the correction is visible rather than merely silent.
    expect(complete).toMatch(/does not take\s+`payment_required`/)
    expect(complete).toMatch(/`payment_id`\s+and the signer's\s+`payment_header`\s+ONLY/)
  })

  it('names the declared `to` field for haven_pay, not `recipient` (#2393)', () => {
    // The hosted haven_pay schema (packages/mcp-server/src/tools/contracts.ts,
    // re-exported by tools.ts) declares
    // `token`, `amount`, `to` and `idempotency_key`. `recipient` is
    // haven_send's spelling. This skill told agents to send `recipient` to
    // haven_pay, which the server refuses (`to` is required) — shipped
    // guidance mis-naming a field on a money-path tool. Same defect class as
    // #2353, pinned the same way: guard the specific shape that was wrong,
    // not the field's mere presence (the word `recipient` is still correct
    // elsewhere in the skill, e.g. the decline paragraph).
    // The corrected sentence names the declared field:
    expect(HAVEN_SKILL_MD).toMatch(/haven_pay` with\s*\n?`to`/)
    // The old wrong shape (haven_pay with recipient) is gone:
    expect(HAVEN_SKILL_MD).not.toMatch(/haven_pay` with\s*\n?recipient/)
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

/**
 * The onboarding section (#2537, D2).
 *
 * The skill triggers on "pay" and on a 402 and assumes the agent is already
 * connected. An agent asked to *set Haven up* had no guidance at all, and the
 * failure that produces is specific rather than vague: it reaches for a
 * payment tool, because those are the only tools it has. Hence the section,
 * and hence the first assertion below — the sentence that says the tools
 * cannot do this is the one doing the work.
 */
describe('onboarding and setup section (#2537)', () => {
  const section = HAVEN_SKILL_MD.slice(
    HAVEN_SKILL_MD.indexOf('## Onboarding and setup'),
    HAVEN_SKILL_MD.indexOf('## Identity and budget'),
  )

  it('exists, and is reachable — the front matter names the setup trigger too', () => {
    expect(section.length).toBeGreaterThan(500)
    // A section a runtime never loads is not guidance. The description is what
    // decides whether this skill is in context when the user says "set Haven
    // up", and it used to name only paying.
    const frontMatter = HAVEN_SKILL_MD.slice(0, HAVEN_SKILL_MD.indexOf('\n---\n', 4))
    expect(frontMatter).toMatch(/create a Haven account, create an agent, or connect one/)
  })

  it('says the payment tools cannot create authority', () => {
    expect(section).toContain('None of the tools below creates authority')
    expect(section).toMatch(/opens an account, mints a\s+credential, or approves a budget/)
  })

  it('quotes the shared rule sentences VERBATIM rather than restating them', () => {
    // The epic's rule: a sentence on more than one surface has one home. These
    // four also reach the agent through the backend setup prompt and the
    // /for-agents.md runbook. Comparing against the imported constant is what
    // makes a retyped near-copy fail — a `toContain('relay the approval')`
    // would pass on a paraphrase, which is the drift this is here to stop.
    for (const sentence of [
      AGENT_APPROVAL_RELAY_JSON_SENTENCE,
      AGENT_COMMAND_MODIFICATION_SENTENCE,
      AGENT_WIRING_COLLISION_RELAY_SENTENCE,
      AGENT_SECRET_HYGIENE_SENTENCE,
    ]) {
      expect(section).toContain(sentence)
    }
  })

  it('resolves the two referents BEFORE the sentences that need them', () => {
    // They are written in the user's voice for a prompt that has the connector
    // command printed directly above them. Neither is true here: the reader is
    // the agent, and this file prints no command. Both are named rather than
    // left to inference, the same way the runbook names the first.
    expect(section).toContain('"me" and "I" below are your user, never')
    expect(section).toMatch(/"the command above" is that connector command, not anything printed\s*\n?in this file/)
    // ORDER, not just presence — and this is the assertion, not the two above.
    // The first draft put the gloss after the bullets, so an agent reading
    // top-to-bottom met `relay ... to me` before it learned whose "me" that
    // was, on the one instruction this section calls highest-priority. Both
    // review passes found it independently. A future edit that moves the
    // paragraph back below the list fails here rather than shipping.
    expect(section.indexOf('below are your user')).toBeLessThan(
      section.indexOf(AGENT_APPROVAL_RELAY_JSON_SENTENCE),
    )
  })

  it('names only commands that exist, and describes funding as the human step', () => {
    expect(section).toContain('haven login')
    expect(section).toContain('haven agents connect')
    // `haven wallets funding` was B4/#2534 — open with no PR when this section
    // was drafted, so the section described funding as the human step it is
    // and this assertion pinned the omission, with a note to flip it when B4
    // landed. **B4 landed as PR #2589 while this branch was open**, so it is
    // flipped: the command is named, verified against `commands.ts:186` and
    // `args.ts:132` on the rebased branch rather than on the strength of the
    // merge notification.
    expect(section).toContain('haven wallets funding')
    // What did NOT change is the boundary. The command composes the message;
    // it does not move money. An agent that read "there is a funding command"
    // as "I can fund it" would be wrong in the most expensive direction, so
    // the sentence says which half is still the human's.
    expect(section).toContain('you cannot send the money')
    expect(section).toMatch(/that transfer is\s+theirs/)
    // #2591: the chain comes from the command, never from an assumption. The
    // cold run of 2026-09-06 flagged "USDC on Base" on a Base Sepolia
    // deployment as the one place a user could send real money to the wrong
    // place; this section must not reintroduce a hard-coded chain.
    expect(section).toContain('Read the chain from there rather')
    expect(section).not.toMatch(/USDC to it on Base\b/)
  })

  it('keeps the four human-only steps whole', () => {
    // Dropping one leaves the user stuck at exactly that step with an agent
    // that believes it is finished — the same failure the runbook's own
    // four-of-six assertion guards.
    expect(section).toContain("Four steps are your user's, and each one needs a human")
    for (const step of [
      'create the account',
      'fund the wallet',
      "approve every agent's budget",
      'rotate a\ncredential',
    ]) {
      expect(section).toContain(step)
    }
  })

  it('never suggests the agent supplies the account credentials', () => {
    // Standing owner constraint (2026-09-04), asserted on every surface that
    // addresses an agent about onboarding.
    expect(section).not.toMatch(/enter (?:their|the user's) password/i)
    expect(section).toContain('you never see or ask for their password')
    // Positive control: the same matcher family finds what IS there, so the
    // negative above is a fact about the text and not about the regex.
    expect(section).toMatch(/ask for their password/i)
  })

  it('describes the login session as scoped, and names what it cannot do', () => {
    // `owner_cli` is an allow-list (packages/backend/src/middleware/owner-cli.ts).
    // An agent that believes the session is its user's full authority will
    // promise things it cannot deliver; rotate-key in particular was
    // allow-listed briefly and removed by the owner on 2026-09-05.
    expect(section).toContain('allow-list')
    expect(section).toMatch(/cannot approve a\s+budget, rotate a key, change a signer or move money/)
  })
})
