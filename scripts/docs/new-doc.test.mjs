// Unit tests for the docs:new scaffolder.
// Run with: node --test scripts/docs/  (or `npm run docs:test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inferStatus,
  titleFromPath,
  todayIso,
  buildDoc,
  createDoc,
  parseArgs,
} from './new-doc.mjs'
import { parseFrontMatter } from './validate-frontmatter.mjs'

test('inferStatus derives status from the path', () => {
  assert.equal(inferStatus('docs/archive/old.md'), 'archived')
  assert.equal(inferStatus('docs/research/idea.md'), 'research')
  assert.equal(inferStatus('docs/operations/thing.md'), 'current')
  assert.equal(inferStatus('README.md'), 'current')
})

test('titleFromPath title-cases the file stem', () => {
  assert.equal(titleFromPath('docs/operations/new-thing.md'), 'New Thing')
  assert.equal(titleFromPath('docs/a/my_cool_doc.md'), 'My Cool Doc')
  assert.equal(titleFromPath('CLAUDE.md'), 'CLAUDE')
})

test('todayIso formats as YYYY-MM-DD', () => {
  assert.equal(todayIso(new Date(2026, 6, 1)), '2026-07-01')
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/)
})

test('buildDoc emits front-matter that passes the validator', () => {
  const doc = buildDoc({ relPath: 'docs/operations/new-thing.md', today: '2026-07-01' })
  const parsed = parseFrontMatter(doc)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.owner, '@d-hinders')
  assert.equal(parsed.data.status, 'current')
  assert.deepEqual(parsed.data.covers, [])
  assert.equal(parsed.data['last-verified'], '2026-07-01')
  assert.match(doc, /^# New Thing$/m)
})

test('buildDoc respects --owner, --title, and inferred archived status', () => {
  const doc = buildDoc({
    relPath: 'docs/archive/legacy.md',
    owner: '@someone',
    title: 'Legacy Notes',
    today: '2026-07-01',
  })
  const parsed = parseFrontMatter(doc)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.owner, '@someone')
  assert.equal(parsed.data.status, 'archived')
  assert.match(doc, /^# Legacy Notes$/m)
})

test('buildDoc falls back to defaults on empty owner/title (regression: SF-1)', () => {
  const doc = buildDoc({
    relPath: 'docs/operations/thing.md',
    owner: '',
    title: '  ',
    today: '2026-07-01',
  })
  const parsed = parseFrontMatter(doc)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.owner, '@d-hinders')
  assert.match(doc, /^# Thing$/m)
})

test('createDoc writes the file and returns its repo-relative path', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'docs-new-'))
  const rel = await createDoc({
    inputPath: 'docs/operations/created.md',
    today: '2026-07-01',
    repoRoot,
  })
  assert.equal(rel, 'docs/operations/created.md')
  const written = await readFile(join(repoRoot, rel), 'utf8')
  assert.equal(parseFrontMatter(written).ok, true)
})

test('createDoc refuses to overwrite an existing file', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'docs-new-'))
  await mkdir(join(repoRoot, 'docs'), { recursive: true })
  await writeFile(join(repoRoot, 'docs/exists.md'), 'original\n')
  await assert.rejects(
    createDoc({ inputPath: 'docs/exists.md', repoRoot }),
    /refusing to overwrite/,
  )
  // The original content must be untouched.
  assert.equal(await readFile(join(repoRoot, 'docs/exists.md'), 'utf8'), 'original\n')
})

test('createDoc rejects a non-Markdown target', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'docs-new-'))
  await assert.rejects(createDoc({ inputPath: 'docs/thing.txt', repoRoot }), /Markdown file/)
})

test('createDoc rejects a path escaping the repo', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'docs-new-'))
  await assert.rejects(createDoc({ inputPath: '../outside.md', repoRoot }), /inside the repository/)
})

test('createDoc requires a target path', async () => {
  await assert.rejects(createDoc({}), /target path is required/)
})

test('parseArgs reads the path and flags in any order', () => {
  assert.deepEqual(parseArgs(['docs/a.md', '--owner', '@x', '--title', 'Hi']), {
    inputPath: 'docs/a.md',
    owner: '@x',
    title: 'Hi',
  })
  assert.deepEqual(parseArgs(['--owner=@y', 'docs/b.md']), {
    owner: '@y',
    inputPath: 'docs/b.md',
  })
})
