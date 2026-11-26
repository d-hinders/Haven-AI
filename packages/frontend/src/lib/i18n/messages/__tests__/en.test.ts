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
import { MERCHANT_KIT_TAGS_URL, merchantKitSetupPrompt, ownServerSetupPrompt } from '../en'

const REPO_ROOT = path.resolve(process.cwd(), '../..')
const README = path.join(REPO_ROOT, 'packages/paywall-proxy/README.md')

const PACKAGE_PAGE =
  'https://github.com/d-hinders/Haven-AI/pkgs/container/haven-paywall-proxy'

const STEP_1 =
  '1. Run the merchant kit from its container image, ghcr.io/d-hinders/haven-paywall-proxy, pinned to the newest pilot-<short-sha> tag if the package page lists one, otherwise the newest dev-<short-sha> tag. The pilot-<short-sha> tag arrives with the kit’s first production release. The tags are listed at https://github.com/d-hinders/Haven-AI/pkgs/container/haven-paywall-proxy, but that page does not order them by date: the setup guide’s “Which tag to pin” section has a command that prints the newest tag, and its quickstart shows the run command.'

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
    expect(readFileSync(README, 'utf8')).toContain('### Which tag to pin')
  })
})

/**
 * The hosting step (#5059). It is step 4, after the pilot line, so the agent
 * knows the host before it writes the environment variables in step 5.
 *
 * The line is pinned whole, against a literal, for the same reason step 1 is:
 * a partial match would pass on a line that lost the "any host with HTTPS and a
 * persistent disk" rule or the Railway example.
 *
 * The prompt stays silent on the buyer: buying belongs to a different Haven
 * user, and the README's buyer section is where that lives. The own-server
 * prompt gets no hosting step at all — that seller already runs a server.
 */
describe('the merchant kit setup prompt hosting step (#5059)', () => {
  const prompt = merchantKitSetupPrompt({
    accountAddress: '0x0000000000000000000000000000000000000001',
    salesUrl: 'https://havenbackend-dev-8b95.up.railway.app',
  })

  it('asks where the merchant hosts, as one literal line at step 4', () => {
    expect(prompt.split('\n')[5]).toBe(
      '4. Ask me where I host the merchant kit. Any host with HTTPS and a persistent disk works; the setup guide has Railway as a worked example.',
    )
  })

  it('does not mention the buyer', () => {
    expect(prompt).not.toMatch(/buyer/i)
  })

  it('leaves the own-server prompt without a hosting step', () => {
    // A neutral origin, because the dev origin's host is `…up.railway.app` and
    // the assertion is about the prompt's copy, not the URL it interpolates.
    const ownServer = ownServerSetupPrompt({
      accountAddress: '0x0000000000000000000000000000000000000001',
      salesUrl: 'https://haven-api.example',
    })
    expect(ownServer).not.toMatch(/where I host|Railway/i)
  })
})

/**
 * #5085: an MCP seller is pointed at the guide's MCP section, and told the
 * rule that fails first (a server without an MCP session id is refused at the
 * quote). Pinned whole, as one literal line right after step 2's values.
 */
describe('the own-server setup prompt MCP line (#5085)', () => {
  const prompt = ownServerSetupPrompt({
    accountAddress: '0x0000000000000000000000000000000000000001',
    salesUrl: 'https://haven-api.example',
  })

  it('points an MCP seller at the MCP section, as one literal line under step 2', () => {
    const lines = prompt.split('\n')
    expect(lines[7]).toBe(
      "   If you sell MCP tools, follow the worked example's MCP section: your server must answer initialize as a streamable HTTP MCP server, with sessions or without.",
    )
    expect(lines[8]).toBe('3. After each payment settles, report the sale to Haven:')
  })

  it('says session id, never session key', () => {
    expect(prompt).not.toMatch(/session key/i)
  })
})
