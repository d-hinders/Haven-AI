import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_SURFACES, buildSitemapXml, buildRobotsTxt } from '@/lib/discovery-surfaces'

/**
 * `/demo` and `/demo.md` are semi-private: not advertised, the team hands the
 * link to invited investors (#3477). `discovery-surfaces.test.ts`'s "lists
 * nothing else" test only compares the sitemap's `<loc>` COUNT against
 * `PUBLIC_SURFACES.length` (`discovery-surfaces.test.ts:163`), so it stays
 * green even if `/demo` were added to `PUBLIC_SURFACES` — it would just count
 * one more matching `<loc>`. These are explicit ABSENCE assertions instead:
 * add `/demo` to `PUBLIC_SURFACES`, or paste a `/demo` link into any of these
 * files, and the matching assertion below goes red without needing the
 * vacuous count check to notice anything — proven by hand (adding `/demo` to
 * `PUBLIC_SURFACES` red-lit both the `PUBLIC_SURFACES` and sitemap
 * assertions below; that mutation was reverted, not committed).
 */
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', '..')

function read(relative: string): string {
  return readFileSync(join(FRONTEND_ROOT, relative), 'utf8')
}

describe('/demo and /demo.md are not listed anywhere discoverable (#3477)', () => {
  it('is absent from PUBLIC_SURFACES', () => {
    const surfaces: readonly string[] = PUBLIC_SURFACES
    expect(surfaces).not.toContain('/demo')
    expect(surfaces).not.toContain('/demo.md')
  })

  it('is absent from the generated sitemap.xml', () => {
    const xml = buildSitemapXml('https://example.test')
    expect(xml).not.toContain('/demo<')
    expect(xml).not.toMatch(/<loc>[^<]*\/demo</)
    expect(xml).not.toContain('/demo.md')
  })

  it('is absent from the generated robots.txt', () => {
    const robots = buildRobotsTxt('https://example.test')
    expect(robots).not.toContain('/demo')
  })

  it('is absent from public/llms.txt and public/llms-full.txt', () => {
    for (const name of ['llms.txt', 'llms-full.txt']) {
      const text = read(`public/${name}`)
      expect(text, name).not.toContain('/demo')
    }
  })

  it('is absent from public/for-agents.md (the runbook /demo.md deliberately overrides, not vice versa)', () => {
    expect(read('public/for-agents.md')).not.toContain('/demo')
  })

  it('is absent from the site header and footer source', () => {
    for (const component of ['src/components/marketing/site/Header.tsx', 'src/components/marketing/site/Footer.tsx']) {
      expect(read(component), component).not.toContain('/demo')
    }
  })

  // #3573: the site's header, footer, section components and page bodies all
  // live under components/marketing/. Every source file in the tree is read,
  // so a new file cannot carry a /demo link past the two named above.
  it('is absent from every source file under components/marketing/', () => {
    const files = readdirSync(join(FRONTEND_ROOT, 'src/components/marketing'), { recursive: true })
      .map(String)
      .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.includes('__tests__'))
    expect(files, 'the sweep found the header it must cover').toContain(join('site', 'Header.tsx'))
    expect(files, 'the sweep found the redesigned footer it must cover').toContain(join('site', 'Footer.tsx'))
    for (const name of files) {
      const path = `src/components/marketing/${name}`
      expect(read(path), path).not.toContain('/demo')
    }
  })
})
