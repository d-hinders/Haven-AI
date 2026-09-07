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
    // Both figures, because they differ and each gets quoted somewhere: 9,976
    // UTF-8 bytes, 9,895 UTF-16 code units. The em-dashes are the gap — the
    // same units confusion #2562 fixed in the docs chain gate. Moved by #2526
    // (device-code login in step 1), by #2534, whose step-2 sentence names
    // `haven wallets funding`, by #2591, by #2539, whose "Budget changes
    // later" section names the `haven budget grant|revoke` commands, by
    // #2619, whose "At funding" script names the funding card's page
    // (`<host>/dashboard`) instead of "the dashboard", and by #2617, whose
    // step-1 CLI login names the npm channel — `npx
    // @haven_ai/cli@<channel> login`, with a sentence saying the tag is read
    // from `/.well-known/haven.json` (`packages.cli.channel`), never picked.
    //
    // #2591 is the one worth a sentence, because it is a money-path copy fix
    // rather than an addition. Step 2 said "USDC on Base" on a page served
    // unchanged from every deployment — including the Base Sepolia one the
    // 2026-09-06 cold run fetched it from. That run escalated the ambiguity to
    // its user instead of acting on it ("I don't want you sending real money
    // to a testnet address"), which is the correct behaviour and also the
    // measure of how bad the sentence was. The page now names the SOURCE of
    // the chain — the command, or the dashboard without a CLI session — and
    // tells the agent never to assume one. The rest of the growth is the
    // `--api` flag. That clause was WRONG in this PR's first draft and the
    // correction is why the figure moved twice: it said the CLI defaults to
    // localhost, copied from the CLI's own stale `--help`. `commands.ts:22`
    // has pointed DEFAULT_API at Haven's hosted PRODUCTION backend since #535.
    // The true version is the more urgent one — on a non-production
    // deployment an omitted flag does not fail, it connects somewhere real and
    // wrong — so the page says that instead.
    expect(Buffer.byteLength(HAVEN_AGENT_RUNBOOK_MD, 'utf8')).toBe(9976)
    expect(HAVEN_AGENT_RUNBOOK_MD.length).toBe(9895)
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
