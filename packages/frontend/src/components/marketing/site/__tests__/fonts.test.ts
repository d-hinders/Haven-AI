import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The `SITE_FONT_VARIABLES` roots (#4631).
 *
 * `docs/product/design-system.md` § *Type roles (`SITE_TYPE`)* states an
 * exhaustive set: the public site's two added faces exist only below an element
 * carrying `SITE_FONT_VARIABLES`, every new-site root carries it, and so does
 * the auth shell — nothing else may. That sentence cites this test, so the set
 * is pinned as a set equality rather than described: a sixth root cannot appear
 * without this list moving, and a root cannot disappear without the doc's
 * sentence going stale.
 *
 * The definition in `site/fonts.ts` is excluded — it is the constant, not a
 * carrier. Test files are excluded too: this file names the constant, and a
 * test is not a rendered root.
 */

const SRC = join(__dirname, '../../../..')
const DEFINITION = 'components/marketing/site/fonts.ts'
const ROOTS = ['AuthShell', 'Footer', 'Header', 'SiteSection', 'blocks']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
  return out
}

/** The component names whose source carries the constant, sorted. */
function carriers(): string[] {
  return sourceFiles(SRC)
    .filter((file) => readFileSync(file, 'utf8').includes('SITE_FONT_VARIABLES'))
    .map((file) => relative(SRC, file).split(sep).join('/'))
    .filter((rel) => rel !== DEFINITION)
    .map((rel) => rel.split('/').pop()!.replace(/\.tsx?$/, ''))
    .sort()
}

describe('SITE_FONT_VARIABLES roots', () => {
  it('is exactly the five elements the design-system doc names', () => {
    expect(carriers()).toEqual([...ROOTS].sort())
  })

  it('positive control: the walk reaches the tree and finds the definition', () => {
    // A walk that returned nothing would pass the set equality above only if
    // ROOTS were empty; this proves the instrument reads real files.
    expect(sourceFiles(SRC).length).toBeGreaterThan(100)
    expect(readFileSync(join(SRC, DEFINITION), 'utf8')).toContain('export const SITE_FONT_VARIABLES')
  })
})
