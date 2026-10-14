#!/usr/bin/env node
// Shrink-only census ratchet over inline budget-liveness predicates
// (#3924, epic #3919 slice E).
//
// Slices A–C of the epic named every budget-liveness predicate ONCE —
// `spendableDelegationSql`/`stillEnabledDelegationSql` (A), the per-table
// `openSubBudgetSql`/`liveTaskBudgetSql` family (B) and the client-side
// `delegationIsLive`/`subBudgetStillRunning` pair (C) — and pointed every
// reader at the named copy. Without a census the inline copies the slices
// deleted grow back one query at a time, exactly as the same pattern did
// between #3542 (2026-10-01) and #3802 (2026-10-09). This gate counts the
// inline restatements and lets the count only SHRINK:
//
//   sql-status-literal  — `status` compared to a liveness literal
//                         ('active', 'open', 'closing', 'pending',
//                         'replaced') inside a `SELECT … WHERE` clause on
//                         `agent_delegations`, `agent_task_budgets` or
//                         `agent_sub_budgets`, in `packages/backend/src`
//                         (non-test).
//   sql-time-now        — the same WHERE clauses comparing `expires_at` or
//                         `start_date` to the clock (NOW()/CURRENT_*,
//                         EXTRACT(… NOW()), a `$n` placeholder or an
//                         interpolated `now` parameter).
//   ts-status-liveness  — TypeScript sites in the client packages
//                         (`packages/{sdk,cli,frontend,mcp,mcp-server}/src`,
//                         non-test) comparing a BUDGET-SHAPED object's
//                         `status` to a liveness literal. "Budget-shaped"
//                         is decided textually (see `isBudgetShaped`): a
//                         budget/delegation receiver name, the same receiver
//                         touching a budget row field (`expires_at`,
//                         `is_live`, `budget_atomic`, …) within ±6 lines, or
//                         a budget TYPE name annotating the shape in that
//                         window. Agent and payment statuses
//                         (`agent.status === 'active'`,
//                         `raw.status === 'pending'`) are deliberately NOT
//                         counted — a false positive here would redden the
//                         budget gate on unrelated work. KNOWN HOLE: a
//                         receiver whose budget shape is visible only
//                         through an inference chain (`const reread = await
//                         readAttemptedHash(...)` in useDelegationBudget.ts)
//                         is invisible — its type lives lines away from the
//                         comparison and no rule reaches it.
//   ts-time-now         — the same client set comparing a budget-shaped
//                         object's `expires_at`/`expiresAt` to now.
//   ts-payment-window   — the backend TypeScript mirror of the payment
//                         window: `expiresAtOf(b) > now && startAtOf(b)
//                         <= now` in `delegation-budgets.ts`. This is the
//                         ACCEPTED mirror (epic #3919 § Measured state): it
//                         is the payment-window definition slices A–C did
//                         not fold into a named predicate, kept inline
//                         deliberately. The reason lives in this header
//                         (the engine's baseline shape is `{file: {key:
//                         count}}` — numeric only — so the reason cannot
//                         ride in the JSON): the count is ratcheted like
//                         any other, so a SECOND inline copy of the window
//                         anywhere in the backend reddens, while the
//                         accepted one sits at its measured count.
//
// NOT counted: status TRANSITIONS. Only statements whose first keyword is
// `SELECT` (or `WITH`) are read; `INSERT`, `UPDATE … SET status` and the
// slot sweeps in `delegation-budgets.ts` are writes, not liveness reads,
// and a planted `UPDATE agent_delegations SET status = 'active'` must stay
// green (the self-test pins it).
//
// EXCLUSION IS BY EXPORT NAME, NOT BY FILE. The named predicate
// definitions from slices A/B/C (NAMED_PREDICATE_EXPORTS below) have their
// declaration bodies blanked before scanning, wherever they live — so a NEW
// inline copy inside `delegation-budgets.ts` itself is still counted, while
// the sanctioned single copies are not. Only `export function` declarations
// are excluded; a renamed or re-exported copy counts, which is the point.
//
// SQL is read from template literals, with `${…}` interpolation PARSED, not
// skipped (the epic's explicit requirement): each interpolation is replaced
// by a `$«expr»` placeholder token so `expires_at > ${nowParam}` still reads
// as a now-comparison. An interpolation carrying a whole dynamic predicate
// (or an interpolated TABLE name) is invisible to the census — no budget
// table name is interpolated in the tree today (checked at land time), and
// a dynamic predicate fragment is a shape the named-predicate rule exists to
// prevent anyway.
//
// Regex, not the TypeScript compiler API (the #3056 guard brief's
// alternative, offered to the builder as a decision): the shapes counted
// here are flat comparisons on source text — no `reply.code(...)` chains,
// and the one accessor form (`expiresAtOf(b)`) is a fixed identifier. The
// compiler API would buy type-accurate "budget-shaped" detection at the
// cost of the first `typescript`-importing guard under `scripts/`; the
// ±6-line window heuristic pins today's true sites and was calibrated
// against them (see `isBudgetShaped`). Regex-literal blindness is the same
// documented hole every other source stripper in this repo carries: a regex
// containing a quote or backtick can desync the template scanner.
//
//   node scripts/lint-budget-liveness.mjs            # check against baseline
//   node scripts/lint-budget-liveness.mjs --update   # tighten after a reduction
//                                                    # (refuses to ratchet upward)
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newViolations,
  hasShrunk,
  writeBaseline,
  loadBaseline,
  updateRefusals,
  zeroScanEntries,
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  runGate,
} from './lib/ratchet.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'lint-budget-liveness-baseline.json')

