import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOWLIST,
  SERVED_PREFIX,
  REPO_ROOT,
  OUT_DIR,
  renderServedDoc,
  rewriteLinks,
  splitFrontMatter,
  readStatus,
  readLastVerified,
  generate,
} from '../../../scripts/serve-docs.mjs'
import { PUBLIC_SURFACES } from '@/lib/discovery-surfaces'

/**
 * Guard for the served product docs (#2532, A5).
 *
 * `llms.txt` pointed at `docs.haven.xyz` (a host nobody owns), then at the
 * public GitHub repo as a stated placeholder. These paths retire the
 * placeholder, and the generator is what keeps the served copy from becoming a
 * second, silently-stale home for the product docs.
 */

const FRONTEND = join(__dirname, '../../..')

function source(entry: { source: string }): string {
  return readFileSync(join(REPO_ROOT, entry.source), 'utf8')
}

describe('the generated docs match their sources', () => {
  it('generates every allowlisted doc', () => {
    const written = generate()
    expect(written).toEqual(ALLOWLIST.map((e) => `${SERVED_PREFIX}/${e.served}`))
    for (const entry of ALLOWLIST) {
      expect(existsSync(join(OUT_DIR, entry.served)), entry.served).toBe(true)
    }
  })

  it.each(ALLOWLIST)('$served is its source, minus front matter, plus a header', (entry) => {
    const raw = source(entry)
    const served = renderServedDoc(raw, entry.source)
    const { frontMatter, body } = splitFrontMatter(raw, entry.source)

    // The front matter is addressed to contributors and carries the whole
    // chained verification note. None of it is served.
    expect(served).not.toContain('last-verified:')
    expect(served).not.toContain('covers:')
    expect(served.startsWith(`Source: ${entry.source}, last-verified ${readLastVerified(frontMatter)}.`)).toBe(true)

    // The body IS the source's body — only its relative links are rewritten.
    // Asserting equality against the rewritten body rather than the raw one
    // states the deviation instead of hiding it: see the link test below.
    expect(served.slice(served.indexOf('\n\n') + 2)).toBe(rewriteLinks(body, entry.source).replace(/^\n+/, ''))
  })

  it('carries no relative link that would 404 on this origin', () => {
    // The reason the copy is not byte-identical. Each source links to siblings
    // by relative path and most of those targets are NOT served — copying
    // verbatim would publish `](../regulatory/casp-risk-guardrails.md)` to an
    // agent, which resolves against this origin and 404s. That is exactly the
    // defect #2520 removed from these artifacts.
    for (const entry of ALLOWLIST) {
      const served = renderServedDoc(source(entry), entry.source)
      const targets = [...served.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1])
      const relative = targets.filter((t) => !/^(https?:|mailto:|#|\/)/i.test(t))
      expect(relative, `${entry.served} has unresolvable relative links`).toEqual([])
    }
  })

  it('rewrites a link to another served doc as a served path, not a repo url', () => {
    const served = renderServedDoc(source(ALLOWLIST[0]), ALLOWLIST[0].source)
    expect(served).toContain('](/docs/agent-key-rotation.md)')
    expect(served).not.toContain('](agent-key-rotation.md)')
  })

  it('positive control: the rewriter can still say "repository"', () => {
    // If everything resolved to a served path, the repo-url arm would be dead
    // code and the assertion above would prove nothing about it.
    const rewritten = rewriteLinks('see [guidelines](copy-guidelines.md)', 'docs/product/account-recovery.md')
    expect(rewritten).toContain('https://github.com/d-hinders/Haven-AI/blob/dev/docs/product/copy-guidelines.md')
  })

  it('leaves absolute urls and anchors alone', () => {
    const input = 'a [x](https://example.com/y) b [z](#section) c [w](/402.md)'
    expect(rewriteLinks(input, 'docs/product/account-recovery.md')).toBe(input)
  })
})

describe('the allowlist is the control', () => {
  it('refuses a doc whose status is not current', () => {
    const raw = ['---', 'owner: "@d-hinders"', 'status: superseded', 'last-verified: "2026-09-04"', '---', '', '# Body'].join('\n')
    expect(() => renderServedDoc(raw, 'docs/product/example.md')).toThrow(/status is superseded, not "current"/)
  })

  it('refuses a doc with no front matter at all', () => {
    expect(() => renderServedDoc('# Just a body\n', 'docs/product/example.md')).toThrow(/no front matter/)
  })

  it('refuses a doc with no last-verified date to stamp', () => {
    const raw = ['---', 'owner: "@d-hinders"', 'status: current', '---', '', '# Body'].join('\n')
    expect(() => renderServedDoc(raw, 'docs/product/example.md')).toThrow(/no last-verified date/)
  })

  it('positive control: a current doc with a date is accepted', () => {
    const raw = ['---', 'owner: "@d-hinders"', 'status: current', 'last-verified: "2026-09-04" # note', '---', '', '# Body'].join('\n')
    expect(renderServedDoc(raw, 'docs/product/example.md')).toContain('last-verified 2026-09-04')
  })

  it('serves nothing from contributing or operations', () => {
    // Those are addressed to people who work on Haven and carry internal URLs
    // and operator state. The allowlist is what keeps them off this origin.
    for (const entry of ALLOWLIST) {
      expect(entry.source).not.toMatch(/^docs\/(contributing|operations)\//)
    }
  })

  it('reads the real status and date out of a real source', () => {
    const { frontMatter } = splitFrontMatter(source(ALLOWLIST[0]), ALLOWLIST[0].source)
    expect(readStatus(frontMatter)).toBe('current')
    expect(readLastVerified(frontMatter)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('the served paths are advertised', () => {
  it('every served doc is in the sitemap surfaces', () => {
    for (const entry of ALLOWLIST) {
      expect(PUBLIC_SURFACES).toContain(`${SERVED_PREFIX}/${entry.served}`)
    }
  })

  it('every served doc is listed in llms.txt', () => {
    const llms = readFileSync(join(FRONTEND, 'public/llms.txt'), 'utf8')
    expect(llms).toContain('## Docs')
    for (const entry of ALLOWLIST) {
      expect(llms, entry.served).toContain(`(${SERVED_PREFIX}/${entry.served})`)
    }
  })

  it('the middleware observes the served docs', () => {
    expect(readFileSync(join(FRONTEND, 'src/middleware.ts'), 'utf8')).toContain("'/docs/:path*'")
  })

  it('the build actually runs the generator', () => {
    // Nothing else guarantees the files exist in a deployment. Without this,
    // a change to how the frontend is built would 404 every path above with
    // no test noticing.
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'))
    expect(pkg.scripts.prebuild).toBe('node scripts/serve-docs.mjs')
    expect(pkg.scripts.build).toContain('next build')
  })

  it('the generated output is gitignored', () => {
    // A committed copy is a second home that goes stale silently.
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(ignore).toContain('packages/frontend/public/docs/')
  })
})
