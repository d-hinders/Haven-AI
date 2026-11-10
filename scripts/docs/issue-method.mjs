#!/usr/bin/env node
// Issue Method-block runner (#4771).
//
// ## The problem this exists for
//
// `new-task` requires every code claim in an issue body to be measured at a
// named SHA, with the command in a Method block. The spec review re-runs those
// claims by hand, and across the issues whose review recorded a count, 27 of
// 226 were wrong at filing (#4771). This runner re-runs the claims that fit a
// small fixed grammar, so a drifted count or line number is found by a command
// instead of by a reader.
//
// It is the runner only. Nothing in `new-task` or `review-issue` calls it yet;
// adoption is a later slice, filed once the hit rate on real issues is known.
//
// ## The invariant
//
// An issue body is untrusted input, and this runs on developer machines that
// hold signer keys and tokens. NOTHING IN AN ISSUE BODY IS EVER EXECUTED, by a
// shell or otherwise. A checkable line is parsed by the tokenizer below into
// fields; the runner then builds its OWN `git` argument vector from those
// fields (`buildGitArgs`) and runs it through `execFile`. The line's text is
// never passed to a shell, and a line the grammar does not accept is refused
// with a reason, never "run as best we can".
//
// Accepted residual: `git` reads the repository's own `.git/config`, which
// belongs to the user's clone and is trusted. System and global configuration
// are switched off for determinism.
//
// ## What a checkable line looks like
//
// Only lines inside fenced code blocks under the body's `Method` heading are
// read. A line is CHECKABLE when it carries a trailing `# check:` or
// `# control:` comment; every other line is free-form, stays legal, and is not
// checked. A checkable line is exactly one of three `git` forms, with the SHA
// written out in hex (no `$SHA` — a substitution is refused):
//
//   git grep -c [-w] [-i] [-E|-F] -e '<pattern>' <sha> -- '<pathspec>'...   # check: lines = <n>
//   git grep -l [-w] [-i] [-E|-F] -e '<pattern>' <sha> -- '<pathspec>'...   # check: files = <n>
//   git show <sha>:<path>                                                   # check: lines <a>-<b> contain '<literal>'
//   git show <sha>:<path>                                                   # check: line <a> contains '<literal>'
//   git ls-tree <sha> -- <path>                                             # check: exists
//   git ls-tree <sha> -- <path>                                             # check: absent
//
// `lines = <n>` is the TOTAL of matching lines over all files (the sum of what
// `git grep -c` prints per file); `files = <n>` is the number of files with a
// match. A pathspec may carry the `:!` exclude prefix, followed by a letter,
// digit, `.`, `_` or `*`, and no other magic. A
// free-text note may follow the expectation after a second ` # `.
//
// ## False zeros
//
// A zero proves nothing until the instrument has shown it can reach the files
// it claims to have searched. So:
//
// - A `lines = 0` or `files = 0` check must name a control, and the control is
//   another checkable `git grep` line at the SAME SHA under the SAME pathspecs
//   that must return non-zero:
//
//     git grep -l -e 'import' <sha> -- 'packages/*/src/**'                      # control: reach
//     git grep -c -w -E -e 'TODO|FIXME' <sha> -- 'packages/*/src/**'            # check: lines = 0; control: reach
//
//   With no control, a control that does not exist or was refused, a control
//   over other pathspecs or another SHA, or a control that returns 0, the
//   line is `unproven zero`. The control proves REACH only — that the
//   pathspecs select files at that SHA. It does not prove the zero's pattern
//   could have matched: a pattern that is wrong for its pattern type still
//   reads as a proven zero, and that stays a reader's job.
// - An `absent` check carries a built-in control: the path's parent directory
//   must exist at the SHA. A typo in a directory name is otherwise
//   indistinguishable from a file that is really gone. A top-level path has
//   no parent to check, and the verdict says so.
//
// A control is itself a checkable line: it `reproduces` when it returns
// non-zero, and is listed apart when it does not.
//
// ## Refusals
//
// A field that begins with `-`; a path that is absolute, contains `..` or
// (for `git show` and `git ls-tree`) ends in `/`; a SHA that is not 7–40 hex
// characters, does not resolve to one commit whose id begins with those
// characters, or is not an ancestor of `origin/dev` or `origin/main` (read from the local
// remote-tracking refs — the runner never fetches); a pipe, a redirection, a
// substitution, a second command, an environment assignment, a backslash
// escape, an unquoted glob character, a control character or whitespace other
// than space and tab anywhere on the line; a tool other than `git`; a `git`
// subcommand or flag outside the three forms. A body over 1 MB is a usage
// error; a checkable line over 2000 characters, or past the 200th, is refused.
//
// The report prints each line as the body wrote it, with every control
// character shown as an escape (`\x1b`), so a body cannot move the cursor or
// repaint a verdict in the reader's terminal.
//
// ## Process hygiene
//
// `execFile` (no shell), a scrubbed environment (a fixed `PATH`, no token, no
// `HOME`), `--no-pager`, a per-call timeout and an output cap. No network: the
// runner never fetches, and lazy fetching of a partial clone is switched off.
// Nothing is written to the repository and no worktree is needed — all three
// forms read objects at a SHA. `--issue <n>` is the one exception to the
// scrubbed environment: it is a single `gh issue view` READ, which needs the
// user's own `gh` login. The runner never edits an issue.
//
// Usage:
//   node scripts/docs/issue-method.mjs --body-file <path> [--repo <dir>]
//   node scripts/docs/issue-method.mjs --issue <n>        [--repo <dir>]
//
// Exit 0 only when at least one line was checkable and every one reproduces.
// Exit 1 when any checkable line differs, is refused or is an unproven zero.
// Exit 2 on a usage error or an unreadable body. Exit 3 when the body has no
// checkable line at all: nothing was checked, which is not a pass.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A hung or pathological pattern names itself instead of hanging the caller. */
export const GIT_TIMEOUT_MS = 20_000
/** Bytes of stdout one `git` call may produce before the line is refused. */
export const GIT_OUTPUT_CAP = 32 * 1024 * 1024
const MAX_FIELD_LENGTH = 500
/** A body larger than this is a usage error: GitHub's own limit is far below it. */
export const MAX_BODY_BYTES = 1024 * 1024
const MAX_LINE_LENGTH = 2000
const MAX_CHECKABLE_LINES = 200
const MAX_PATHSPECS = 50