export const SCAN_DIRS = [
  'packages/backend/src',
  'packages/sdk/src',
  'packages/cli/src',
  'packages/frontend/src',
  'packages/mcp/src',
  'packages/mcp-server/src',
]

const BUDGET_TABLES_RE = /\b(agent_delegations|agent_task_budgets|agent_sub_budgets)\b/
const LIVENESS = ['active', 'open', 'closing', 'pending', 'replaced']

const STATUS_LITERAL_RE = new RegExp(`\\bstatus\\s*(?:=|<>|!=)\\s*'(${LIVENESS.join('|')})'`, 'g')
const STATUS_IN_RE = /\bstatus\s+in\s*\(([^()]*)\)/gi
const TIME_NOW_RE =
  /\b(expires_at|start_date)\s*(?:=|<>|!=|<=|>=|<|>)\s*(\$«[^»]*»|\$\d+|now\s*\(\)|current_date\b|current_timestamp\b|extract\s*\([^()]*now[^()]*\))/gi

// Statements whose FIRST keyword is one of these are read-predicates;
// everything else (INSERT, UPDATE, DELETE, ALTER, …) is a transition and is
// not counted — that is what keeps the slot sweeps and `SET status` green.
const READ_STATEMENT_RE = /^(select|with)\b/i

const CLIENT_TS_STATUS_RE =
  /([A-Za-z_$][\w$]*)\??\.status\s*(?:===|!==|==|!=)\s*'(?:active|open|closing|pending|replaced)'/g
const CLIENT_TS_TIME_RE =
  /([A-Za-z_$][\w$]*)\??\.(?:expires_at|expiresAt)\s*(?:<=|>=|<|>)\s*(Date\.now\(\)|Date\.parse\([^)]*\)|[A-Za-z_$][\w$]*)/g
const PAYMENT_WINDOW_RE = /\b(?:expiresAtOf|startAtOf)\s*\([^()]*\)\s*(?:<=|>=|<|>)\s*now\b/g

const NOWISH_RE = /now/i

// The budget-row fields that mark a receiver as budget-shaped when its NAME
// alone does not (`row`, `tb`, `mine`, `reread` all carry budgets in the
// tree). `budget_`/`period` prefixes cover budget_atomic, budgetAtomic,
// periodSeconds, periodAmountAtomic in one alternation.
const BUDGET_FIELD_RE =
  /(expires_at|expiresAt|is_live|isLive|isExpired|start_date|startAt|budget_[A-Za-z]*|period[A-Z_])/

