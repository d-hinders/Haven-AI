import { describe, it, expect } from 'vitest'
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

const ARTIFACTS = ['llms.txt', 'llms-full.txt', '402.md', '402/index.html'] as const

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

const DEAD_HOSTS = ['haven.xyz', 'app.haven.xyz', 'docs.haven.xyz']

function read(name: string): string {
  return readFileSync(join(PUBLIC_DIR, name), 'utf8')
}

/** Every absolute `http(s)://` URL in the text, whatever syntax carries it. */
export function absoluteUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'`)<>\]]+/g)].map((m) => m[0])
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
  })
})
