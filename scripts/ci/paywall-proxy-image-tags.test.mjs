/**
 * The paywall proxy image's publishing rule (#5007).
 *
 * Two halves, because the rule has two halves:
 *
 *   1. THE TAG COMPUTATION refuses a channel/tag pair the rule does not allow.
 *      `dev` may move only `dev` and `dev-<short-sha>`; `main` may move only
 *      `pilot` and `pilot-<short-sha>`; nothing may move `latest`. Reverting the
 *      refusal turns these red — that is the point of testing it rather than
 *      describing it in a comment.
 *
 *   2. THE WORKFLOW'S STRUCTURE puts the `pilot` push in its own `main`-only job
 *      and gates every job on the upstream repository. `packages: write` lets any
 *      run push any tag, so the token cannot carry the rule; the structure and
 *      the refusal do.
 *
 * Plus the perimeter: the workflow and this script (#5022) are `controlGlobs`,
 * so a PR weakening either gets the money-path label and a human read.
 * `scripts/ci/money-path.test.mjs` holds the four copies equal; this file pins
 * that both paths are in them, so a later edit cannot quietly drop one from
 * every copy at once.
 *
 * Run with: node --test scripts/ci/paywall-proxy-image-tags.test.mjs
 * (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHANNEL_TAGS,
  FORBIDDEN_TAGS,
  IMAGE,
  TagRefusal,
  assertTagAllowed,
  channelForRef,
  imageTags,
  imageRefs,
  parseArgs,
  shortSha,
} from './paywall-proxy-image-tags.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

const WORKFLOW_PATH = '.github/workflows/publish-paywall-proxy-image.yml'
const workflow = read(WORKFLOW_PATH)
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const CLI = path.join(ROOT, 'scripts', 'ci', 'paywall-proxy-image-tags.mjs')
const SCRIPT_PATH = 'scripts/ci/paywall-proxy-image-tags.mjs'
const PERIMETER = [WORKFLOW_PATH, SCRIPT_PATH]

describe('the tag rule', () => {
  test('a push to dev publishes dev-<short-sha> and moves dev', () => {
    assert.deepEqual(imageTags('refs/heads/dev', SHA), ['dev-a1b2c3d', 'dev'])
  })

  test('a push to main publishes pilot-<short-sha> and moves pilot', () => {
    assert.deepEqual(imageTags('refs/heads/main', SHA), ['pilot-a1b2c3d', 'pilot'])
  })

  test('nothing ever publishes latest', () => {
    for (const ref of ['refs/heads/dev', 'refs/heads/main']) {
      for (const tag of imageTags(ref, SHA)) {
        assert.ok(!FORBIDDEN_TAGS.includes(tag), `${ref} produced the forbidden tag '${tag}'`)
        assert.ok(!tag.startsWith('latest'), `${ref} produced a latest-prefixed tag '${tag}'`)
      }
    }
  })

  test('dev never moves pilot, and main never moves dev', () => {
    assert.throws(() => assertTagAllowed('dev', 'pilot'), TagRefusal)
    assert.throws(() => assertTagAllowed('dev', 'pilot-a1b2c3d'), TagRefusal)
    assert.throws(() => assertTagAllowed('main', 'dev'), TagRefusal)
    assert.throws(() => assertTagAllowed('main', 'dev-a1b2c3d'), TagRefusal)
  })

  test('latest is refused on every channel', () => {
    for (const channel of ['dev', 'main']) {
      assert.throws(() => assertTagAllowed(channel, 'latest'), TagRefusal)
      assert.throws(() => assertTagAllowed(channel, 'latest-a1b2c3d'), TagRefusal)
    }
  })

  test('an unknown channel is refused', () => {
    assert.throws(() => assertTagAllowed('prod', 'pilot'), TagRefusal)
    assert.throws(() => assertTagAllowed('', 'dev'), TagRefusal)
  })

  test('the allowed pairs are exactly the rule', () => {
    assert.doesNotThrow(() => assertTagAllowed('dev', 'dev'))
    assert.doesNotThrow(() => assertTagAllowed('dev', 'dev-a1b2c3d'))
    assert.doesNotThrow(() => assertTagAllowed('main', 'pilot'))
    assert.doesNotThrow(() => assertTagAllowed('main', 'pilot-a1b2c3d'))
  })

  test('only dev and main publish, and only from their own ref', () => {
    assert.equal(channelForRef('refs/heads/dev'), 'dev')
    assert.equal(channelForRef('refs/heads/main'), 'main')
    for (const ref of ['refs/heads/feature/x', 'refs/tags/v1.0.0', 'refs/heads/dev2', '']) {
      assert.throws(() => channelForRef(ref), TagRefusal, `${ref} should not publish`)
    }
  })

  test('the short sha is seven hex characters, and a bad sha is refused', () => {
    assert.equal(shortSha(SHA), 'a1b2c3d')
    assert.equal(shortSha('a1b2c3d'), 'a1b2c3d')
    // git SHAs are lowercase; an uppercase one is normalised rather than
    // producing a tag with capitals in it.
    assert.equal(shortSha('A1B2C3D'), 'a1b2c3d')
    for (const bad of ['', 'xyz', 'a1b2c3', 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789', 'a1b2c3g']) {
      assert.throws(() => shortSha(bad), TagRefusal, `'${bad}' should be refused`)
    }
  })

  test('parseArgs reads --ref and --sha, and refuses anything else', () => {
    assert.deepEqual(parseArgs(['--ref', 'refs/heads/dev', '--sha', SHA]), { ref: 'refs/heads/dev', sha: SHA })
    assert.throws(() => parseArgs(['--ref', 'refs/heads/dev']), TagRefusal)
    assert.throws(() => parseArgs(['--sha', SHA]), TagRefusal)
    assert.throws(() => parseArgs(['--ref']), TagRefusal)
    assert.throws(() => parseArgs(['--nope', 'x']), TagRefusal)
  })

  // #5022: the workflow hands this CLI's stdout to docker/build-push-action as
  // `tags:`, which reads each line as an image REFERENCE. A bare `dev-<sha>`
  // named `docker.io/library/dev-<sha>`, and every publish failed on Docker
  // Hub auth. So the test runs the real CLI and pins every printed line.
  test('the CLI prints full image references, one per line, for each channel (#5022)', () => {
    const run = (ref) =>
      spawnSync(process.execPath, [CLI, '--ref', ref, '--sha', SHA], { encoding: 'utf8' })
    const dev = run('refs/heads/dev')
    assert.equal(dev.status, 0, dev.stderr)
    assert.deepEqual(dev.stdout.trim().split('\n'), [
      'ghcr.io/d-hinders/haven-paywall-proxy:dev-a1b2c3d',
      'ghcr.io/d-hinders/haven-paywall-proxy:dev',
    ])
    const main = run('refs/heads/main')
    assert.equal(main.status, 0, main.stderr)
    assert.deepEqual(main.stdout.trim().split('\n'), [
      'ghcr.io/d-hinders/haven-paywall-proxy:pilot-a1b2c3d',
      'ghcr.io/d-hinders/haven-paywall-proxy:pilot',
    ])
    assert.deepEqual(imageRefs('refs/heads/dev', SHA), dev.stdout.trim().split('\n'))
  })

  test('the CLI refuses a ref that publishes nothing with a GUARD line and no stdout', () => {
    const refused = spawnSync(process.execPath, [CLI, '--ref', 'refs/heads/feature', '--sha', SHA], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.equal(refused.stdout, '')
    assert.match(refused.stderr, /^GUARD: refusing to publish from ref 'refs\/heads\/feature'/)
  })

  test('the registry path is the one the owner accepted', () => {
    assert.equal(IMAGE, 'ghcr.io/d-hinders/haven-paywall-proxy')
    assert.deepEqual(CHANNEL_TAGS, { dev: 'dev', main: 'pilot' })
  })
})

/** The workflow's jobs, as `name → lines`, read without a YAML dependency. */
function jobBlocks(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  assert.notEqual(start, -1, `${WORKFLOW_PATH} has no top-level \`jobs:\` key`)
  const blocks = new Map()
  let current = null
  for (const line of lines.slice(start + 1)) {
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (key) {
      current = key[1]
      blocks.set(current, [])
      continue
    }
    if (/^\S/.test(line)) break
    if (current !== null) blocks.get(current).push(line)
  }
  return blocks
}

