import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Queue-framing census guard (#2063, the follow-up to #1947's showcase guard).
 *
 * The delegation rail — the only live rail (`rails/execution-rail.ts`) —
 * enforces budget, recipient and expiry ON-CHAIN during prepare: an
 * out-of-policy payment is DECLINED before any state is written
 * (`routes/payments.ts`: caveat rejection → 502, no delegation → 403).
 * Nothing queues, and both retired rails answer 410 at every agent-payment
 * entry point (#1986). #1947 pinned `/design-system`; this pins the product
 * surfaces and agent-facing handoff text its census found still teaching the
 * queue-and-approve model.
 *
 * Deliberately NOT covered here: AgentDetailClient's "Pending approvals"
 * stat block ("Payments waiting on you") — #2055 owns the backend counter
 * deletion and the surviving approvals-history rendering; guarding it here
 * would collide with that work.
 *
 * Source-text check, with the usual honesty: it proves the words are absent
 * from these files, not that every rendered sentence is true — that half is
 * the per-claim code citations in the shipping PR.
 */

const frontendSrc = resolve(__dirname, '../..')

const GUARDED_FILES = [
  'app/page.tsx',
  'app/signup/page.tsx',
  'components/UsingYourAgentInfo.tsx',
  'components/EditAgentModal.tsx',
  'components/connect-agent/ReviewStep.tsx',
  'app/(authenticated)/agents/[agentId]/AgentDetailClient.tsx',
  'lib/agent-handoff.ts',
  'lib/agent-skill-bundle.ts',
] as const

const QUEUE_CLAIMS = [
  'waits for your approval',
  'wait for your approval',
  'waits for your manual approval',
  'queued for your approval',
  'queued for approval',
  'queued for the user',
  'need your manual approval',
  'needs your manual approval',
  'requires approval',
] as const

describe('product copy and agent handoff text make no queue-and-approve claim (#2063)', () => {
  for (const file of GUARDED_FILES) {
    it(`${file} contains none of the legacy queue phrases`, () => {
      const lower = readFileSync(resolve(frontendSrc, file), 'utf8').toLowerCase()
      for (const phrase of QUEUE_CLAIMS) {
        const at = lower.indexOf(phrase)
        expect(
          at,
          `queue-and-approve phrasing "${phrase}" is back in ${file} (index ${at}) — ` +
            'the delegation rail declines out-of-policy payments on-chain; nothing queues (#2063)',
        ).toBe(-1)
      }
    })
  }
})
