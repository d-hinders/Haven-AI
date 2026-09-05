import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HAVEN_AGENT_RUNBOOK_MD } from './agent-guidance-text.js'
// The canonical string lives in the SDK. The CLI keeps a generated copy so it
// can stay dependency-free (see agent-guidance-text.ts), so parity is asserted
// against the SDK source — read through the generator's own reader, so the
// test and the generator cannot disagree about what "canonical" means.
// @ts-expect-error — .mjs script, deliberately untyped and outside src/.
import { readCanonicalRunbook } from '../scripts/sync-agent-guidance.mjs'

describe('haven guide text (#2525)', () => {
  it('is byte-for-byte the canonical SDK runbook', async () => {
    const canonical = (await readCanonicalRunbook()) as string
    expect(HAVEN_AGENT_RUNBOOK_MD).toBe(canonical)
    // Both figures, because they differ and each gets quoted somewhere: 7,195
    // UTF-8 bytes, 7,130 UTF-16 code units. The em-dashes are the gap — the
    // same units confusion #2562 fixed in the docs chain gate.
    expect(Buffer.byteLength(HAVEN_AGENT_RUNBOOK_MD, 'utf8')).toBe(7705)
    expect(HAVEN_AGENT_RUNBOOK_MD.length).toBe(7638)
  })

  it('keeps the CLI free of runtime dependencies', () => {
    // The reason the copy exists at all. @haven_ai/sdk pulls ethers + viem +
    // x402 (~94 MB measured); `npx @haven_ai/cli` is the path an agent uses,
    // and this file is what keeps that install small. If a dependency is ever
    // added deliberately, this assertion is the place to argue with.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})