describe('the workflow structure', () => {
  const jobs = jobBlocks(workflow)

  test('there is a dev job and a pilot job', () => {
    assert.deepEqual([...jobs.keys()].sort(), ['dev', 'pilot'])
  })

  test('every job is gated on the upstream repository', () => {
    for (const [name, lines] of jobs) {
      assert.match(
        lines.join('\n'),
        /if: github\.repository == 'd-hinders\/Haven-AI'/,
        `the '${name}' job must carry the repository gate`,
      )
    }
  })

  test('the pilot push lives in its own main-only job', () => {
    const pilot = jobs.get('pilot').join('\n')
    assert.match(pilot, /if: .*github\.ref == 'refs\/heads\/main'/, 'the pilot job must be main-only')
    assert.doesNotMatch(pilot, /refs\/heads\/dev/, 'the pilot job must not run on dev')
    const dev = jobs.get('dev').join('\n')
    assert.doesNotMatch(dev, /refs\/heads\/main/, 'the dev job must not run on main')
  })

  test('both jobs compute their tags through the refusing script', () => {
    for (const [name, lines] of jobs) {
      assert.match(
        lines.join('\n'),
        /node scripts\/ci\/paywall-proxy-image-tags\.mjs --ref "\$REF" --sha "\$SHA"/,
        `the '${name}' job must compute its tags through the script, not by hand`,
      )
    }
  })

  test('both jobs build the package Dockerfile from the repository root and push', () => {
    for (const [name, lines] of jobs) {
      const block = lines.join('\n')
      assert.match(block, /file: packages\/paywall-proxy\/Dockerfile/, `the '${name}' job must build the package Dockerfile`)
      assert.match(block, /context: \./, `the '${name}' job must build from the repository root`)
      assert.match(block, /push: true/, `the '${name}' job must push`)
    }
  })

  test('the workflow holds packages: write and nothing wider', () => {
    assert.match(workflow, /permissions:\n {2}contents: read\n {2}packages: write/)
  })

  test('it runs on pushes to dev and main that touch the kit', () => {
    const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'))
    assert.match(on, /branches: \[dev, main\]/)
    for (const p of [
      'packages/paywall-proxy/**',
      'packages/merchant-payments/**',
      'packages/sdk/**',
      'package-lock.json',
      '.github/workflows/publish-paywall-proxy-image.yml',
      'scripts/ci/paywall-proxy-image-tags.mjs',
    ]) {
      assert.ok(on.includes(`'${p}'`), `the push paths must include '${p}'`)
    }
  })

  test('publish.yml is unchanged: no image push, no packages: write', () => {
    const publish = read('.github/workflows/publish.yml')
    assert.doesNotMatch(publish, /ghcr\.io/, 'publish.yml must not push a container image')
    assert.doesNotMatch(publish, /packages: write/, 'publish.yml must not hold packages: write')
    assert.doesNotMatch(publish, /publish-paywall-proxy-image/, 'publish.yml must not call the image workflow')
  })
})

