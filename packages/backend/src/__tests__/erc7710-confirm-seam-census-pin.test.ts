// #2680 slice-2 guard — pins architecture/04-x402-payment-sequence.md's
// erc7710 confirmation claim: the agent-reported settle "cannot confirm a
// `submitted` erc7710 intent … the on-chain-verified seam in
// `attachMachinePaymentEvidence` stays the only door". The machine-checkable
// core is the call graph: `observeErc7710Settlement` — the on-chain-verified
// confirm — is invoked from exactly one production site
// (`modules/mpp/evidence.ts`); the sweeper reaches it through that same seam
// (its import is the DI default at `deps.observe`). Pinned by an importer
// census: no new direct caller can appear without reddening.
//
// Mutation-proven for #2680: importing observeErc7710Settlement directly from
// a second production module reddens; restoring byte-identical greens.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
)

describe('erc7710 confirm seam census (#2680 pin)', () => {
  it('observeErc7710Settlement has exactly one production import site', () => {
    let out = ''
    try {
      out = execFileSync(
        'grep',
        [
          '-rl',
          "--include=*.ts",
          "--exclude-dir=__tests__",
          "--exclude=*.test.ts",
          'observeErc7710Settlement',
          BACKEND_SRC,
        ],
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
    // evidence.ts is the only door; settlement-observed.ts is the definition;
    // settlement-sweeper.ts reaches it only as the DI default for its worker.
    expect(sites).toEqual([
      'modules/mpp/evidence.ts',
      'modules/x402/settlement-observed.ts',
      'modules/x402/settlement-sweeper.ts',
    ])
  })
})
