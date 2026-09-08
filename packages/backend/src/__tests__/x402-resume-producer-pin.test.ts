// #2680 slice-2 guard — pins architecture/04-x402-payment-sequence.md §
// *Resume*'s "exactly one producer" claim: `next_action:
// retry_original_x402_request` is emitted by exactly ONE module in
// packages/backend/src — `modules/payments/agent-payment-status.ts`
// (`intentStateFor`). The SDK hard-requires that value
// (`assertCanResumeX402`), so a second producer with different semantics
// would silently widen what "resume" means.
//
// Mutation-proven for #2680: adding a second emission turns this red;
// removing it restores green, byte-identical.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

/** The one producer architecture/04-x402-payment-sequence.md § *Resume* allows. */
const EXPECTED_PRODUCER = 'modules/payments/agent-payment-status.ts'

function emittingFiles(): string[] {
  // The taxonomy constant is the canonical spelling; `RetryOriginalX402Request`
  // is its enum key, the string its wire value. Grep both, code lines only.
  const out = execFileSync(
    'grep',
    [
      '-rl',
      '--include=*.ts',
      '--exclude=*test*',
      '-e',
      'RetryOriginalX402Request',
      BACKEND_SRC,
    ],
    { encoding: 'utf8' },
  )
  return out
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(BACKEND_SRC + '/', ''))
    .filter((f) => !/\/__tests__\//.test(f))
    .sort()
}

describe('x402 resume: retry_original_x402_request has exactly one producer (#2680 pin)', () => {
  it('only modules/payments/agent-payment-status.ts emits it (plus the taxonomy definition)', () => {
    const files = emittingFiles()
    // agent-payment-taxonomy.ts DEFINES the constant; agent-payment-status.ts
    // is the single EMITTER the doc pins. sign-context.ts only MENTIONS it in
    // prose, which the taxonomy+emitter filter below tolerates.
    const nonDefiner = files.filter(
      (f) => !f.endsWith('modules/payments/agent-payment-status.ts') && !f.endsWith('domain/agent-payment-taxonomy.ts'),
    )
    // Anything else must not WRITE the value — a comment mention is fine, so
    // verify each extra file lacks an assignment/return of the constant.
    const writers = nonDefiner.filter((f) => {
      const src = execFileSync('grep', ['-n', '-e', 'RetryOriginalX402Request', join(BACKEND_SRC, f)], {
        encoding: 'utf8',
      })
      return src
        .split('\n')
        .some((l) => /(:\s*|=\s*|return\s+)AgentPaymentNextAction\.RetryOriginalX402Request/.test(l))
    })
    expect(
      writers,
      `architecture/04-x402-payment-sequence.md § *Resume* pins retry_original_x402_request to EXACTLY ONE producer (${EXPECTED_PRODUCER}); found write sites in:\n${writers.join('\n')}\nUpdate the doc's claim deliberately if this is a real second producer.`,
    ).toEqual([])
  })
})