/** The only environment `git` sees. No token, no HOME, no inherited variable. */
export const GIT_ENV = Object.freeze({
  PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
})

/** Prepended to every vector: no pager, and no transport even if something asked. */
const GIT_PREFIX = ['--no-pager', '-c', 'protocol.allow=never']

const ANCESTOR_REFS = ['refs/remotes/origin/dev', 'refs/remotes/origin/main']

/** A line the grammar does not accept. The message is the reason shown to the reader. */
export class Refusal extends Error {}

const refuse = (reason) => {
  throw new Refusal(reason)
}

// ─── Finding the lines ───────────────────────────────────────────────────────

const MARKER = /(?:^|\s)#\s*(?:check|control):/

/**
 * The lines inside fenced code blocks under the `Method` heading, each with
 * its 1-based line number in the body and whether it carries a marker. A
 * heading inside a fence is text, not a heading.
 */
export function extractMethodLines(body) {
  const out = []
  let fence = null
  let methodLevel = null
  const lines = String(body).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(line)) {
        fence = null
      } else if (methodLevel !== null && line.trim() !== '') {
        out.push({ lineNumber: i + 1, text: line, checkable: MARKER.test(line) })
      }
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }
    const heading = /^(#{1,6})[ \t]+(\S.*)$/.exec(line.length > MAX_LINE_LENGTH ? '' : line.trimEnd())
    if (heading) {
      const level = heading[1].length
      if (/^method\b/i.test(heading[2])) methodLevel = level
      else if (methodLevel !== null && level <= methodLevel) methodLevel = null
    }
  }
  return out
}

// ─── The tokenizer ───────────────────────────────────────────────────────────

const UNQUOTED_REFUSALS = new Map([
  ['|', 'a pipe'],
  ['<', 'a redirection'],
  ['>', 'a redirection'],
  ['$', 'a substitution'],
  ['`', 'a substitution'],
  ['(', 'a substitution or subshell'],
  [')', 'a substitution or subshell'],
  [';', 'a second command'],
  ['&', 'a second command'],
  ['\\', 'a backslash escape'],
  ['*', 'an unquoted glob character (quote the field)'],
  ['?', 'an unquoted glob character (quote the field)'],
  ['[', 'an unquoted glob character (quote the field)'],
  [']', 'an unquoted glob character (quote the field)'],
  ['{', 'an unquoted brace'],
  ['}', 'an unquoted brace'],
  ['~', 'an unquoted tilde'],
  ['!', 'an unquoted history character (quote the field)'],
])

