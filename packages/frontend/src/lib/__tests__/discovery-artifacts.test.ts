import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guard for the agent-readable discovery artifacts (#2520).
 *
 * These four files ship in `public/` and are the first thing an agent reads.
 * Until #2520 they pointed at `haven.xyz`, `app.haven.xyz` and
 * `docs.haven.xyz` — three domains nobody owns, so every "Start here" line in
 * the cold test resolved to `Could not resolve host`. Nothing failed: a dead
 * link in a static text file is invisible to type-checking, to the copy lint,
 * and to a human who never re-reads a file they are not editing.
 *
 * So the rule is mechanical rather than remembered. Own-product links are
 * same-origin paths, which resolve identically on the dev preview, on
 * production and on any custom domain mapped later — the reason the epic
 * (#2519) chose paths over absolute hosts. Off-site links are allowed only
 * from a named list, so adding one is a decision somebody makes on purpose.
 */

const PUBLIC_DIR = join(__dirname, '../../../public')

const ARTIFACTS = [
  'llms.txt',
  'llms-full.txt',
  '402.md',
  '402/index.html',
  // #2523: the agent onboarding runbook is served from the same directory and
  // is read by the same client, so the same link rules bind it. Its content is
  // pinned separately (for-agents-runbook.test.ts); what is asserted here is
  // only that it cannot reintroduce a host nobody owns.
  'for-agents.md',
] as const

/**
 * A chain named as a fact in a served artifact (#2596).
 *
 * Shape matcher, NOT a semantic one, and the difference is asserted below
 * rather than left to this comment: it knows the three chain names Haven
 * serves, their numeric ids, and the "on the X network" phrasing. A sentence
 * that asserts a chain without using any of those passes. The first version
 * of this guard also missed "on the Base network" and a bare chain id, both
 * found by review — widened here, and the residual ceiling is pinned by a
 * control so nobody reads a green run as more than it is.
 */
const CHAIN_ASSERTION = /\b(?:Base Sepolia|Base|Gnosis)\b|\bchain\s+(?:100|8453|84532)\b/
const RESOLVER = '/.well-known/haven.json'

/**
 * Hosts an artifact may link to. Everything else must be a same-origin path.
 *
 * `github.com` USED to be here, for one temporary reason: the product docs had
 * no served home, so `account-recovery` pointed at the public repository. #2532
 * serves them from this origin under `/docs/`, so the link is now a path and
 * the entry is gone. Its deletion was the stated test that #2532 finished the
 * job; this is that deletion.
 *
 * The artifacts under test are back to the rule with no exception: own-product
 * links are same-origin paths, and the only off-site host is npm.
 */
const ALLOWED_HOSTS = new Set(['www.npmjs.com'])

const DEAD_HOSTS = ['haven.xyz', 'app.haven.xyz', 'docs.haven.xyz']

function read(name: string): string {
  return readFileSync(join(PUBLIC_DIR, name), 'utf8')
}

/**
 * Every off-origin URL in the text, whatever syntax carries it.
 *
 * Protocol-relative (`//host/path`) counts. Review found that omitting it left
 * the guard blind to the likeliest way a dead host comes back: someone
 * "relativizing" a link by dropping `https:` instead of the whole origin, which
 * still leaves the browser fetching another host. Bare `//` forms are returned
 * with a scheme so `new URL()` can read their hostname.
 *
 * Known limit, deliberate: a host written with no scheme and no `//` at all
 * ("see docs.haven.xyz for details") is not extracted, because in these files
 * that is prose rather than a link. It costs nothing for the three named dead
 * hosts — the substring check in the first test and the repo-wide `git grep`
 * in the fifth both find a bare mention, proven by a reviewer who staged a
 * scheme-less fixture and watched the grep test go red. So the only uncovered
 * case is a NEW off-list host written bare. Widening the regex to bare domains
 * would flag every prose mention of any dotted name, which is how a guard
 * becomes something people route around.
 */
export function absoluteUrls(text: string): string[] {
  return [...text.matchAll(/(?:https?:)?\/\/[^\s"'`)<>\]]+/g)]
    .map((m) => (m[0].startsWith('//') ? `https:${m[0]}` : m[0]))
}

describe('discovery artifacts (#2520)', () => {
  it.each(ARTIFACTS)('%s names none of the domains we do not own', (name) => {
    const text = read(name)
    for (const host of DEAD_HOSTS) {
      expect(text, `${name} still references ${host}`).not.toContain(host)
    }
  })

  it.each(ARTIFACTS)('%s links off-site only to allow-listed hosts', (name) => {
    const offSite = absoluteUrls(read(name))
      .map((url) => new URL(url).hostname)
      .filter((hostname) => !ALLOWED_HOSTS.has(hostname))
    expect(offSite, `${name} links to a host that is not allow-listed`).toEqual([])
  })

  it('the connect one-liner is unchanged in every artifact that carries it', () => {
    // Invariant from #2519: A1 changes URLs, never the command. The published
    // one-liner is copied verbatim by agents; `docs/operations/agent-discovery-listings.md`
    // is the doc that says so, "everywhere, verbatim".
    //
    // Carriers are the files with an actual `npx` invocation — three of the
    // four. `llms.txt` names the package as an npm link and never prints the
    // command, so matching on the package name alone would assert the
    // one-liner into a file that has never had one.
    const carriers = ARTIFACTS.filter((name) => read(name).includes('npx @haven_ai/connect'))
    expect(carriers).toEqual(['llms-full.txt', '402.md', '402/index.html'])
    // `for-agents.md` is deliberately NOT a carrier of the bare one-liner: the
    // runbook prints the full connector command the backend builds, token flag
    // included (`npx -y @haven_ai/connect@alpha --setup …`), because an agent
    // reading it needs the shape it will be handed, not a command it could run
    // as-is — and the dist-tag stays a `<channel>` placeholder, because a
    // published package must not hard-code one (#2423). Asserted so the
    // exclusion above reads as a decision.
    expect(read('for-agents.md')).toContain('npx -y @haven_ai/connect@<channel> --setup')
    for (const name of carriers) {
      expect(read(name), name).toContain('npx @haven_ai/connect@alpha')
    }
  })

  it('the same-origin rule is stated in the files an agent reads first', () => {
    // A bare `/402.md` is only unambiguous if the file says what to resolve it
    // against — an agent may have been handed the text rather than the URL.
    for (const name of ['llms.txt', 'llms-full.txt'] as const) {
      expect(read(name), name).toContain('paths on this same host')
    }
  })

  it('links NO github.com url — the temporary docs exception is retired (#2532)', () => {
    // The product docs are served from this origin now. A GitHub link
    // reappearing here means someone re-introduced the placeholder rather than
    // adding a doc to the serve-docs allowlist.
    const githubLinks = ARTIFACTS.flatMap((name) =>
      absoluteUrls(read(name)).filter((url) => new URL(url).hostname === 'github.com'),
    )
    expect(githubLinks).toEqual([])
  })

  it('points account recovery at the served path', () => {
    expect(read('llms.txt')).toContain('](/docs/account-recovery.md)')
  })

  it('no shipped frontend source links a domain we do not own', () => {
    // The artifacts were #2520's stated scope, but the claim is wider than the
    // four files: this PR's own review found `docs.haven.xyz` live in the
    // recovery UI, where a user clicks it. The rule that the surface class is
    // the boundary rather than the file list is #2512's; the site it caught
    // here is #2520's.
    const SRC = join(__dirname, '../..')
    // `git grep -l` exits 1 when it matches nothing, which is the healthy case
    // here — so read the status rather than letting a throw stand in for a
    // result. The first version of this test threw on a clean tree.
    const run = (pattern: string) =>
      spawnSync('git', ['grep', '-l', '-E', pattern, '--', ':!**/__tests__/**', '.'], {
        cwd: SRC,
        encoding: 'utf8',
      })
    const found = run(DEAD_HOSTS.join('|'))
    expect(found.status, found.stderr).not.toBe(2)
    expect(found.stdout.split('\n').filter(Boolean)).toEqual([])
    // Positive control: the same command must be able to find something.
    const control = run('classifyAgentUserAgent')
    expect(control.stdout.split('\n').filter(Boolean).length).toBeGreaterThan(0)
  })

  it('rejects a reintroduced dead host and an unlisted off-site host', () => {
    // The negative control: the two assertions above must be able to fail.
    // Without this, a regex that matches nothing passes every artifact.
    expect(absoluteUrls('see https://app.haven.xyz/x and /402.md')).toEqual([
      'https://app.haven.xyz/x',
    ])
    const hostnames = absoluteUrls('a https://example.com/b c https://www.npmjs.com/d')
      .map((url) => new URL(url).hostname)
      .filter((hostname) => !ALLOWED_HOSTS.has(hostname))
    expect(hostnames).toEqual(['example.com'])
    // Protocol-relative, the form that slipped past the first version.
    expect(absoluteUrls('<a href="//exit.example-cdn.com/x">')).toEqual([
      'https://exit.example-cdn.com/x',
    ])
  })

  /**
   * No served artifact asserts a chain the deployment can contradict (#2596).
   *
   * These files are STATIC: one copy, served byte-identical from production
   * and from every test deployment. So a bare chain name in them is a fact
   * about one deployment printed on all of them, and the reader has no way to
   * tell which one they are holding.
   *
   * #2591 fixed the sharp end of this — `/for-agents.md`'s funding step, where
   * a wrong chain sends a human's real money somewhere it can never be
   * recovered from. These four are the blunt end: they describe Haven's
   * settlement rail rather than instructing a transfer, so nobody loses funds
   * by reading them. They still matter, because an agent reads them ALONGSIDE
   * the corrected runbook, and of two Haven-authored documents that disagree
   * the assertive one is likelier to win — it reads as a product fact rather
   * than as something to go and check.
   *
   * The rule is deliberately about the SHAPE, not the word "Base": any bare
   * chain assertion is the defect, and naming the resolver is the fix.
   */
  it('names no chain without saying where the real one comes from (#2596)', () => {
    const offenders: string[] = []
    for (const name of ARTIFACTS) {
      for (const [index, line] of read(name).split('\n').entries()) {
        // SENTENCE granularity, not line. These files have very long lines —
        // `llms.txt:5` is one paragraph — so a line-level exemption let a
        // resolver mentioned for an unrelated reason clear a bare chain claim
        // somewhere else on the same line. Demonstrated by haven-reviewer:
        // "We only support USDC on Base. Also see /.well-known/haven.json for
        // our privacy policy." passed. Splitting on sentence boundaries makes
        // the exemption apply to the claim it is actually attached to.
        for (const sentence of line.split(/(?<=[.;])\s+/)) {
          if (!CHAIN_ASSERTION.test(sentence)) continue
          if (sentence.includes(RESOLVER)) continue
          offenders.push(`${name}:${index + 1}`)
        }
      }
    }
    expect(offenders, `bare chain assertion in a served artifact: ${offenders.join(', ')}`).toEqual([])
  })

  it('POSITIVE CONTROL: the matcher separates a bare assertion from a qualified one', () => {
    const bare = 'Payments settle in USDC on Base via x402.'
    const qualified = `Payments settle in USDC on the chains reported in ${RESOLVER}.`
    expect(CHAIN_ASSERTION.test(bare) && !bare.includes(RESOLVER)).toBe(true)
    expect(CHAIN_ASSERTION.test(qualified) && !qualified.includes(RESOLVER)).toBe(false)
  })

  it('POSITIVE CONTROL: the widened shapes are caught, and the ceiling is where it says', () => {
    // Each of these slipped the first version of the pattern (haven-reviewer).
    for (const caught of [
      'settles on Base mainnet.',
      'on the Base network for now.',
      'Deployed to chain 8453 today.',
      'Payments run on Gnosis.',
    ]) {
      expect(CHAIN_ASSERTION.test(caught), caught).toBe(true)
    }
    // And the ceiling, asserted rather than described, because the comment
    // above used to claim this catches "any bare chain assertion" and it does
    // not — it is a shape matcher, not a semantic one. A paraphrase that names
    // no chain, no id and no network word passes, and a green run is not
    // evidence about one.
    expect(CHAIN_ASSERTION.test('Settlement happens where the treasury lives.')).toBe(false)
  })

  it('POSITIVE CONTROL: a resolver mentioned for something else does not exempt a chain claim', () => {
    // The vacuous pass the sentence split closes.
    const smuggled = `We only support USDC on Base. Also see ${RESOLVER} for our privacy policy.`
    const sentences = smuggled.split(/(?<=[.;])\s+/)
    const cleared = sentences.filter((x) => CHAIN_ASSERTION.test(x) && !x.includes(RESOLVER))
    expect(cleared).toHaveLength(1)
  })
})
