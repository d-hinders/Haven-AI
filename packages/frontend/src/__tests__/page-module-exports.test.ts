/**
 * A Next.js `page.tsx` may export ONLY `default` plus the route conventions
 * (#2106).
 *
 * This guard exists because the repo had no local signal for it. `npm run
 * typecheck` (`tsc --noEmit`) passed green while `next build` failed:
 *
 *     Type error: Page "src/app/(authenticated)/custody/page.tsx" does not
 *     match the required types of a Next.js Page.
 *
 * The constraint lives in Next's GENERATED route types, not in the app's own
 * tsconfig graph, so the only thing that catches it locally is a full
 * production build — two and a half minutes, and not something anyone runs
 * before pushing a one-line helper. The failure reached CI instead.
 *
 * A named export on a page is an easy and natural mistake: you want a
 * predicate the tests can assert against without re-implementing it, the
 * predicate obviously belongs next to the component that uses it, and
 * everything downstream of `tsc` agrees. This is a lint-shaped rule, so it is
 * enforced as one — statically, over the source text, in milliseconds.
 *
 * Scoped to `page.tsx` deliberately. `layout.tsx` and `route.ts` have their own
 * (different) allowed sets; widening this guard to them without checking those
 * sets would trade a false negative for a false positive.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/**
 * Route-convention exports Next itself defines for a page module. Anything
 * outside this set is what the build rejects.
 *
 * Kept deliberately short rather than exhaustive: a page in this app exports
 * `default` and nothing else today, so a NEW name here should be a considered
 * addition with the Next docs open, not a reflex to make a red test green.
 */
const ALLOWED = new Set([
  'default',
  'metadata',
  'generateMetadata',
  'generateStaticParams',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'viewport',
  'generateViewport',
  'experimental_ppr',
])

function pageFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', 'src/app/**/page.tsx', 'src/app/**/page.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  return out.split('\n').filter(Boolean)
}

/** Exported NAMES declared in a module's source, by declaration shape. */
function exportedNames(source: string): string[] {
  const names: string[] = []
  // `export default …`
  if (/^export\s+default\s/m.test(source)) names.push('default')
  // `export function f`, `export async function f`, `export const x`,
  // `export class C`, `export type T`, `export interface I`, `export enum E`
  const decl =
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm
  for (const m of source.matchAll(decl)) names.push(m[1])
  // `export { a, b as c }`
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.includes(' as ') ? part.split(' as ')[1] : part
      const name = alias.trim()
      if (name) names.push(name)
    }
  }
  return names
}

describe('Next page modules export only route conventions (#2106)', () => {
  const files = pageFiles()

  it('finds the page modules to check — an empty sweep would prove nothing', () => {
    // The guard's own floor. A glob that silently matched zero files would
    // pass forever while checking nothing, which is the failure mode this
    // repo keeps finding in its own guards.
    expect(files.length).toBeGreaterThan(5)
    expect(files).toContain('src/app/(authenticated)/custody/page.tsx')
  })

  it.each(files)('%s exports nothing Next will reject', (file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    const offending = exportedNames(source).filter((n) => !ALLOWED.has(n))
    expect(
      offending,
      `${file} exports ${offending.join(', ')} — Next type-checks the page MODULE and ` +
        'rejects arbitrary named exports. Move shared helpers to `lib/` or a ' +
        'colocated non-page file. `tsc --noEmit` will NOT catch this; `next build` will.',
    ).toEqual([])
  })
})
