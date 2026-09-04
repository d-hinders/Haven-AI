import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HAVEN_AGENT_RUNBOOK_MD } from './agent-guidance-text.js'
// The canonical string lives in the SDK. The CLI keeps a generated copy so it
// can stay dependency-free (see agent-guidance-text.ts), so parity is asserted
// here against the SDK SOURCE — the same arrangement the frontend uses.
import { HAVEN_AGENT_RUNBOOK_MD as CANONICAL } from '../../sdk/src/agent-guidance'

describe('haven guide text (#2525)', () => {
  it('is byte-for-byte the canonical SDK runbook', () => {
    expect(HAVEN_AGENT_RUNBOOK_MD).toBe(CANONICAL)
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
