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
    // Both figures, because they differ and each gets quoted somewhere: 10,543
    // UTF-8 bytes, 10,458 UTF-16 code units. The em-dashes are the gap — the
    // same units confusion #2562 fixed in the docs chain gate. Moved by #2526
    // (device-code login in step 1), by #2534, whose step-2 sentence names
    // `haven wallets funding`, by #2591, by #2539, whose "Budget changes
    // later" section names the `haven budget grant|revoke` commands, by
    // #2619, whose "At funding" script names the funding card's page
    // (`<host>/dashboard`) instead of "the dashboard", by #2617, whose
    // step-1 CLI login names the npm channel — `npx
    // @haven_ai/cli@<channel> login`, with a sentence saying the tag is read
    // from `/.well-known/haven.json` (`packages.cli.channel`), never picked —
    // and by #2618, whose step-1 names the non-blocking login sequence:
    // `--no-wait` under --json, then `haven login --poll <device_code>` — the
    // flow an agent can run without holding its turn open for ten minutes.
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
    //
    // 0.1.36-alpha.0: +1 byte, and it is a single SPACE. #2617 and #2618 each
    // added a sentence to step 1 and the seam between them lost the gap —
    // "never a tag you pick.Do not hold the process open". Neither PR could
    // see it, because each read only its own sentence; it surfaced when the
    // release shard's SDK-delta claim was reviewed against the merged string.
    // Caught before publication: 0.1.35-alpha.0 predates #2617, so the run-on
    // never reached npm.
    //
    // +318 bytes / +316 UTF-16 units by #2713 (Closes #2709), which appended a
    // sentence to step 2: read `/.well-known/haven.json` before telling the
    // user which deployment they are on — `environment` says whether it is
    // `production`, each `chains.supported` entry says whether that chain is a
    // `testnet`, and real money is at stake only on a non-testnet chain of a
    // production deployment. That PR edited the SDK runbook WITHOUT running
    // `node packages/cli/scripts/sync-agent-guidance.mjs`, so this suite went
    // red on `dev` itself. `CLI checks` is a required context on both `dev` and
    // `main`, but it is conditional (`if: needs.changes.outputs.cli`), and a
    // skipped required job counts as satisfied — so on the classifier's own
    // terms an SDK-only change should not have reddened unrelated pull
    // requests. It did anyway, and the reason is worth knowing: the classifier
    // reads its file list from a TWO-dot `git diff BASE_SHA HEAD_SHA` against
    // `pull_request.base.sha` (`change-classifier.mjs`, `changedFilesCommand`),
    // so a pull request whose base moved inherits everyone else's commits.
    // Measured on #2705's probe: 2 files three-dot (`cli:false`), 16 two-dot,
    // and among those 16 were root `package.json` and `.github/workflows/ci.yml`
    // from other people's merges — full-matrix files, so every surface routed
    // and `CLI checks` ran on a pull request that touched no CLI file. Since
    // #2632 turned the up-to-date rule off on `dev`, bases move constantly, so
    // this is the common case rather than the exotic one. Note also the shape
    // of the miss: the
    // regeneration alone does not make this test pass, because these two
    // figures are asserted by hand and a content change invalidates them too.
    // Both halves have to move together.
    expect(Buffer.byteLength(HAVEN_AGENT_RUNBOOK_MD, 'utf8')).toBe(10543)
    expect(HAVEN_AGENT_RUNBOOK_MD.length).toBe(10458)
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
