#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs'
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsRoot = join(repoRoot, '.agents', 'skills')
const copyMarkerName = '.haven-agent-skill-source.json'
const copyMarkerRepo = 'd-hinders/Haven-AI'
const copyMarkerVersion = 1

const args = new Set(process.argv.slice(2))
const copyMode = args.has('--copy')
const dryRun = args.has('--dry-run')
const checkOnly = args.has('--check')
const codexOnly = args.has('--codex')
const claudeOnly = args.has('--claude')
const listOnly = args.has('--list')

if (codexOnly && claudeOnly) {
  fail('Choose at most one of --codex or --claude.')
}

const targets = []
if (!claudeOnly) {
  targets.push({
    name: 'Codex',
    dir: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills'),
  })
}
if (!codexOnly) {
  targets.push({
    name: 'Claude',
    dir: join(homedir(), '.claude', 'skills'),
  })
}

const skills = await discoverSkills()
if (listOnly) {
  for (const skill of skills) console.log(skill.name)
  process.exit(0)
}

for (const skill of skills) validateSkill(skill)
for (const skill of skills) await validateSkillFile(skill)

if (checkOnly) {
  console.log(`Validated ${skills.length} skill folder(s) in ${relative(skillsRoot)}.`)
  process.exit(0)
}

for (const target of targets) {
  if (!dryRun) await mkdir(target.dir, { recursive: true })
  for (const skill of skills) {
    await installSkill(skill, target)
  }
}

const mode = copyMode ? 'copied' : 'linked'
const action = dryRun ? `Would ${mode}` : mode
console.log(`${action} ${skills.length} skill folder(s) into ${targets.map((target) => target.dir).join(', ')}.`)

async function discoverSkills() {
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(skillsRoot, entry.name),
      skillPath: join(skillsRoot, entry.name, 'SKILL.md'),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  if (dirs.length === 0) fail(`No skills found in ${relative(skillsRoot)}.`)
  return dirs
}

function validateSkill(skill) {
  if (!/^[a-z0-9-]+$/.test(skill.name)) {
    fail(`${relative(skill.path)}: skill folder must use lowercase letters, digits, and hyphens.`)
  }
}

async function validateSkillFile(skill) {
  const text = await readFile(skill.skillPath, 'utf8').catch((error) => {
    fail(`${relative(skill.path)}: missing SKILL.md (${error.message}).`)
  })
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) fail(`${relative(skill.skillPath)}: missing YAML frontmatter.`)

  const name = findYamlString(match[1], 'name')
  const description = findYamlString(match[1], 'description')
  if (!name) fail(`${relative(skill.skillPath)}: missing frontmatter name.`)
  if (!description) fail(`${relative(skill.skillPath)}: missing frontmatter description.`)
  if (name !== skill.name) {
    fail(`${relative(skill.skillPath)}: frontmatter name "${name}" must match folder "${skill.name}".`)
  }
}

async function installSkill(skill, target) {
  const dest = join(target.dir, skill.name)
  const existing = await lstat(dest).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })

  if (existing) {
    const ok = await ownedByRepo(existing, dest, skill.path)
    if (!ok) {
      fail(`${target.name} target already exists and is not this repo skill: ${dest}`)
    }
    if (!dryRun) await rm(dest, { recursive: true, force: true })
  }

  if (dryRun) {
    console.log(`${target.name}: ${copyMode ? 'copy' : 'link'} ${relative(skill.path)} -> ${dest}`)
    return
  }

  if (copyMode) {
    await cp(skill.path, dest, { recursive: true, force: true })
    await writeCopyMarker(dest, skill)
  } else {
    await symlink(skill.path, dest, 'dir')
  }
}

async function ownedByRepo(existing, dest, source) {
  if (existing.isSymbolicLink()) {
    const resolved = await realpath(dest).catch(() => null)
    return resolved === source
  }

  if (!copyMode) return false

  try {
    await access(join(dest, 'SKILL.md'), fsConstants.R_OK)
  } catch {
    return false
  }

  const markerText = await readFile(join(dest, copyMarkerName), 'utf8').catch(() => '')
  if (!markerText) return false

  try {
    const marker = JSON.parse(markerText)
    return marker?.repo === copyMarkerRepo &&
      marker?.version === copyMarkerVersion &&
      marker?.skill === markerSkillId(source)
  } catch {
    return false
  }
}

async function writeCopyMarker(dest, skill) {
  const marker = {
    repo: copyMarkerRepo,
    version: copyMarkerVersion,
    skill: markerSkillId(skill.path),
  }
  await writeFile(join(dest, copyMarkerName), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function markerSkillId(source) {
  return `skills/${source.slice(source.lastIndexOf('/') + 1)}`
}

function findYamlString(frontmatter, key) {
  const pattern = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]+))\\s*$`, 'm')
  const match = frontmatter.match(pattern)
  return match ? (match[1] || match[2] || match[3] || '').trim() : ''
}

function relative(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
