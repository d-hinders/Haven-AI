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
    // Both figures, because they differ and each gets quoted somewhere: 10,224
    // UTF-8 bytes, 10,141 UTF-16 code units. The em-dashes are the gap — the
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
    // #3304: +270 bytes, the "If something breaks" section — a `client_update`
    // on a result means update that client, and the release notes live at
    // /releases.
    //
    // #3412: +2 bytes / +6 UTF-16 units — that sentence now says to run
    // `upgrade_command` as given and then any repair line it prints (the
    // connector-installed packages' command became the connector doctor). The
    // units move more than the bytes because the two em-dashes it replaced
    // are 3 bytes but 1 unit each.
    //
    // #3430: −9 bytes / −9 units, and the first SHRINK of this string. Step 1
    // told the agent to fill a `npx @haven_ai/cli@<channel>` template from
    // `packages.cli.channel` — but the manifest serves the FULL spec under
    // that name (`@haven_ai/cli@dev`), so the literal substitution produced
    // `npx @haven_ai/cli@@haven_ai/cli@dev` (the 2026-09-28 cold run, finding
    // 1). The command is now the manifest's own `packages.cli.one_liner`, run
    // as given, so no raise was needed — the budget headroom grew instead.
    //
    // #3596: +34 bytes / +30 UTF-16 units. Two cross-references stopped
    // depending on the reader having just read an adjacent section, now that
    // the runbook is also served as linked step files at
    // `/agent-skills/<step>.md` (`docs/operations/agent-discovery-listings.md`):
    // step 1's "(below)" pointed at "## What you run", several sections away
    // once split, so it now names that section; "If you cannot open a
    // browser"'s "Steps 1-3" named step numbers defined in an earlier section
    // ("The sequence") and its "as above" pointed at the hand-off scripts
    // section — both read fine as one document and not as an isolated slice,
    // so the three words are now a parenthetical (account, funding, budget)
    // and the tail clause is dropped rather than left dangling. Review then
    // found one more: "Budget changes later"'s "the setup above" points at
    // nothing once that section stands alone, so it now names "The sequence"
    // (+10 bytes, 10904 -> 10914).
    //
    // #3597: +212 bytes / +210 units — "If something breaks" gains a second
    // paragraph: `haven feedback submit "<text>"` needs `haven login` first,
    // and the sentence repeats the rule never to put a credential in that
    // text (the command's own secret check already refuses one, but cannot
    // catch every shape). Merged on top of #3596's 10914/10827, landing at
    // 11126/11037.
    //
    // #3689: +304 bytes / +304 units — the command-modification rule gains
    // its third permitted change (the user-chosen --name/--replace re-run
    // after a wiring_collision relay, +295), and "the two-changes rule"
    // becomes "the command-modification rule" (+9).
    // Lands at 11430/11341.
    expect(Buffer.byteLength(HAVEN_AGENT_RUNBOOK_MD, 'utf8')).toBe(11430)
    expect(HAVEN_AGENT_RUNBOOK_MD.length).toBe(11341)
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