describe('the money-path perimeter', () => {
  test('the workflow and the tag script are control globs in the single source of truth', () => {
    const json = JSON.parse(read('.github/money-path-globs.json'))
    for (const p of PERIMETER) {
      assert.ok(json.controlGlobs.includes(p), `${p} must be in controlGlobs: it decides which image is pushed`)
      assert.ok(!json.globs.includes(p), `${p} is control, not runtime: no QA run exercises it`)
    }
  })

  test('the workflow and the tag script are in labeler.yml money-path list', () => {
    const lines = read('.github/labeler.yml').split('\n')
    const start = lines.findIndex((line) => /^["']?money-path["']?:/.test(line))
    assert.notEqual(start, -1, 'labeler.yml has no `money-path:` key')
    const listed = []
    let inList = false
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break
      if (/any-glob-to-any-file:/.test(line)) {
        inList = true
        continue
      }
      if (!inList) continue
      const m = line.match(/^\s*-\s*(?:["']?)([^"'\s]+)(?:["']?)\s*$/)
      if (m) listed.push(m[1])
      else if (line.trim() && !line.trim().startsWith('#')) break
    }
    for (const p of PERIMETER) assert.ok(listed.includes(p), `${p} must be in labeler.yml's money-path list`)
  })

  test('the workflow and the tag script are in the annotated perimeter twin, under the control heading', () => {
    const text = read('.agents/skills/ship-next/references/money-path-perimeter.md')
    const controlAt = text.indexOf('## Control surface: `controlGlobs`')
    assert.notEqual(controlAt, -1, 'the perimeter doc has no control heading')
    const control = text.slice(controlAt)
    for (const p of PERIMETER) {
      assert.ok(
        control.split('\n').includes(`- \`${p}\``),
        `${p} must be an entry under the control heading, exactly as the JSON writes it`,
      )
    }
  })
})
