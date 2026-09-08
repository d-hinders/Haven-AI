// #2680 slice-2 guard — pins docs-quality-system.md § Docs served to agents':
// "There is still exactly one editable copy, and it is the source."
// The falsifiable core is the tracked-file census: a SECOND editable copy
// comes into existence exactly when a file lands under
// `packages/frontend/public/docs/` in git. The copy side is already guarded by
// served-docs.test.ts ("the generated output is gitignored" pins the
// .gitignore entry); this pins the consequence — the directory holds no
// tracked file — so a committed copy reddens even if someone deletes the
// gitignore line and commits in the same edit.
//
// Mutation-proven for #2680: `git add -f` a scratch file under public/docs/
// reddens the census; restoring the index turns it green.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

describe('served docs single-copy census (#2680 pin)', () => {
  it('no tracked file under packages/frontend/public/docs/', () => {
    let out = ''
    try {
      out = execFileSync('git', ['ls-files', 'packages/frontend/public/docs/'], {
        cwd: REPO,
        encoding: 'utf8',
      })
    } catch {
      out = ''
    }
    const tracked = out.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(tracked).toEqual([])
  })
})