// Budget TYPE names (or collection variable names) that mark a window as
// budget context — case-insensitive so a lowercase `budgets.find((b) => …)`
// counts; word-bounded so `hasUsableBudget(agent)` does not match.
const BUDGET_TYPE_RE =
  /\b(DelegationBudget|TaskBudget|SubBudget|DelegationRow|BudgetRow|HavenSubBudget|Budgets|Delegations)\b/i

// The named predicates slices A–C landed: a call on the receiver in the
// window (`delegationIsLive(b)`) is budget context for the same reason a
// field reference is.
const NAMED_CALL_RE =
  /\b(delegationIsLive|subBudgetStillRunning|isOpenSubBudget|isLiveTaskBudget|isReplacedButEnabled)\(\s*/

export const NAMED_PREDICATE_EXPORTS = [
  // Slice A (#3920) — delegation spendable / still-enabled SQL builders.
  'spendableDelegationSql',
  'stillEnabledDelegationSql',
  // Slice B (#3921) — per-table SQL builders and their JS mirrors.
  'openSubBudgetSql',
  'isOpenSubBudget',
  'awaitingSignatureSubBudgetSql',
  'openTaskBudgetSql',
  'liveTaskBudgetSql',
  'isLiveTaskBudget',
  // Slice C (#3922) — the client-side named copies.
  'delegationIsLive',
  'subBudgetStillRunning',
  // #3933 — the one client copy of "replaced in Haven, still enabled
  // on-chain": `replaced` and unexpired (`lib/budget-slot.ts`). Not a
  // liveness restatement — no slice predicate answers it (`is_live` is
  // false for a replaced row, `stillEnabledDelegationSql` also counts
  // active and pending) — so it is named once here like the others.
  'isReplacedButEnabled',
]

// ── The tiny JS scanner ──────────────────────────────────────────────────────
//
// Enough of a lexer to (a) find template literals and their ${…} ranges and
// (b) find the body span of an `export function` declaration, both without
// being confused by strings/comments that contain braces or backticks. Regex
// literals are not modelled (same documented hole as the other strippers).

/** Index just past the string/template token opening at `i`. */
function endOfToken(src, i) {
  const n = src.length
  const stack = [src[i]]
  i++
  while (i < n && stack.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    const top = stack[stack.length - 1]
    if (top === "'" || top === '"') {
      if (c === top) stack.pop()
      i++
      continue
    }
    // top === '`' or 'E' (inside a ${ … } expression)
    if (top === 'E') {
      if (c === '{') stack.push('E')
      else if (c === '}') stack.pop()
      else if (c === "'" || c === '"') stack.push(c)
      else if (c === '`') stack.push('`')
      i++
      continue
    }
    if (c === '`') {
      stack.pop()
      i++
      continue
    }
    if (c === '$' && src[i + 1] === '{') {
      stack.push('E')
      i += 2
      continue
    }
    i++
  }
  return i
}

function skipLineComment(src, i) {
  const e = src.indexOf('\n', i)
  return e === -1 ? src.length : e
}

function skipBlockComment(src, i) {
  const e = src.indexOf('*/', i + 2)
  return e === -1 ? src.length : e + 2
}

/** Every top-level template literal: {start, end, interps: [{start, end}]}. */
export function templateSpans(source) {
  const spans = []
  const stack = []
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      i = skipLineComment(source, i)
      continue
    }
    if (c === '/' && next === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    const top = stack[stack.length - 1]
    if (top && (top.kind === "'" || top.kind === '"')) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === top.kind) stack.pop()
      i++
      continue
    }
    if (top && top.kind === 'E') {
      if (c === '{') stack.push({ kind: 'E' })
      else if (c === '}') {
        if (top.interp) top.interp.end = i
        stack.pop()
      } else if (c === "'" || c === '"') stack.push({ kind: c })
      else if (c === '`') stack.push({ kind: 'tpl', isNested: true, interps: [] })
      i++
      continue
    }
    if (top && top.kind === 'tpl') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        if (!top.isNested) {
          top.end = i
          spans.push(top)
        }
        stack.pop()
        i++
        continue
      }
      if (c === '$' && next === '{') {
        const interp = { start: i, end: -1 }
        top.interps.push(interp)
        stack.push({ kind: 'E', interp })
        i += 2
        continue
      }
      i++
      continue
    }
    if (c === "'" || c === '"') stack.push({ kind: c })
    else if (c === '`') stack.push({ kind: 'tpl', start: i, end: -1, isNested: false, interps: [] })
    i++
  }
  return spans
}

