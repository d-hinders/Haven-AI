import { describe, expect, it } from 'vitest'
import { composeDescription, toolDescriptions } from './tool-descriptions.js'
import { AgentPaymentNextAction } from './types.js'
import { readFileSync } from 'node:fs'

describe('shared Haven tool descriptions', () => {
  it('routes allowance and budget questions to the allowance lookup', () => {
    const desc = composeDescription(toolDescriptions.getAllowances).toLowerCase()

    expect(desc).toContain('allowance')
    expect(desc).toContain('budget')
    expect(desc).toContain('spend limit')
    expect(desc).toContain('remaining amount')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('remaining budget')
    expect(desc).toContain('daily limit')
    expect(desc).toContain('reset period')
    expect(desc).toContain('what can i spend')
    expect(desc).toContain('what the agent can still spend')
  })

  it('routes transaction-history questions away from remaining-budget lookups', () => {
    const desc = composeDescription(toolDescriptions.listReceipts).toLowerCase()

    expect(desc).toContain('transaction history')
    expect(desc).toContain('payment evidence')
    expect(desc).toContain('use the allowance tool instead')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('what-can-i-spend')
  })

  it('routes read-only budget questions away from payment tools', () => {
    for (const key of ['payX402'] as const) {
      const desc = composeDescription(toolDescriptions[key]).toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('what-can-i-spend')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })

  it('no longer registers the retired mpp_demo tool-description fragments (#1328)', () => {
    expect(Object.keys(toolDescriptions)).not.toContain('quoteMpp')
    expect(Object.keys(toolDescriptions)).not.toContain('payMpp')
    expect(Object.keys(toolDescriptions)).not.toContain('resumeMpp')
  })

  // ── Prose-drift guards ──────────────────────────────────────────────
  //
  // Agent feedback specifically called out the older `haven_x402_authorize`
  // description embedding multi-step instructions like
  //   "Next: sign payload_hash with x402.expected on your machine, call
  //    haven_submit..."
  // and noted that an agent has to *parse prose* to recover the next step.
  // Structured `nextAction` values on responses are the reliable path;
  // descriptions should describe what the tool does and what the agent
  // should read from the response, never tell the agent to call a specific
  // follow-up tool name as a hardcoded next step.
  //
  // SCOPE LIMIT: these guards iterate the fragments registered in
  // `tool-descriptions.ts` (the local MCP + SDK shared source of truth).
  // They do NOT cover hand-rolled description strings that live elsewhere
  // — notably `packages/mcp-server/src/tools.ts`, where the legacy hosted
  // MCP still carries the "Next: sign payload_hash..." prose the original
  // feedback flagged. Aligning the hosted MCP is a separate, deferred
  // slice. A future author editing the hosted-MCP descriptions will not
  // get a signal from these guards, by design.
  it('contains no developer-doc-style imperatives ("Next:", "Then call X", ...) in any tool-descriptions.ts fragment', () => {
    // These were the exact shapes the original agent feedback flagged. Any
    // future fragment registered in this module that drops imperative prose
    // like this is signalling that the structured `nextAction` field should
    // be carrying the same information instead. Hand-rolled description
    // strings outside this module are explicitly out of scope (see the
    // SCOPE LIMIT note above).
    const forbidden: Array<RegExp> = [
      /\bNext\s*:/i,
      /\bThen\s+call\b/i,
      /\bThen\s+sign\b/i,
      /\bThen\s+submit\b/i,
      /\bNow\s+call\b/i,
      /\bAfter\s+that,?\s+call\b/i,
    ]

    for (const [key, fragment] of Object.entries(toolDescriptions)) {
      const composed = composeDescription(fragment as typeof fragment)
      for (const pattern of forbidden) {
        expect(
          composed,
          `${key} description must not embed developer-doc imperatives — use structured nextAction on the response instead. Hit: ${pattern}`,
        ).not.toMatch(pattern)
      }
    }
  })

  it('teaches agents to read the structured nextAction on payment tools, not memorise tool names', () => {
    // Each payment tool's nextActionGuidance must reference the structured
    // nextAction enum the agent will see on the response, so the agent
    // branches on machine-readable data instead of prose.
    //
    // #2131 REWROTE THIS ASSERTION, and the reason is the point. It used to
    // anchor on the literal `nextAction=retry_original_x402_request`. The
    // intent was right; the anchor died. Nothing emits that value — the
    // backend's `paymentIntentState` never returns it, and the SDK's
    // `executed` mapping reads a status the backend cannot produce since
    // #2055 dropped `approval_requests`. So this test REQUIRED the
    // descriptions to keep telling agents to wait on a signal that never
    // arrives: the stale guidance was enforced, not merely un-noticed.
    //
    // The lesson is not "pick a better literal" — any single value can die
    // the same way. Anchor on the SHAPE (a structured nextAction is
    // referenced) and require the referenced value to be a declared member of
    // the taxonomy, so a typo or a deleted enum member still fails, without
    // hard-coding one value's fate into the test.
    const declared = new Set<string>(Object.values(AgentPaymentNextAction))

    for (const key of ['payX402', 'payX402OneShot'] as const) {
      const desc = composeDescription(toolDescriptions[key])
      // Character class includes digits: `retry_original_x402_request` is today the
      // ONLY taxonomy value containing one, so `[a-z_]+` alone would truncate it to
      // `retry_original_x` — still failing the membership check, but by accident
      // rather than by design, and silently wrong for any future value with a digit.
      const referenced = [...desc.matchAll(/nextAction=([a-z0-9_]+)/g)].map((m) => m[1])

      expect(
        referenced,
        `${key} should reference at least one structured nextAction=<value> so the agent reads the machine-readable field instead of prose`,
      ).not.toHaveLength(0)

      for (const value of referenced) {
        expect(
          declared,
          `${key} references nextAction=${value}, which is not a member of AgentPaymentNextAction`,
        ).toContain(value)
      }
    }
  })

  it('#2131: no tool description advertises the x402 resume trigger while nothing emits it', () => {
    // The regression guard for #2131 itself. `retry_original_x402_request` is
    // a declared enum member with NO producer: the backend never emits it, and
    // the SDK's `executed` mapping reads a status that cannot occur. A
    // description naming it tells an agent to wait for, or gate on, a signal
    // that never arrives — which is how nine live agent-facing sites came to
    // carry it.
    //
    // DELETE THIS TEST when #2145 gives the value a reachable producer. Until
    // then, re-advertising it is a regression, and the previous version of the
    // test above shows it is one that can be introduced by a well-meant
    // assertion rather than by careless prose.
    for (const [key, entry] of Object.entries(toolDescriptions)) {
      expect(
        composeDescription(entry),
        `${key} must not advertise retry_original_x402_request — nothing emits it (see #2145)`,
      ).not.toContain('retry_original_x402_request')
    }
  })

  it('warns x402 payment tools about the new insufficient_funds failure mode', () => {
    // Slice B added a pre-flight check that surfaces phase=insufficient_funds
    // / nextAction=fund_safe_or_raise_allowance when the delegate balance plus
    // the remaining Safe allowance cannot cover the requested amount. The
    // x402 payment descriptions must mention this failure mode so agents know
    // to expect it from the response and surface the shortfall to the user
    // instead of retrying. This guard fails if a future taxonomy change drops
    // the reference and leaves agents to discover the failure mode on first
    // production hit.
    for (const key of ['payX402', 'payX402OneShot'] as const) {
      const desc = composeDescription(toolDescriptions[key])
      expect(desc).toContain('phase=insufficient_funds')
      expect(desc).toContain('nextAction=fund_safe_or_raise_allowance')
    }
  })

  it('guides agents from a quote success into the matching pay tool', () => {
    // Empty nextActionGuidance on the quote tools used to leave agents
    // wondering what to call next after a successful quote — the answer is
    // never "call the merchant again," because the SDK has already captured
    // the request and Haven will re-use that capture when paying. Pin the
    // guidance so the chain is discoverable from descriptions alone.
    const x402QuoteDesc = composeDescription(toolDescriptions.quoteX402)
    expect(x402QuoteDesc).toContain('haven_pay_x402_quote')
    expect(x402QuoteDesc.toLowerCase()).toContain('do not call the merchant again')
  })

  it('describes category-normalized catalog discovery as read-only and indicative', () => {
    const desc = composeDescription(toolDescriptions.discoverTools)

    expect(desc).toContain('case-insensitive category filter')
    expect(desc).toContain('product name, category, or description term')
    expect(desc).toContain('NOT authoritative')
    expect(desc).toContain('Never creates a payment, signature, or approval')
  })
})

describe('#2131: the shipped SDK README does not advertise the dead resume trigger', () => {
  /**
   * `packages/sdk` ships README.md on npm, and its next-action table and resume
   * section are integrator-facing copy that nothing renders — so it drifts
   * silently. Precedent for guarding it this way: `packages/mcp/src/consent.test.ts`
   * pins two load-bearing README sentences after #2086 found that README still
   * showing retired AllowanceModule copy long after the renderer moved on
   * ("Nothing checked it, so nothing said so").
   *
   * That is this PR's failure mode exactly, so the READMEs get the same
   * treatment as the code. Pinning the load-bearing CLAIMS, not whole
   * paragraphs: the point is that the README must not present the trigger as
   * live, while still being allowed to document it as retired.
   */
  it('presents retry_original_x402_request only as retired, never as a live trigger', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

    // INVERTED, and the inversion is the lesson. Two earlier versions of this
    // guard asserted the ABSENCE of something that reads like an instruction —
    // first two exact sentences, then "no line names the value and also says
    // 'call'". haven-reviewer defeated both with realistic prose in this file's
    // own house style: a same-line synonym ("invoke"), and the word "call"
    // split across a line wrap at ~80 cols. Enumerating action verbs is an
    // unbounded synonym problem, and the wrap point is a formatting accident.
    //
    // So assert a POSITIVE property instead: every mention of the value sits in
    // retirement framing, and there are no mentions beyond the known ones. An
    // instruction has to name the value verbatim for a reader to act on it —
    // there is no rephrase-and-still-be-a-trap move — so a new advertisement
    // must add an occurrence, which the count pins, and must sit in framing it
    // cannot honestly claim.
    const LITERAL = 'retry_original_x402_request'

    // 0. The retirement framing EXISTS. Restored after the inversion dropped
    //    it: without this, deleting the unavailability note wholesale leaves a
    //    README that mentions the value only in a table row and still passes,
    //    because the checks below only constrain mentions that remain. Found by
    //    mutating this guard rather than by reading it — the same way its two
    //    predecessors were found wanting.
    expect(readme).toContain('**No longer produced — nothing maps to it.**')
    expect(readme).toMatch(/Resume is not\s+currently available/)

    // 1. Count pin, over the whole file including the state diagram. Any NEW
    //    mention fails here regardless of how it is worded or wrapped.
    //    If you legitimately restructured this README, update the count in the
    //    same commit and satisfy yourself the new mentions are retirement
    //    framing, not instructions.
    const total = readme.split(LITERAL).length - 1
    expect(
      total,
      `expected at most 4 mentions of ${LITERAL} in the SDK README (2 in the retired state diagram, the retired next-action table row, the unavailability note) — a new one is a re-advertisement unless proven otherwise (see #2145)`,
    ).toBeLessThanOrEqual(4)

    // 2. Every PROSE mention sits in retirement framing IN ITS OWN structural
    //    unit. Fenced blocks are excluded: the state diagram's labels are drawn
    //    art under their own RETIRED BRANCH banner.
    //
    //    Scoped to the unit, not a character window, and that is the fix for a
    //    hole haven-reviewer found in the windowed version: deleting this row's
    //    own retirement clause passed, because two unrelated sibling rows
    //    (`wait_for_user_approval`, `wait_for_user_to_complete_payment`) carry
    //    the identical bolded phrase two lines above and satisfied a ±260-char
    //    window by pure table adjacency. That evasion needs no rhetoric — just
    //    a contributor tightening the table's prose — so it was worth closing
    //    rather than documenting.
    //
    //    A markdown table row is one line; everything else is its paragraph.
    //    Blockquote markers are stripped so a `> ` cannot split a paragraph,
    //    and each unit's whitespace is collapsed so a line wrap cannot hide
    //    anything inside it.
    const prose = readme.replace(/```[\s\S]*?```/g, ' ')
    const units: string[] = []
    for (const block of prose.split(/\n\s*\n/)) {
      const stripped = block.replace(/^\s*>\s?/gm, '')
      // Table rows stand alone; a sibling row must not vouch for this one.
      if (/^\s*\|/m.test(stripped)) units.push(...stripped.split('\n'))
      else units.push(stripped)
    }

    const RETIRED = /no longer produced|not currently (available|reachable)|has no producer|nothing maps to it|nothing emits/i
    const unframed = units
      .map((u) => u.replace(/\s+/g, ' ').trim())
      .filter((u) => u.includes(LITERAL) && !RETIRED.test(u))

    expect(
      unframed,
      `every prose mention of ${LITERAL} must carry retirement framing in its OWN table row or paragraph — a neighbour's framing does not vouch for it`,
    ).toEqual([])

    // WHAT THIS DOES NOT CATCH — one class, stated at its real size, because
    // every earlier version of this guard failed for claiming completeness and
    // a flattering understatement would be the same mistake in better clothes.
    //
    // REVERSAL IN PLACE. The framing check tests whether a retirement phrase is
    // present in the unit — it cannot tell "X is true" from "X was true, and no
    // longer is". Rewriting this row to "**No longer produced — nothing maps to
    // it.** That was true through the last release; as of this build it fires
    // again, so resume immediately" keeps the count at 4, keeps the retirement
    // phrase verbatim in its own unit, and PASSES. Verified, not reasoned about.
    //
    // That also proves the exact-phrase pins two versions of this guard used
    // would not have helped: the mutation preserves them word for word and
    // appends a supersession clause.
    //
    // Accepted rather than chased, and this is the resting point. Detecting
    // reversal cues ("as of", "now", "that's changed", "update:") is the same
    // unbounded-vocabulary problem that defeated the verb list, one level up.
    // At some point that is true of any assertion over freeform markdown.
    //
    // What IS caught, and is the threat that has actually occurred on this
    // repo: a lazy re-advertisement. A new mention anywhere (count), a mention
    // carrying no retirement framing of its own (unit scoping), and deletion of
    // the retirement claims wholesale (step 0) all fail. A neighbour's framing
    // does not vouch for a mention — that hole was open in the windowed version
    // and was closed rather than documented, because reaching it needed no
    // rhetoric at all, just a contributor tightening the table's prose.
    //
    // A deliberate rewrite arguing the value is live again defeats this test.
    // The human reviewing that diff is the control there, and unlike the
    // accidental case, that diff reads as what it is.
  })
})
