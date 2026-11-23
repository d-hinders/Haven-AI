/**
 * The merchant kit setup prompt's first step names the tag to pin and the
 * package page that lists the tags (#5058).
 *
 * Two checks, and the split is the point:
 *
 *   - step 1 is pinned as a WHOLE LINE against a literal string, with the
 *     package-page URL written out. Asserting against `MERCHANT_KIT_TAGS_URL`
 *     would pass on an empty or wrong constant, because the prompt interpolates
 *     that same value; the literal is what makes a bad URL fail.
 *   - the README must carry the same URL, so the prompt and the setup guide
 *     cannot drift apart. The README is the merchant's other path to the tags.
 *
 * The rule the line states is the one that stays true across the kit's first
 * production release: pin the newest `pilot-<short-sha>` if the package page
 * lists one, otherwise the newest `dev-<short-sha>`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MERCHANT_KIT_TAGS_URL, merchantKitSetupPrompt } from '../en'

const REPO_ROOT = path.resolve(process.cwd(), '../..')
const README = path.join(REPO_ROOT, 'packages/paywall-proxy/README.md')

const PACKAGE_PAGE =
  'https://github.com/d-hinders/Haven-AI/pkgs/container/haven-paywall-proxy'

const STEP_1 =
  '1. Run the merchant kit from its container image, ghcr.io/d-hinders/haven-paywall-proxy, pinned to the newest pilot-<short-sha> tag if the package page lists one, otherwise the newest dev-<short-sha> tag. The pilot-<short-sha> tag arrives with the kit’s first production release; the tags are listed at https://github.com/d-hinders/Haven-AI/pkgs/container/haven-paywall-proxy, and the setup guide’s quickstart shows the run command.'

describe('the merchant kit setup prompt (#5058)', () => {
  const prompt = merchantKitSetupPrompt({
    accountAddress: '0x0000000000000000000000000000000000000001',
    salesUrl: 'https://havenbackend-dev-8b95.up.railway.app',
  })

  it('pins step 1 to the tag rule and the package page, as one literal line', () => {
    expect(prompt.split('\n')[2]).toBe(STEP_1)
  })

  it('names the same package page as the README, so the two texts cannot drift', () => {
    expect(MERCHANT_KIT_TAGS_URL).toBe(PACKAGE_PAGE)
    expect(readFileSync(README, 'utf8')).toContain(PACKAGE_PAGE)
  })
})