const ODD_WHITESPACE = /[\u0085\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u2060\u3000\ufeff]/

/** Space and tab separate words. Every other control or whitespace character is refused. */
function checkChar(ch) {
  if ((ch < ' ' && ch !== '\t') || ch === '\x7f') refuse('a control character')
  if (ODD_WHITESPACE.test(ch)) refuse('whitespace other than space and tab')
}

/**
 * Read one quoted or bare word starting at `text[start]`. Returns the word and
 * the index after it. Single quotes are literal. Double quotes are accepted
 * only when their content needs no shell interpretation at all.
 */
function readWord(text, start) {
  let i = start
  let word = ''
  while (i < text.length && text[i] !== ' ' && text[i] !== '\t') {
    const ch = text[i]
    checkChar(ch)
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) refuse('an unterminated quote')
      word += text.slice(i + 1, end)
      i = end + 1
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1)
      if (end === -1) refuse('an unterminated quote')
      const inner = text.slice(i + 1, end)
      if (/[$`]/.test(inner)) refuse('a substitution')
      if (/[\\!]/.test(inner)) refuse('a backslash or history character inside double quotes (use single quotes)')
      word += inner
      i = end + 1
    } else if (UNQUOTED_REFUSALS.has(ch)) {
      refuse(UNQUOTED_REFUSALS.get(ch))
    } else if (ch === '#' && i === start) {
      return { comment: true, next: i }
    } else {
      word += ch
      i++
    }
  }
  for (const c of word) checkChar(c)
  return { word, next: i }
}

/** Split a checkable line into its command words and the text of its comment. */
export function tokenize(line) {
  if (line.length > MAX_LINE_LENGTH) refuse(`a line longer than ${MAX_LINE_LENGTH} characters`)
  for (const ch of line) checkChar(ch)
  const words = []
  let i = 0
  while (i < line.length) {
    if (line[i] === ' ' || line[i] === '\t') {
      i++
      continue
    }
    const read = readWord(line, i)
    if (read.comment) return { words, comment: line.slice(read.next + 1).trim() }
    words.push(read.word)
    i = read.next
  }
  refuse('the check marker sits inside a quoted field')
}

// ─── The grammar ─────────────────────────────────────────────────────────────

const HEX = /^[0-9a-f]{7,40}$/
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const GREP_FLAGS = new Set(['-c', '-l', '-w', '-i', '-E', '-F'])

function checkField(value, what) {
  if (value === '') refuse(`an empty ${what}`)
  if (value.startsWith('-')) refuse(`a ${what} that begins with "-"`)
  if (value.length > MAX_FIELD_LENGTH) refuse(`a ${what} longer than ${MAX_FIELD_LENGTH} characters`)
}

function checkSha(value) {
  checkField(value, 'SHA')
  if (!HEX.test(value)) refuse('a SHA that is not 7-40 lowercase hex characters')
}

function checkPath(value, what) {
  checkField(value, what)
  if (value.startsWith('/')) refuse(`an absolute ${what}`)
  if (value.includes('..')) refuse(`a ${what} that contains ".."`)
  if (value.startsWith(':')) refuse(`${what} magic other than the ":!" exclude prefix`)
}

/** A `git show` or `git ls-tree` path names one entry: `file/` lists nothing and would read as absent. */
function checkEntryPath(value) {
  checkPath(value, 'path')
  if (value.endsWith('/')) refuse('a path that ends in "/"')
}

function checkPathspec(value) {
  checkField(value, 'pathspec')
  if (!value.startsWith(':!')) return checkPath(value, 'pathspec')
  const rest = value.slice(2)
  if (!/^[A-Za-z0-9._*]/.test(rest)) refuse('pathspec magic other than the ":!" exclude prefix')
  checkPath(rest, 'pathspec')
}

function parseCommand(words) {
  if (words.length === 0) refuse('no command before the check marker')
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) refuse('an environment assignment')
  if (words[0] !== 'git') refuse('a tool other than git')
  const sub = words[1]
  if (sub === undefined) refuse('no git subcommand')
  if (sub.startsWith('-')) refuse(`a git flag outside the three check kinds (${sub})`)
  const rest = words.slice(2)

  if (sub === 'grep') {
    const flags = new Set()
    let i = 0
    while (i < rest.length && rest[i] !== '-e') {
      const flag = rest[i]
      if (!flag.startsWith('-')) refuse('a pattern that does not follow -e (write: git grep -c -e <pattern> <sha> -- <pathspec>)')
      if (!GREP_FLAGS.has(flag)) refuse(`a git grep flag outside the check kinds (${flag})`)
      flags.add(flag)
      i++
    }
    if (rest[i] !== '-e') refuse('no -e before the pattern')
    const pattern = rest[i + 1]
    const sha = rest[i + 2]
    if (pattern === undefined || sha === undefined || rest[i + 3] !== '--') {
      refuse('a git grep line that is not: git grep <flags> -e <pattern> <sha> -- <pathspec>...')
    }
    checkField(pattern, 'pattern')
    checkSha(sha)
    const pathspecs = rest.slice(i + 4)
    if (pathspecs.length === 0) refuse('no pathspec after --')
    if (pathspecs.length > MAX_PATHSPECS) refuse(`more than ${MAX_PATHSPECS} pathspecs`)
    pathspecs.forEach(checkPathspec)
    if (flags.has('-c') === flags.has('-l')) refuse('a git grep line needs exactly one of -c (lines) or -l (files)')
    if (flags.has('-E') && flags.has('-F')) refuse('both -E and -F')
    return {
      kind: flags.has('-c') ? 'grep-lines' : 'grep-files',
      sha,
      pattern,
      pathspecs,
      word: flags.has('-w'),
      ignoreCase: flags.has('-i'),
      patternType: flags.has('-E') ? '-E' : flags.has('-F') ? '-F' : '-G',
    }
  }

  if (sub === 'show') {
    if (rest.length !== 1) refuse('a git show line that is not: git show <sha>:<path>')
    checkField(rest[0], 'object name')
    const colon = rest[0].indexOf(':')
    if (colon === -1) refuse('a git show line that is not: git show <sha>:<path>')
    const sha = rest[0].slice(0, colon)
    const path = rest[0].slice(colon + 1)
    checkSha(sha)
    checkEntryPath(path)
    return { kind: 'show', sha, path }
  }

  if (sub === 'ls-tree') {
    if (rest.length !== 3 || rest[1] !== '--') refuse('a git ls-tree line that is not: git ls-tree <sha> -- <path>')
    if (rest[0].startsWith('-')) refuse(`a git ls-tree flag outside the check kinds (${rest[0]})`)
    checkSha(rest[0])
    checkEntryPath(rest[2])
    return { kind: 'ls-tree', sha: rest[0], path: rest[2] }
  }

  refuse(`a git subcommand outside the three check kinds (${sub})`)
}

/** Drop an optional trailing ` # note` and insist nothing else follows. */
function expectEnd(text) {
  const tail = text.trim()
  if (tail !== '' && !tail.startsWith('#')) refuse(`an expectation the grammar does not know (unexpected "${tail.slice(0, 40)}")`)
}

function parseExpectation(comment, command) {
  const control = /^control:\s*(\S+)(.*)$/.exec(comment)
  if (control) {
    if (!NAME.test(control[1])) refuse('a control name that is not letters, digits, "-" or "_"')
    expectEnd(control[2])
    if (command.kind !== 'grep-lines' && command.kind !== 'grep-files') refuse('a control that is not a git grep line')
    return { type: 'control', name: control[1] }
  }
  const body = /^check:\s*(.*)$/.exec(comment)?.[1]
  if (body === undefined) refuse('a marker that is neither "check:" nor "control:"')

  const count = /^(lines|files)\s*=\s*(\d{1,9})(?:\s*;\s*control:\s*(\S+))?(.*)$/.exec(body)
  if (count) {
    expectEnd(count[4])
    const want = count[1] === 'lines' ? 'grep-lines' : 'grep-files'
    if (command.kind !== want) {
      refuse(`"${count[1]} =" on a line that is not git grep ${count[1] === 'lines' ? '-c' : '-l'}`)
    }
    if (count[3] !== undefined && !NAME.test(count[3])) refuse('a control name that is not letters, digits, "-" or "_"')
    return { type: 'count', expected: Number(count[2]), control: count[3] ?? null }
  }

  const contain = /^(?:lines\s+(\d{1,7})-(\d{1,7})\s+contain|line\s+(\d{1,7})\s+contains)\s+(.*)$/.exec(body)
  if (contain) {
    if (command.kind !== 'show') refuse('"contain" on a line that is not git show <sha>:<path>')
    const from = Number(contain[1] ?? contain[3])
    const to = Number(contain[2] ?? contain[3])
    if (from < 1 || to < from) refuse('a line range that does not run forward from line 1 or later')
    const quoted = contain[4]
    if (quoted[0] !== "'" && quoted[0] !== '"') refuse('a literal that is not quoted')
    const read = readWord(quoted, 0)
    if (read.word === '') refuse('an empty literal')
    if (read.word.includes('\ufffd')) refuse('a literal that contains U+FFFD')
    expectEnd(quoted.slice(read.next))
    return { type: 'contain', from, to, literal: read.word }
  }

  const presence = /^(exists|absent)\b(.*)$/.exec(body)
  if (presence) {
    expectEnd(presence[2])
    if (command.kind !== 'ls-tree') refuse(`"${presence[1]}" on a line that is not git ls-tree <sha> -- <path>`)
    return { type: presence[1] }
  }

  refuse('an expectation the grammar does not know')
}

/** Parse one checkable line into `{ command, expectation }`, or throw a `Refusal`. */
export function parseCheckableLine(line) {
  const { words, comment } = tokenize(line)
  const command = parseCommand(words)
  return { command, expectation: parseExpectation(comment, command) }
}

// ─── The argument vectors ────────────────────────────────────────────────────

/**
 * The runner's own argument vector for a parsed command at a resolved full
 * SHA, without the prefix `git()` adds to every call. Every field from the body sits where `git` reads it as data: the
 * pattern after `-e`, pathspecs and paths after `--`, and the object name as
 * one `<full sha>:<path>` word that begins with the resolved SHA, never with
 * a field from the body.
 */
export function buildGitArgs(command, fullSha) {
  if (command.kind === 'grep-lines' || command.kind === 'grep-files') {
    return [
      'grep',
      '--no-color',
      '--no-recurse-submodules',
      '-z',
      command.kind === 'grep-lines' ? '-c' : '-l',
      ...(command.word ? ['-w'] : []),
      ...(command.ignoreCase ? ['-i'] : []),
      command.patternType,
      '-e',
      command.pattern,
      fullSha,
      '--',
      ...command.pathspecs,
    ]
  }
  if (command.kind === 'show') {
    return ['show', '--no-textconv', '--no-ext-diff', `${fullSha}:${command.path}`]
  }
  if (command.kind === 'ls-tree') {
    return ['ls-tree', '-z', '--name-only', fullSha, '--', command.path]
  }
  throw new Error(`unknown command kind ${command.kind}`)
}

// ─── Running git ─────────────────────────────────────────────────────────────

/**
 * The one place `git` is started. `args` never carries the prefix: it is added
 * here, so no call can go out without it. Resolves `{ code, stdout, stderr,
 * failure }`; never rejects and never uses a shell. `ctx.exec` is `execFile`
 * unless a test passes a recorder.
 */
function git(ctx, args) {
  return new Promise((resolvePromise) => {
    ctx.exec(
      'git',
      [...GIT_PREFIX, ...args],
      { cwd: ctx.repo, env: GIT_ENV, timeout: ctx.timeoutMs, maxBuffer: ctx.outputCap, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        let failure = null
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') failure = 'git printed more than the output cap'
        else if (error?.killed) failure = `git did not finish in ${ctx.timeoutMs / 1000}s`
        else if (error && typeof error.code !== 'number') failure = `git could not be started (${error.code ?? error.message})`
        resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr, failure })
      },
    )
  })
}

