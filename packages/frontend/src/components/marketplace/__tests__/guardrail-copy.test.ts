import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The marketplace's copy ceiling (#3079 acceptance; epic #3077 decision 5):
 * a merchant page describes what an agent can PAY FOR, never a relationship.
 * The five guardrail words are banned from every marketplace source — copy,
 * comments and fixtures alike, since a comment is the next author's template.
 * `lint:copy` cannot carry this: a global ban would hit unrelated files, so
 * the ban is scoped here to the surfaces that could publish a prospect.
 */
const GUARDRAIL = /\b(partner|customer|integration|planned|pilot)s?\b/i

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SCOPE = [
  'components/marketplace',
  'app/(authenticated)/marketplace',
  'lib/marketplace.ts',
]

function sources(entry: string): string[] {
  const full = path.join(root, entry)
  if (statSync(full).isFile()) return [full]
  return readdirSync(full, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(full, d.name)
    if (d.isDirectory()) return sources(path.relative(root, p))
    return /\.(ts|tsx)$/.test(d.name) && !/guardrail-copy\.test\.ts$/.test(d.name) ? [p] : []
  })
}

describe('marketplace copy guardrail', () => {
  it('scans a non-empty set of marketplace sources', () => {
    const files = SCOPE.flatMap(sources)
    expect(files.length).toBeGreaterThan(8)
  })

  it('uses none of the five guardrail words anywhere in the marketplace sources', () => {
    const hits: string[] = []
    for (const file of SCOPE.flatMap(sources)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = GUARDRAIL.exec(line)
        if (m) hits.push(`${path.relative(root, file)}:${i + 1}: "${m[0]}"`)
      })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})
