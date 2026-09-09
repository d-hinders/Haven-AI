import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ARCHIVE, extractVerifiedBlock, parseArchive, renderArchive, stripVerifiedBlock } from './retire-verified-chains.mjs'

const raw = '---\nowner: "@x"\nstatus: current\ncovers: []  # narrative\nlast-verified: "2026-09-08"\nverified:\n  - "#10: first \\"quoted\\" claim"\n  - "#9: second claim"\n---\n\n# Example\n'

test('#2681: archive keeps the raw verified block byte-for-byte', () => {
  const found = extractVerifiedBlock(raw)
  assert.ok(found)
  const archive = renderArchive([{ path: 'docs/example.md', block: found.block }])
  const [archived] = parseArchive(archive)
  assert.equal(archived.block, found.block)
  assert.deepEqual(stripVerifiedBlock(raw), {
    text: '---\nowner: "@x"\nstatus: current\ncovers: []  # narrative\nlast-verified: "2026-09-08"\n---\n\n# Example\n',
    block: found.block,
  })
})

test('#2681: checked-in archive has every hash and no live verified block', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  assert.equal(parseArchive(readFileSync(`${root}${ARCHIVE}`, 'utf8')).length, 79)
  assert.doesNotThrow(() => execFileSync(process.execPath, ['scripts/docs/retire-verified-chains.mjs'], {
    cwd: root,
    stdio: 'pipe',
  }))
})