/**
 * The `{open, close}` brace pair of the function body whose parameter list
 * starts being scanned at `from` (just past the declaration's `(`). The
 * first `{` at paren depth 0 is the body opener; strings, templates and
 * comments inside the parameter list are skipped, so an object-typed
 * parameter (`opts: { requireStarted: boolean }`) does not fool it.
 */
function bodySpan(src, from) {
  const n = src.length
  let i = from
  // We start INSIDE the parameter list, so its opening paren is already
  // open: an object-typed parameter (`opts: { requireStarted: boolean }`)
  // sits at depth ≥ 1 and is skipped, while the list's closing `)` brings
  // the depth to 0 — the body's `{` is then the first brace at depth 0.
  let paren = 1
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      i = skipLineComment(src, i)
      continue
    }
    if (c === '/' && next === '*') {
      i = skipBlockComment(src, i)
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i = endOfToken(src, i)
      continue
    }
    if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === '{' && paren === 0) {
      return { open: i, close: matchBrace(src, i) }
    }
    i++
  }
  return null
}

/** Index of the `}` matching the `{` at `openIdx`, or -1. */
function matchBrace(src, openIdx) {
  const n = src.length
  let depth = 0
  let i = openIdx
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      i = skipLineComment(src, i)
      continue
    }
    if (c === '/' && next === '*') {
      i = skipBlockComment(src, i)
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i = endOfToken(src, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** Replace `source[start, end)` with spaces, keeping every newline. */
function blankRange(source, start, end) {
  let out = ''
  for (let i = start; i < end; i++) out += source[i] === '\n' ? '\n' : ' '
  return source.slice(0, start) + out + source.slice(end)
}

/**
 * Blank the body of every named predicate declaration. Spans are collected
 * against the ORIGINAL source, then applied right-to-left so indices stay
 * valid.
 */
export function blankNamedPredicateBodies(source) {
  const spans = []
  for (const name of NAMED_PREDICATE_EXPORTS) {
    const re = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g')
    let m
    while ((m = re.exec(source))) {
      const span = bodySpan(source, m.index + m[0].length)
      if (span && span.close > -1) spans.push(span)
    }
  }
  let out = source
  for (const { open, close } of spans.sort((a, b) => b.open - a.open)) {
    out = blankRange(out, open, close + 1)
  }
  return out
}

/** The template literal's SQL text with every ${…} replaced by `$«expr»`. */
export function sqlOfTemplateSpan(source, span) {
  const contentStart = span.start + 1
  let sql = ''
  let last = 0
  for (const interp of span.interps) {
    const s = interp.start - contentStart
    const e = interp.end - contentStart
    if (s < 0 || e < 0) continue
    sql += contentSlice(source, contentStart, last, s) + ' $«expr» '
    last = e + 1
  }
  sql += contentSlice(source, contentStart, last, span.end - contentStart)
  return sql
}

function contentSlice(source, contentStart, from, to) {
  return source.slice(contentStart + from, contentStart + to)
}

/**
 * Count the read predicates in one file's already-blanked source. `relPath`
 * decides the role: `packages/backend/src/**` is scanned for SQL reads and
 * the payment-window mirror; the client packages are scanned for the TS
 * status/time restatements. Returns `{}` when nothing counts.
 */
export function scanFile(source, relPath) {
  const counts = {}
  const blanked = blankNamedPredicateBodies(source)
  const isBackend = relPath.startsWith('packages/backend/src')

  if (isBackend) {
    for (const span of templateSpans(blanked)) {
      const sql = sqlOfTemplateSpan(blanked, span)
      for (const stmt of sql.split(';')) {
        if (!READ_STATEMENT_RE.test(stmt)) continue
        if (!BUDGET_TABLES_RE.test(stmt)) continue
        const ranges = whereRanges(stmt)
        if (ranges.length === 0) continue
        const ctx = sqlContext(stmt)
        const add = (m, key) => {
          if (!inRanges(m.index, ranges)) return
          if (!attributesToBudgetTable(ctx, m.index)) return
          counts[key] = (counts[key] ?? 0) + 1
        }
        for (const m of matchAll(stmt, STATUS_LITERAL_RE)) add(m, 'sql-status-literal')
        for (const m of matchAll(stmt, STATUS_IN_RE)) add(m, 'sql-status-literal')
        for (const m of matchAll(stmt, TIME_NOW_RE)) add(m, 'sql-time-now')
      }
    }
    const windows = countMatches(blanked, PAYMENT_WINDOW_RE)
    if (windows > 0) counts['ts-payment-window'] = windows
  } else {
    let statusSites = 0
    for (const m of matchAll(blanked, CLIENT_TS_STATUS_RE)) {
      if (isBudgetShaped(blanked, m.index, m[1], { atLeast: 1 })) statusSites++
    }
    if (statusSites > 0) counts['ts-status-liveness'] = statusSites

    let timeSites = 0
    for (const m of matchAll(blanked, CLIENT_TS_TIME_RE)) {
      if (!NOWISH_RE.test(m[2])) continue
      if (isBudgetShaped(blanked, m.index, m[1], { atLeast: 2 })) timeSites++
    }
    if (timeSites > 0) counts['ts-time-now'] = timeSites
  }
  return counts
}

/**
 * The `[start, end)` spans of the statement's WHERE clauses: from each
 * `WHERE` to the next one (or the end of the statement). JOIN `ON`
 * predicates are outside every range and are never counted — the epic
 * counts `SELECT … WHERE` reads.
 */
function whereRanges(stmt) {
  const ranges = []
  const marks = [...stmt.matchAll(/\bwhere\b/gi)].map((m) => m.index + m[0].length)
  for (let i = 0; i < marks.length; i++) {
    ranges.push([marks[i], i + 1 < marks.length ? marks[i + 1] : stmt.length])
  }
  return ranges
}

function inRanges(pos, ranges) {
  return ranges.some(([s, e]) => pos >= s && pos < e)
}

const SQL_ALIAS_KEYWORDS = new Set([
  'where', 'on', 'and', 'or', 'select', 'from', 'join', 'left', 'right', 'inner', 'outer',
  'as', 'order', 'group', 'by', 'limit', 'offset', 'with', 'into', 'values', 'set',
  'update', 'returning', 'union', 'except', 'when', 'then', 'else', 'end', 'case', 'using',
])

/**
 * Paren-depth map plus every mention of the three budget tables, so a
 * predicate can be attributed to the table it filters rather than to the
 * statement it rides in. The statement-level check alone mis-attributes:
 * the agents overview carries `mpre.status = 'open'` (on
 * `machine_payment_reconciliation_events`) in the same statement as an
 * `agent_delegations` subselect — the mpre predicate is NOT budget debt.
 */
function sqlContext(stmt) {
  const n = stmt.length
  const depth = new Array(n)
  let d = 0
  let i = 0
  while (i < n) {
    const c = stmt[i]
    if (c === "'") {
      depth[i] = d
      i++
      while (i < n) {
        depth[i] = d
        if (stmt[i] === "'") {
          if (stmt[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '-' && stmt[i + 1] === '-') {
      const e = stmt.indexOf('\n', i)
      i = e === -1 ? n : e
      continue
    }
    if (c === '/' && stmt[i + 1] === '*') {
      const e = stmt.indexOf('*/', i + 2)
      i = e === -1 ? n : e + 2
      continue
    }
    depth[i] = d
    if (c === '(') d++
    else if (c === ')') d = Math.max(0, d - 1)
    i++
  }
  const counted = []
  const aliasTable = new Map()
  for (const m of stmt.matchAll(/\b(agent_delegations|agent_task_budgets|agent_sub_budgets)\b/g)) {
    const rest = stmt.slice(m.index + m[0].length)
    const alias = sqlAliasOf(rest)
    counted.push({ pos: m.index, depth: depth[m.index], alias })
  }
  for (const m of stmt.matchAll(/\b(?:from|join)\s+([a-z_][\w$]*)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/gi)) {
    const table = m[1].toLowerCase()
    let alias = m[2] ?? sqlAliasOf(stmt.slice(m.index + m[0].length))
    if (alias) alias = alias.toLowerCase()
    if (alias && !SQL_ALIAS_KEYWORDS.has(alias)) aliasTable.set(alias, table)
    if (!alias) aliasTable.set(table, table)
  }
  return { stmt, depth, counted, aliasTable }
}

/** The alias a table mention carries, or undefined. */
function sqlAliasOf(rest) {
  let m = /^\s+/.exec(rest)
  if (!m) return undefined
  rest = rest.slice(m[0].length)
  m = /^as\s+/i.exec(rest)
  if (m) rest = rest.slice(m[0].length)
  m = /^([a-z_][\w$]*)/i.exec(rest)
  if (!m) return undefined
  return SQL_ALIAS_KEYWORDS.has(m[1].toLowerCase()) ? undefined : m[1]
}

/**
 * Whether the predicate match at `pos` filters one of the three budget
 * tables. A qualified predicate (`mpre.status`) is decided by its alias; an
 * unqualified one by a same-depth mention of a budget table preceding it
 * (the house style only leaves predicates unqualified when the query
 * touches one table). An unknown qualifier falls back to the nearest
 * preceding budget-table mention, any depth — a subselect can reference an
 * outer alias (SQL correlated subqueries).
 */
function attributesToBudgetTable(ctx, pos) {
  const COUNTED_RE = /^agent_(delegations|task_budgets|sub_budgets)$/
  const before = ctx.stmt ? ctx.stmt.slice(0, pos) : ''
  const qm = /([A-Za-z_][\w$]*)\s*\.\s*$/.exec(before)
  const qualifier = qm ? qm[1].toLowerCase() : null
  if (qualifier) {
    const table = ctx.aliasTable.get(qualifier)
    if (table !== undefined) return COUNTED_RE.test(table)
    return ctx.counted.some((c) => c.pos < pos)
  }
  const d = ctx.depth[Math.min(pos, ctx.depth.length - 1)]
  return ctx.counted.some((c) => c.pos < pos && c.depth === d)
}

function countMatches(text, re) {
  return matchAll(text, re).length
}

function matchAll(text, re) {
  // A shared global regex object carries lastIndex between calls; match with
  // a fresh clone so exported patterns stay reusable.
  return [...text.matchAll(new RegExp(re.source, re.flags))]
}

const WINDOW_RADIUS_LINES = 6

/**
 * Whether the object behind `receiver` is budget-shaped, decided textually:
 * a budget/delegation receiver name, or — within ±6 lines — the same
 * receiver touching a budget-row field, or a budget TYPE name annotating
 * the shape. For the time rule the match itself is already a field
 * reference, so `atLeast: 2` demands a SECOND field reference before the
 * window rule fires (a name match needs only one). Calibrated against the
 * tree: counts `row`/`tb`/`mine` budget sites in sdk/cli/frontend, refuses
 * `agent.status === 'active'` (dashboard-attention),
 * `a.status === 'active'` (IssueSubBudgetModal — AGENT candidates) and
 * `raw.status === 'pending'` (payment-state).
 */
export function isBudgetShaped(source, idx, receiver, { atLeast = 1 } = {}) {
  if (/budget|deleg/i.test(receiver)) return true
  const receiverField = new RegExp(
    `\\b${receiver.replace(/\$/g, '\\$')}\\??\\.`,
    'g',
  )
  const window = lineWindow(source, idx, WINDOW_RADIUS_LINES)
  const fieldHits = [...window.matchAll(new RegExp(receiverField.source + BUDGET_FIELD_RE.source, 'gi'))]
  if (fieldHits.length >= atLeast) return true
  // A budget TYPE name annotating the receiver in the window (e.g.
  // `status: DelegationBudget['status']` on the shape the receiver was
  // declared from) — \b keeps `hasUsableBudget(agent)` from counting.
  if (BUDGET_TYPE_RE.test(window)) return true
  // A named slice-A–C predicate applied to the receiver in the window
  // (`active.some((b) => delegationIsLive(b))`) marks the same shape.
  return new RegExp(NAMED_CALL_RE.source + receiver.replace(/\$/g, '\\$') + '\\s*[,)]').test(window)
}

/** The source text from `radius` lines before to `radius` lines after `idx`. */
export function lineWindow(source, idx, radius) {
  let line = 0
  for (let i = 0; i < idx; i++) if (source[i] === '\n') line++
  const lines = source.split('\n')
  return lines.slice(Math.max(0, line - radius), line + radius + 1).join('\n')
}

const TEST_FILE_RE = /(^|\/)(__tests__|__snapshots__)(\/|$)|\.test\.tsx?$|\.spec\.tsx?$/

async function* walkTs(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      yield* walkTs(p)
    } else if (/\.tsx?$/.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      yield p
    }
  }
}

export async function scanAll(root = REPO_ROOT) {
  const counts = {}
  const readCount = new Map()
  let filesScanned = 0
  for (const dir of SCAN_DIRS) {
    let read = 0
    for await (const file of walkTs(join(root, dir))) {
      read++
      const rel = relative(root, file).split(sep).join('/')
      const fileCounts = scanFile(await readFile(file, 'utf8'), rel)
      if (Object.keys(fileCounts).length > 0) counts[rel] = fileCounts
    }
    readCount.set(dir, read)
    filesScanned += read
  }
  return { counts, readCount, filesScanned }
}

function totals(counts) {
  const t = {}
  for (const keys of Object.values(counts)) {
    for (const [key, n] of Object.entries(keys)) t[key] = (t[key] ?? 0) + n
  }
  return t
}

async function main() {
  const { counts, readCount, filesScanned } = await scanAll()
  const zero = zeroScanEntries(SCAN_DIRS, readCount)
  if (zero.length > 0) {
    throw new TypeError(
      `budget-liveness: ${zero.join(', ')} matched no source files — a scan root that reads ` +
        'ZERO files would let --update write that zero in as the new baseline. Restore the ' +
        'missing package sources or fix the path.',
    )
  }

  const { baseline, firstRun } = loadBaseline(BASELINE_PATH)
  const acceptNew = process.argv.includes(ACCEPT_NEW_BASELINE_FLAG)
  const t = totals(counts)
  const parts = Object.entries(t)
    .map(([key, n]) => `${n} ${key}`)
    .join(', ')
  console.log(
    `budget-liveness gauge: ${parts || 'no counted sites'} across ${filesScanned} source file(s).`,
  )

  if (process.argv.includes('--update')) {
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
      console.error(
        'Growth is a reviewed decision: name the predicate once (slices A–C pattern, epic #3919) ' +
          'and point the reader at it, or make the case on the issue.',
      )
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  const violations = newViolations(counts, baseline)
  if (violations.length > 0) {
    console.error('\n✗ inline budget-liveness predicates grew (shrink-only baseline, #3924):\n')
    for (const v of violations) {
      console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    }
    console.error(
      '\nThe epic named every liveness predicate once — reuse the named copy ' +
        '(spendableDelegationSql / openTaskBudgetSql / delegationIsLive, …) instead of ' +
        'restating the comparison. If you legitimately REDUCED counts elsewhere, run: ' +
        'node scripts/lint-budget-liveness.mjs --update',
    )
    process.exit(1)
  }

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (counts are below the baseline — lock in the progress: node scripts/lint-budget-liveness.mjs --update)',
    )
  }
  console.log('✓ no new inline budget-liveness predicates.')
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGate('lint-budget-liveness', main)
}
