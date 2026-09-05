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
 * Hosts an artifact may link to. Everything else must be a same-origin path.
 *
 * `github.com` is here for one reason and is expected to leave: the product
 * docs have no served home until #2532 (A5) publishes them under `/docs/`, so
 * `account-recovery` points at the public repository in the meantime. When A5
 * lands, that link becomes `/docs/account-recovery.md` and this entry should
 * be deleted — the deletion is the test that A5 finished the job.
 */
const ALLOWED_HOSTS = new Set(['www.npmjs.com', 'github.com'])

/**
 * The single `github.com` URL the allow-list exists for. Asserted exactly,
 * because a host-scoped allow-list would let any future GitHub link inherit a
 * permission granted to one temporary one — the comment above would stay
 * written while stopping being true.
 */
const TEMPORARY_GITHUB_LINK =
  'https://github.com/d-hinders/Haven-AI/blob/dev/docs/product/account-recovery.md'

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

  it('allows exactly one github.com link, the temporary docs one', () => {
    const githubLinks = ARTIFACTS.flatMap((name) =>
      absoluteUrls(read(name)).filter((url) => new URL(url).hostname === 'github.com'),
    )
    expect(githubLinks).toEqual([TEMPORARY_GITHUB_LINK])
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
})
