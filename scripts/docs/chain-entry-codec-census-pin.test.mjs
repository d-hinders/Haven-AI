// #2680 slice-2 guard — pins docs-quality-system.md § last-verified chain's
// claim that `quoteEntry`/`unquoteEntry` in `validate-frontmatter.mjs` are "the
// only writer and reader" of the quoted YAML-entry encoding, "so the two
// cannot drift apart". Pinned by a site census: the definition module plus its
// one sanctioned consumer, nothing else — so a second, hand-rolled
// encoder/decoder of the entry encoding cannot appear silently.
//
// Mutation-proven for #2680: adding an import of quoteEntry in a scratch
// module reddens; restoring byte-identical greens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DOCS = dirname(fileURLToPath(import.meta.url))
const REPO = join(SCRIPTS_DOCS, '..', '..')

test('quoteEntry/unquoteEntry are the only writer and reader of the entry encoding (#2680 pin)', () => {
  let out = ''
  try {
    out = execFileSync(
      'grep',
      [
        '-rln',
        '--include=*.mjs',
        '--include=*.ts',
        '--exclude-dir=node_modules',
        '--exclude=*.test.*',
        'quoteEntry',
        join(REPO, 'scripts'),
        join(REPO, 'packages'),
      ],
      { encoding: 'utf8' },
    )
  } catch {
    // grep exits 1 on zero matches; an empty census would mean the encoder
    // itself vanished, and the deepEqual below says so.
    out = ''
  }
  const sites = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => p.replace(REPO + '/', ''))
  assert.deepEqual(sites.sort(), [
    'scripts/docs/migrate-chain-to-list.mjs',
    'scripts/docs/validate-frontmatter.mjs',
  ])
})