/** Resolve an abbreviated SHA to one commit that is in `origin/dev` or `origin/main`. */
async function resolveSha(ctx, sha, cache) {
  if (cache.has(sha)) return cache.get(sha)
  const result = await (async () => {
    const parsed = await git(ctx, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
    if (parsed.failure) return { refusal: parsed.failure }
    const full = parsed.stdout.trim()
    // `full.startsWith(sha)`: a branch or tag whose NAME is hex resolves too, and is not the SHA the line wrote.
    if (parsed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(full) || !full.startsWith(sha)) {
      return { refusal: `a SHA that does not resolve to one commit in this clone (${sha})` }
    }
    let sawRef = false
    for (const ref of ANCESTOR_REFS) {
      const exists = await git(ctx, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      if (exists.code !== 0) continue
      sawRef = true
      const ancestor = await git(ctx, ['merge-base', '--is-ancestor', full, ref])
      if (ancestor.code === 0) return { full }
    }
    return {
      refusal: sawRef
        ? `a SHA that is not an ancestor of origin/dev or origin/main (${sha})`
        : 'no origin/dev or origin/main remote-tracking ref in this clone to check the SHA against',
    }
  })()
  cache.set(sha, result)
  return result
}

async function runGrep(ctx, command, fullSha) {
  const out = await git(ctx, buildGitArgs(command, fullSha))
  if (out.failure) return { refusal: out.failure }
  if (out.code !== 0 && out.code !== 1) {
    return { refusal: `git grep failed (${out.stderr.trim().split('\n')[0].slice(0, 120) || `exit ${out.code}`})` }
  }
  if (command.kind === 'grep-files') return { got: out.stdout.split('\0').length - 1 }
  let total = 0
  for (const match of out.stdout.matchAll(/\0(\d+)\n/g)) total += Number(match[1])
  return { got: total }
}

async function pathExists(ctx, fullSha, path) {
  const out = await git(ctx, buildGitArgs({ kind: 'ls-tree', path }, fullSha))
  if (out.failure) return { refusal: out.failure }
  if (out.code !== 0) return { refusal: `git ls-tree failed (${out.stderr.trim().split('\n')[0].slice(0, 120) || `exit ${out.code}`})` }
  return { exists: out.stdout.length > 0 }
}

const samePathspecs = (a, b) => a.length === b.length && [...a].sort().every((p, i) => p === [...b].sort()[i])

// ─── The verdicts ────────────────────────────────────────────────────────────

/**
 * Run every checkable line of `body` against the clone at `repo`. Returns one
 * entry per checkable line: `{ lineNumber, text, status, detail, isControl }`
 * with `status` one of `reproduces`, `differs`, `refused`, `unproven zero`.
 */
export async function runChecks(body, { repo = REPO_ROOT, exec = execFile, timeoutMs = GIT_TIMEOUT_MS, outputCap = GIT_OUTPUT_CAP } = {}) {
  const ctx = { repo, exec, timeoutMs, outputCap }
  const lines = extractMethodLines(body)
  const freeForm = lines.filter((l) => !l.checkable).length
  const entries = lines
    .filter((l) => l.checkable)
    .map((l, index) => {
      const entry = { lineNumber: l.lineNumber, text: l.text.trim(), status: null, detail: '', isControl: false }
      try {
        if (index >= MAX_CHECKABLE_LINES) refuse(`more than ${MAX_CHECKABLE_LINES} checkable lines in one block`)
        entry.parsed = parseCheckableLine(l.text)
        entry.isControl = entry.parsed.expectation.type === 'control'
      } catch (err) {
        if (!(err instanceof Refusal)) throw err
        entry.status = 'refused'
        entry.detail = err.message
        entry.isControl = /(?:^|\s)#\s*control:/.test(l.text)
      }
      return entry
    })

  const shaCache = new Map()
  const settle = (entry, status, detail = '') => Object.assign(entry, { status, detail })

  // Resolve SHAs, then run controls before the checks that cite them.
  for (const entry of entries) {
    if (entry.status) continue
    const resolved = await resolveSha(ctx, entry.parsed.command.sha, shaCache)
    if (resolved.refusal) settle(entry, 'refused', resolved.refusal)
    else entry.fullSha = resolved.full
  }

  const controls = new Map()
  const duplicated = new Set()
  for (const entry of entries) {
    if (!entry.isControl || !entry.parsed) continue
    const name = entry.parsed.expectation.name
    if (controls.has(name)) duplicated.add(name)
    controls.set(name, entry)
  }
  for (const entry of entries) {
    if (!entry.isControl || entry.status) continue
    if (duplicated.has(entry.parsed.expectation.name)) {
      settle(entry, 'refused', `a control name used twice (${entry.parsed.expectation.name})`)
      continue
    }
    const ran = await runGrep(ctx, entry.parsed.command, entry.fullSha)
    if (ran.refusal) settle(entry, 'refused', ran.refusal)
    else if (ran.got > 0) settle(entry, 'reproduces', `got ${ran.got}`)
    else settle(entry, 'differs', 'got 0')
  }

  for (const entry of entries) {
    if (entry.status) continue
    const { command, expectation } = entry.parsed

    if (expectation.type === 'count') {
      const ran = await runGrep(ctx, command, entry.fullSha)
      if (ran.refusal) settle(entry, 'refused', ran.refusal)
      else if (ran.got !== expectation.expected) settle(entry, 'differs', `got ${ran.got}`)
      else if (expectation.expected !== 0) settle(entry, 'reproduces')
      else {
        const control = expectation.control === null ? null : controls.get(expectation.control)
        if (expectation.control === null) settle(entry, 'unproven zero', 'no control named')
        else if (!control) settle(entry, 'unproven zero', `control "${expectation.control}" is not a line in this block`)
        else if (control.status === 'refused') settle(entry, 'unproven zero', `control "${expectation.control}" was refused`)
        else if (control.fullSha !== entry.fullSha) settle(entry, 'unproven zero', `control "${expectation.control}" reads another SHA`)
        else if (!samePathspecs(control.parsed.command.pathspecs, command.pathspecs)) {
          settle(entry, 'unproven zero', `control "${expectation.control}" reads other pathspecs`)
        } else if (control.status !== 'reproduces') settle(entry, 'unproven zero', `control "${expectation.control}" returned 0`)
        else settle(entry, 'reproduces', `control "${expectation.control}" ${control.detail}`)
      }
      continue
    }

    if (expectation.type === 'contain') {
      const listed = await pathExists(ctx, entry.fullSha, command.path)
      if (listed.refusal) {
        settle(entry, 'refused', listed.refusal)
        continue
      }
      if (!listed.exists) {
        settle(entry, 'differs', 'got no such path at the SHA')
        continue
      }
      const type = await git(ctx, ['cat-file', '-t', `${entry.fullSha}:${command.path}`])
      if (type.failure || type.code !== 0) {
        settle(entry, 'refused', type.failure ?? 'the file is in the tree but its content is not in this clone')
        continue
      }
      if (type.stdout.trim() !== 'blob') {
        settle(entry, 'refused', `a git show path that is a ${type.stdout.trim()}, not a file`)
        continue
      }
      const out = await git(ctx, buildGitArgs(command, entry.fullSha))
      if (out.failure || out.code !== 0) {
        settle(entry, 'refused', out.failure ?? `git show failed (exit ${out.code})`)
        continue
      }
      const fileLines = out.stdout.split('\n')
      if (fileLines.at(-1) === '') fileLines.pop()
      if (expectation.to > fileLines.length) settle(entry, 'differs', `got a file of ${fileLines.length} lines`)
      else if (fileLines.slice(expectation.from - 1, expectation.to).some((l) => l.includes(expectation.literal))) {
        settle(entry, 'reproduces')
      } else {
        const elsewhere = fileLines.findIndex((l) => l.includes(expectation.literal))
        settle(entry, 'differs', elsewhere === -1 ? 'got no such literal in the file' : `got the literal at line ${elsewhere + 1}`)
      }
      continue
    }

    // exists / absent
    const found = await pathExists(ctx, entry.fullSha, command.path)
    if (found.refusal) {
      settle(entry, 'refused', found.refusal)
      continue
    }
    if (expectation.type === 'exists') {
      settle(entry, found.exists ? 'reproduces' : 'differs', found.exists ? '' : 'got absent')
      continue
    }
    if (found.exists) {
      settle(entry, 'differs', 'got exists')
      continue
    }
    const parent = command.path.includes('/') ? command.path.slice(0, command.path.lastIndexOf('/')) : null
    if (parent === null) {
      settle(entry, 'reproduces', 'top-level path: no parent to check')
      continue
    }
    const parentFound = await pathExists(ctx, entry.fullSha, parent)
    if (parentFound.refusal) settle(entry, 'refused', parentFound.refusal)
    else if (parentFound.exists) settle(entry, 'reproduces', `parent ${parent} exists`)
    else settle(entry, 'unproven zero', `parent directory ${parent} does not exist at the SHA`)
  }

  return {
    freeForm,
    entries: entries.map(({ lineNumber, text, status, detail, isControl }) => ({ lineNumber, text, status, detail, isControl })),
  }
}

// ─── The report ──────────────────────────────────────────────────────────────

/** The verdict as the reader sees it: `differs (got 3)`, `refused (a pipe)`, … */
export function verdict(entry) {
  return entry.detail === '' ? entry.status : `${entry.status} (${entry.detail})`
}

/**
 * Body text as it may be printed: every control character, and the Unicode
 * line and bidi controls, as a visible escape. A refused line is still shown,
 * and it is the line most likely to carry one.
 */
export function printable(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (ch) => {
    const code = ch.codePointAt(0)
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
}

export function exitCodeFor(result) {
  if (result.entries.length === 0) return 3
  return result.entries.every((e) => e.status === 'reproduces') ? 0 : 1
}

export function formatReport(result) {
  const { entries, freeForm } = result
  const count = (status) => entries.filter((e) => e.status === status).length
  const out = []
  if (entries.length === 0) {
    out.push(`issue-method: no checkable line in the Method block (${freeForm} free-form). Nothing was checked.`)
    return out.join('\n') + '\n'
  }
  const row = (e) => `  L${e.lineNumber}  ${printable(verdict(e))}\n        ${printable(e.text)}`
  out.push('issue-method: checkable lines of the Method block', '')
  for (const e of entries) out.push(row(e))
  const failedControls = entries.filter((e) => e.isControl && e.status !== 'reproduces')
  if (failedControls.length > 0) {
    out.push('', 'Failed controls — every zero that cites one of these is unproven:')
    for (const e of failedControls) out.push(row(e))
  }
  out.push(
    '',
    `Summary: ${entries.length} checkable — ${count('reproduces')} reproduce, ${count('differs')} differ, ` +
      `${count('refused')} refused, ${count('unproven zero')} unproven zero. ${freeForm} free-form not checked.`,
  )
  return out.join('\n') + '\n'
}

// ─── The CLI ─────────────────────────────────────────────────────────────────

export const USAGE = 'usage: node scripts/docs/issue-method.mjs (--body-file <path> | --issue <n>) [--repo <dir>]'

export function parseArgs(argv) {
  const out = { bodyFile: null, issue: null, repo: REPO_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--body-file') out.bodyFile = resolve(value())
    else if (arg === '--issue') {
      out.issue = value()
      if (!/^[1-9]\d{0,9}$/.test(out.issue)) throw new Error('--issue takes an issue number')
    } else if (arg === '--repo') out.repo = resolve(value())
    else throw new Error(`unknown argument ${arg}`)
  }
  if ((out.bodyFile === null) === (out.issue === null)) throw new Error('give exactly one of --body-file or --issue')
  return out
}

/** The one read of GitHub: the issue's body, through the user's own `gh` login. */
function readIssueBody(issue, repo) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'gh',
      ['issue', 'view', issue, '--json', 'body', '--jq', '.body'],
      { cwd: repo, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => (error ? reject(new Error(`gh issue view ${issue} failed: ${stderr.trim() || error.message}`)) : resolvePromise(stdout)),
    )
  })
}

export async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`issue-method: ${err.message}`)
    console.error(USAGE)
    return 2
  }
  let body
  try {
    body = args.bodyFile ? readFileSync(args.bodyFile, 'utf8') : await readIssueBody(args.issue, args.repo)
  } catch (err) {
    console.error(`issue-method: ${err.message}`)
    return 2
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    console.error(`issue-method: the body is larger than ${MAX_BODY_BYTES} bytes`)
    return 2
  }
  const result = await runChecks(body, { repo: args.repo })
  process.stdout.write(formatReport(result))
  return exitCodeFor(result)
}

// True only when this file is the process's entry point, so importing it (the
// self-test) never runs the CLI. Both paths are resolved before they are
// compared: Node resolves symlinks for a module's own URL and not for
// `process.argv[1]`, so an unresolved comparison is false through any symlink,
// and the script would exit 0 without running (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2))
}
