// #2680 slice-2 guard — pins architecture/04-x402-payment-sequence.md's
// gate-symmetry claim: "The gate now opens for exactly the state described
// above and no other, because it reads the *same* predicate over the *same*
// derived row: `isFundedX402AwaitingMerchantLeg` is exported from
// `agent-payment-status.ts` and called by both `intentStateFor` and
// `getX402SignContext`". Pinned by a call-site census: exactly two production
// call sites, the two the doc names.
//
// Mutation-proven for #2680: a third call site reddens; restoring the file
// turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

describe('resume-gate predicate call census (#2680 pin)', () => {
  it('isFundedX402AwaitingMerchantLeg is called by exactly the two sites the doc names', () => {
    let out = ''
    try {
      out = execFileSync(
        'grep',
        ['-rln', '--include=*.ts', '--exclude-dir=__tests__', '--exclude=*.test.ts',
         'isFundedX402AwaitingMerchantLeg(', BACKEND_SRC],
        { encoding: 'utf8' },
      )
    } catch {
      out = ''
    }
    const sites = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => p.replace(BACKEND_SRC + '/', ''))
      .sort()
    // agent-payment-status.ts holds the definition AND the intentStateFor call
    // site; sign-context.ts is the getX402SignContext side (via
    // isFundedMerchantRetry). A third gate reader reddens.
    expect(sites).toEqual([
      'modules/payments/agent-payment-status.ts',
      'modules/x402/sign-context.ts',
    ])
  })
})
