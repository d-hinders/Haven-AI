/**
 * Redact the Claude Code lane's per-trial session transcripts before they
 * leave the runner (#4137, epic #3957).
 *
 * The eval job holds the owner's subscription token, the eval agent's API key
 * and delegate private key, and an RPC URL that embeds a provider key. The
 * session streams (`<base>.<task>.trial<N>.jsonl`, written by
 * `claude-code.ts`) are uploaded as an artifact any signed-in account can
 * download, on a public repository, and GitHub's `***` log masking does not
 * apply to artifact contents. So this module is fail-closed by construction:
 *
 *  1. CONFIGURATION: every REQUIRED secret name must be set, or nothing is
 *     written at all. OPTIONAL names (the `vars.X || secrets.X` fallbacks)
 *     are redacted only when set.
 *  2. REDACT into a staging directory. A line that parses as JSON is walked
 *     structurally (every string that is itself JSON, such as the hosted
 *     envelope inside a `tool_result` text block, is parsed, redacted and
 *     re-serialized in place); a line that does NOT parse (a stream truncated
 *     by SIGKILL) goes through the string rules. No line is ever copied raw.
 *  3. SCAN the staged output with a SEPARATE set of detectors, one per rule
 *     class (exact values and every pattern class, not only the exact
 *     values). The detectors are independent code from the redaction rules,
 *     so a rule that stops redacting is caught by its detector.
 *  4. MOVE to the upload directory only on a clean scan. Any hit moves
 *     nothing, names each class and its count (never a value), and fails.
 *
 * Every redaction replaces the WHOLE value, prefix included, with
 * `[REDACTED:<class>]` (never `sk_agent_[REDACTED]`), so a grep for a prefix
 * over the artifact can reach 0.
 *
 * Kept on purpose (#4138 needs them): tool names, `next_tool_name`, `code` /
 * `error_code`, `payment_id`, idempotency keys, addresses, tx hashes,
 * amounts, the agent's text, and the variable URLs (the hosted MCP URL, the
 * backend URL, the merchant URLs). A URL-shaped secret keeps its shape: only
 * its key-bearing segments go.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseMaybeJson } from './json-reading.js'

// ── Rule classes ───────────────────────────────────────────────────────────

export const REDACTION_CLASSES = [
  'secret-exact',
  'rpc-key',
  'agent-key',
  'anthropic-key',
  'auth-header',
  'payment-header',
  'siwx-header',
  'signature',
  'b64-json',
  'merchant-body',
] as const
export type RedactionClass = (typeof REDACTION_CLASSES)[number]
export type ClassCounts = Record<RedactionClass, number>

/** The marker that replaces a whole redacted value. */
export function marker(cls: RedactionClass): string {
  return `[REDACTED:${cls}]`
}

const MARKER_RE = /^\[REDACTED:[a-z0-9-]+\]$/
const isMarker = (v: unknown): boolean => typeof v === 'string' && MARKER_RE.test(v)

export function zeroCounts(): ClassCounts {
  return Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])) as ClassCounts
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Secrets ────────────────────────────────────────────────────────────────

/** One string the transcripts must not carry, as a global regex. */
interface Needle {
  cls: 'secret-exact' | 'rpc-key'
  re: RegExp
}

export interface LoadedSecrets {
  /** Names whose values were loaded (required plus the optional ones set). */
  loaded: string[]
  /** Optional names that were empty, so nothing is redacted for them. */
  optionalUnset: string[]
  /** URL-shaped secrets with no key-bearing segment: kept whole, by design. */
  urlsWithoutKey: string[]
  needles: Needle[]
}

export type LoadSecretsResult = { ok: true; secrets: LoadedSecrets } | { ok: false; missing: string[] }

/**
 * The key-like pieces of an endpoint URL: path segments, query keys and
 * values, and the fragment, of 12+ characters and without a colon. The same
 * rule as `secretSegments` in `packages/backend/src/infra/chain/rpc-transport.ts`
 * (#3371, #3391), which `scrubTransportErrorSecrets` uses: never the host, so
 * the URL keeps its shape. qa-agent cannot import the backend, so this is a
 * copy of the rule, plus the basic-auth password, which that rule leaves to
 * its callers.
 */
export function urlKeySegments(url: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  const parts = [
    ...parsed.pathname.split('/'),
    ...parsed.search.replace(/^\?/, '').split(/[&=]/),
    parsed.hash.slice(1),
  ].filter((part) => part.length >= 12 && !part.includes(':'))
  if (parsed.password) parts.push(parsed.password)
  if (parsed.username.length >= 12) parts.push(parsed.username)
  return [...new Set(parts)]
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** The raw text plus its JSON-escaped forms (one and two levels deep). */
function escapedForms(s: string): string[] {
  const once = JSON.stringify(s).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  return [...new Set([s, once, twice])]
}

function needlesFor(value: string): Needle[] {
  // A 32-byte hex key (the delegate key) has the shape of a tx hash, which
  // the transcripts must keep: only ITS exact value goes, case-insensitively,
  // with and without `0x`.
  const hex = value.match(/^(?:0x)?([0-9a-fA-F]{64})$/)
  if (hex) return [{ cls: 'secret-exact', re: new RegExp(`(?:0x)?${hex[1]}`, 'gi') }]
  // A URL-shaped secret (the RPC URL, or a fallback URL set as a secret)
  // keeps its shape: only its key-bearing segments go, and the host never
  // does. A URL with no such segment carries no key under that rule, so
  // nothing is removed (the caller warns, by name).
  if (isHttpUrl(value)) {
    return urlKeySegments(value)
      .sort((a, b) => b.length - a.length)
      .flatMap((seg) => escapedForms(seg).map((form) => ({ cls: 'rpc-key' as const, re: new RegExp(escapeRe(form), 'g') })))
  }
  return escapedForms(value).map((form) => ({ cls: 'secret-exact' as const, re: new RegExp(escapeRe(form), 'g') }))
}

/**
 * Load the named secrets from `env`. Fail-closed: an empty (or
 * whitespace-only) REQUIRED name refuses the whole run.
 */
export function loadSecrets(
  env: Record<string, string | undefined>,
  required: readonly string[],
  optional: readonly string[],
): LoadSecretsResult {
  const valueOf = (name: string) => (env[name] ?? '').trim()
  const missing = required.filter((name) => valueOf(name) === '')
  if (required.length === 0) return { ok: false, missing: ['(no required secret names were given)'] }
  if (missing.length > 0) return { ok: false, missing }
  const optionalSet = optional.filter((name) => valueOf(name) !== '')
  const loaded = [...required, ...optionalSet]
  const values = [...new Set(loaded.map(valueOf))]
  // Longest first, so a secret that contains another is removed whole.
  values.sort((a, b) => b.length - a.length)
  return {
    ok: true,
    secrets: {
      loaded,
      optionalUnset: optional.filter((name) => valueOf(name) === ''),
      urlsWithoutKey: loaded.filter((name) => isHttpUrl(valueOf(name)) && urlKeySegments(valueOf(name)).length === 0),
      needles: values.flatMap(needlesFor),
    },
  }
}

// ── Redaction rules ────────────────────────────────────────────────────────
//
// Two kinds: KEY rules (a field whose name says what its value is) and STRING
// rules (a pattern anywhere in any string). In a parsed line the key rules
// run first on each field; every remaining string, and every key, gets the
// string rules. An unparseable line gets only the string rules, which include
// text forms of the key rules.

const PAYMENT_KEY = /^(?:payment[_-]header|payment[_-]signature|x[_-]payment)$/i
const SIWX_KEY = /^(?:sign[_-]in[_-]with[_-]x(?:[_-]header)?)$/i
const AUTH_KEY = /^(?:authorization|proxy[_-]authorization)$/i
const SIGNATURE_KEY = /^(?:.*[_-])?signature$/i
const MERCHANT_BODY_KEY = /^merchant[_-]body$/i

/** MCP content-block discriminators kept inside a stripped merchant body. */
const MCP_CONTENT_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link'])

/** Which class, if any, a field's NAME assigns to its value. */
function keyClass(key: string, value: unknown): RedactionClass | undefined {
  if (value === null || value === undefined || isMarker(value)) return undefined
  const isString = typeof value === 'string'
  if (PAYMENT_KEY.test(key) && isString) return 'payment-header'
  if (SIWX_KEY.test(key) && isString) return 'siwx-header'
  if (AUTH_KEY.test(key) && isString) return 'auth-header'
  if (SIGNATURE_KEY.test(key) && isString) return 'signature'
  if (MERCHANT_BODY_KEY.test(key)) return 'merchant-body'
  return undefined
}

// Text forms of the key rules, for unparseable lines and free text: the key
// (quoted or not, at any JSON escape level), a `:` or `=`, then the value up
// to the next delimiter. A value that is already a marker is left alone.
const TEXT_KEY_RULES: Array<{ cls: RedactionClass; re: RegExp }> = [
  { cls: 'payment-header', re: /((?:\\*["'])?\b(?:payment[_-]header|payment[_-]signature|x[_-]payment)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?!\[REDACTED:)[^\s"'\\,;}\]]+/gi },
  { cls: 'siwx-header', re: /((?:\\*["'])?\b(?:sign[_-]in[_-]with[_-]x(?:[_-]header)?)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?!\[REDACTED:)[^\s"'\\,;}\]]+/gi },
  { cls: 'auth-header', re: /((?:\\*["'])?\b(?:proxy[_-])?authorization(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?!\[REDACTED:)(?![A-Za-z]+\s+\[REDACTED:)(?:[A-Za-z][A-Za-z0-9-]*\s+)?[^\s"'\\,;}\]]+/gi },
  { cls: 'signature', re: /((?:\\*["'])?\b(?:[A-Za-z0-9]+[_-])*signature(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?!\[REDACTED:)(?!null\b)[^\s"'\\,;}\]]+/gi },
]

/** The pattern rules, in application order. */
const PATTERN_RULES: Array<{ cls: RedactionClass; re: RegExp }> = [
  // `Bearer <token>` anywhere, the scheme word included.
  { cls: 'auth-header', re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi },
  { cls: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]*/g },
  { cls: 'agent-key', re: /sk_agent_[A-Za-z0-9_-]*/g },
  // A base64(url) blob of JSON (x402 headers, JWTs), with any `.`-joined
  // segments that follow it.
  { cls: 'b64-json', re: /eyJ[A-Za-z0-9+/_=-]{20,}(?:\.[A-Za-z0-9+/_=-]+){0,2}/g },
  // A 65-byte signature (`0x` + 130 hex) or anything longer.
  { cls: 'signature', re: /0x[0-9a-fA-F]{130,}/g },
]

export interface RedactOptions {
  secrets: LoadedSecrets
  /**
   * Classes whose redaction is switched off. Test-only: it lets the suite
   * prove, for every class, that the independent scan still catches what a
   * broken rule leaves behind. The CLI never sets it.
   */
  disabled?: ReadonlySet<RedactionClass>
}

class Redactor {
  readonly counts = zeroCounts()
  private readonly on: (cls: RedactionClass) => boolean

  constructor(private readonly opts: RedactOptions) {
    this.on = (cls) => !opts.disabled?.has(cls)
  }

  private replace(text: string, cls: RedactionClass, re: RegExp, keepGroup1 = false): string {
    if (!this.on(cls)) return text
    return text.replace(re, (...m: unknown[]) => {
      this.counts[cls] += 1
      return `${keepGroup1 ? (m[1] as string) : ''}${marker(cls)}`
    })
  }

  /** The string rules: secrets, then the text key rules, then the patterns. */
  strings(text: string): string {
    let out = text
    for (const needle of this.opts.secrets.needles) out = this.replace(out, needle.cls, needle.re)
    out = this.replace(out, 'auth-header', PATTERN_RULES[0].re)
    out = this.merchantBodyText(out)
    for (const rule of TEXT_KEY_RULES) out = this.replace(out, rule.cls, rule.re, true)
    for (const rule of PATTERN_RULES.slice(1)) out = this.replace(out, rule.cls, rule.re)
    return out
  }

  /**
   * An unparseable line that carries a paid-completion envelope (a
   * `payment_id` key) cannot be walked, so from its merchant `result` (or a
   * `merchant_body`) value to the end of the line is replaced: a truncated
   * line loses its tail rather than leak the paid body.
   */
  private merchantBodyText(text: string): string {
    if (!this.on('merchant-body')) return text
    const hasPaymentId = /(\\*)"payment_id\1"\s*:/.test(text)
    const re = hasPaymentId ? /(\\*)"(result|merchant[_-]body)\1"\s*:\s*/i : /(\\*)"(merchant[_-]body)\1"\s*:\s*/i
    const m = re.exec(text)
    if (!m) return text
    const start = m.index + m[0].length
    const rest = text.slice(start)
    const q = m[1]
    if (rest.startsWith(`${q}"${marker('merchant-body')}`)) return text
    this.counts['merchant-body'] += 1
    return `${text.slice(0, start)}${q}"${marker('merchant-body')}${q}"`
  }

  /** Strip a merchant's paid body: every string/number leaf goes; keys, nesting and flags stay. */
  private stripBody(value: unknown, parentKey?: string): unknown {
    if (typeof value === 'string') {
      if (isMarker(value)) return value
      if (parentKey === 'type' && MCP_CONTENT_TYPES.has(value)) return value
      this.counts['merchant-body'] += 1
      return marker('merchant-body')
    }
    if (typeof value === 'number') {
      this.counts['merchant-body'] += 1
      return marker('merchant-body')
    }
    if (Array.isArray(value)) return value.map((v) => this.stripBody(v))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [this.strings(k), this.stripBody(v, k)]))
    }
    return value
  }

  /** Walk a parsed value structurally. */
  value(value: unknown): unknown {
    if (typeof value === 'string') return this.stringValue(value)
    if (Array.isArray(value)) return value.map((v) => this.value(v))
    if (value === null || typeof value !== 'object') return value
    const obj = value as Record<string, unknown>
    // A hosted paid-completion envelope (`haven_complete_mcp_tool` /
    // `haven_settle_mcp_tool`, `paid-mcp-completion.ts`) carries the
    // merchant's paid result as `result` next to `payment_id`.
    const paidEnvelope = Object.hasOwn(obj, 'payment_id') && Object.hasOwn(obj, 'result')
    const out: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(obj)) {
      const safeKey = this.strings(key)
      if (paidEnvelope && key === 'result' && this.on('merchant-body')) {
        out[safeKey] = this.stripBody(member)
        continue
      }
      const cls = keyClass(key, member)
      if (cls && this.on(cls)) {
        this.counts[cls] += 1
        out[safeKey] = marker(cls)
        continue
      }
      out[safeKey] = this.value(member)
    }
    return out
  }

  /** A string leaf: nested JSON is parsed and walked; anything else takes the string rules. */
  private stringValue(text: string): string {
    const nested = parseMaybeJson(text)
    if (nested !== undefined && typeof nested === 'object' && nested !== null) {
      const indent = text.match(/\n( +)\S/)?.[1].length ?? 0
      return JSON.stringify(this.value(nested), null, indent || undefined)
    }
    return this.strings(text)
  }

  line(line: string): string {
    if (line.trim() === '') return line
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Not JSON (a stream cut off by SIGKILL): string rules, never raw.
      return this.strings(line)
    }
    return JSON.stringify(this.value(parsed))
  }
}

/** Redact one session stream's text. Returns the redacted text and per-class counts. */
export function redactSessionText(raw: string, opts: RedactOptions): { text: string; counts: ClassCounts } {
  const r = new Redactor(opts)
  const text = raw
    .split('\n')
    .map((line) => r.line(line))
    .join('\n')
  return { text, counts: r.counts }
}

// ── The scan ───────────────────────────────────────────────────────────────
//
// Deliberately NOT the redaction rules run again: an independent detector per
// class, so a rule that stops redacting is caught by its detector (B2). The
// detectors mirror the acceptance grep on #4137 and the key rules above.

const DETECT_TEXT: Array<{ cls: RedactionClass; re: RegExp }> = [
  { cls: 'agent-key', re: /sk_agent_/g },
  { cls: 'anthropic-key', re: /sk-ant-/g },
  { cls: 'auth-header', re: /\bBearer\s+[A-Za-z0-9]/gi },
  { cls: 'auth-header', re: /\bauthorization\\*["']?\s*[:=]\s*\\*["']?(?!\[REDACTED:)(?![A-Za-z]+\s+\[REDACTED:)[A-Za-z0-9]/gi },
  { cls: 'payment-header', re: /\b(?:payment[_-]header|payment[_-]signature|x[_-]payment)\\*["']?\s*[:=]\s*\\*["']?(?!\[REDACTED:)[A-Za-z0-9]/gi },
  { cls: 'siwx-header', re: /\bsign[_-]in[_-]with[_-]x(?:[_-]header)?\\*["']?\s*[:=]\s*\\*["']?(?!\[REDACTED:)[A-Za-z0-9]/gi },
  { cls: 'signature', re: /0x[0-9a-fA-F]{130}/g },
  { cls: 'signature', re: /\b(?:[A-Za-z0-9]+[_-])*signature\\*["']?\s*[:=]\s*\\*["']?(?!\[REDACTED:)(?!null\b)[A-Za-z0-9{[]/gi },
  { cls: 'b64-json', re: /eyJ[A-Za-z0-9_-]{20,}/g },
  { cls: 'merchant-body', re: /merchant[_-]body\\*"\s*:(?!\s*\\*"\[REDACTED:)(?!\s*null\b)/gi },
]

class Scanner {
  readonly counts = zeroCounts()

  constructor(private readonly secrets: LoadedSecrets) {}

  private hit(cls: RedactionClass, n = 1) {
    this.counts[cls] += n
  }

  text(text: string) {
    for (const needle of this.secrets.needles) {
      const n = text.match(new RegExp(needle.re.source, needle.re.flags))?.length ?? 0
      if (n) this.hit(needle.cls, n)
    }
    for (const rule of DETECT_TEXT) {
      const n = text.match(rule.re)?.length ?? 0
      if (n) this.hit(rule.cls, n)
    }
    if (/(\\*)"payment_id\1"\s*:/.test(text)) {
      const n = text.match(/(\\*)"result\1"\s*:(?!\s*\\*"\[REDACTED:merchant-body\])/g)?.length ?? 0
      if (n) this.hit('merchant-body', n)
    }
  }

  private bodyLeaks(value: unknown, parentKey?: string): number {
    if (typeof value === 'string') return isMarker(value) || (parentKey === 'type' && MCP_CONTENT_TYPES.has(value)) ? 0 : 1
    if (typeof value === 'number') return 1
    if (Array.isArray(value)) return value.reduce<number>((n, v) => n + this.bodyLeaks(v), 0)
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).reduce<number>((n, [k, v]) => n + this.bodyLeaks(v, k), 0)
    }
    return 0
  }

  value(value: unknown) {
    if (typeof value === 'string') {
      const nested = parseMaybeJson(value)
      if (nested !== undefined && typeof nested === 'object' && nested !== null) this.value(nested)
      else this.text(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((v) => this.value(v))
      return
    }
    if (value === null || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    const paidEnvelope = Object.hasOwn(obj, 'payment_id') && Object.hasOwn(obj, 'result')
    for (const [key, member] of Object.entries(obj)) {
      this.text(key)
      if (member === null || member === undefined) continue
      if (paidEnvelope && key === 'result') {
        const n = this.bodyLeaks(member)
        if (n) this.hit('merchant-body', n)
        // The keys inside still get every other detector.
        this.value(member)
        continue
      }
      const unredacted = !isMarker(member)
      if (unredacted && typeof member === 'string') {
        if (/^(?:payment[_-]header|payment[_-]signature|x[_-]payment)$/i.test(key)) this.hit('payment-header')
        else if (/^sign[_-]in[_-]with[_-]x(?:[_-]header)?$/i.test(key)) this.hit('siwx-header')
        else if (/^(?:proxy[_-])?authorization$/i.test(key)) this.hit('auth-header')
      }
      if (unredacted && typeof member === 'string' && /^(?:.*[_-])?signature$/i.test(key) && !/^payment[_-]signature$/i.test(key)) this.hit('signature')
      if (unredacted && /^merchant[_-]body$/i.test(key)) this.hit('merchant-body')
      this.value(member)
    }
  }

  line(line: string) {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.text(line)
      return
    }
    this.value(parsed)
  }
}

/** Scan (already redacted) session text with the independent detectors. */
export function scanSessionText(text: string, secrets: LoadedSecrets): ClassCounts {
  const s = new Scanner(secrets)
  for (const line of text.split('\n')) s.line(line)
  return s.counts
}

export function totalOf(counts: ClassCounts): number {
  return REDACTION_CLASSES.reduce((n, c) => n + counts[c], 0)
}

function formatCounts(counts: ClassCounts): string {
  return REDACTION_CLASSES.map((c) => `${c}: ${counts[c]}`).join(', ')
}

// ── The pipeline: refuse, stage, scan, move ────────────────────────────────

export interface RedactRunOptions {
  /** The adapter's log base (`QA_EVAL_CLAUDE_CODE_SESSION_LOG`): files are `<base>.<task>.trial<N>.jsonl`. */
  inPrefix: string
  stageDir: string
  outDir: string
  required: readonly string[]
  optional: readonly string[]
  env: Record<string, string | undefined>
  /** `$GITHUB_OUTPUT`, when set: receives `clean=true` or `clean=false`. */
  githubOutput?: string
  log?: (line: string) => void
  /** Test-only, see `RedactOptions.disabled`. */
  disabled?: ReadonlySet<RedactionClass>
}

export interface RedactRunResult {
  clean: boolean
  /** Required names that were empty (the run refused and wrote nothing). */
  refused?: string[]
  files: string[]
  rawCounts: ClassCounts
  scanCounts: ClassCounts
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0
  } catch {
    return true
  }
}

async function listSessionFiles(inPrefix: string): Promise<string[]> {
  const dir = dirname(inPrefix)
  const stem = `${basename(inPrefix)}.`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  return entries.filter((name) => name.startsWith(stem) && name.endsWith('.jsonl')).sort()
}

export async function runRedaction(opts: RedactRunOptions): Promise<RedactRunResult> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const rawCounts = zeroCounts()
  const scanCounts = zeroCounts()
  const finish = async (result: RedactRunResult): Promise<RedactRunResult> => {
    if (opts.githubOutput) await appendFile(opts.githubOutput, `clean=${result.clean ? 'true' : 'false'}\n`)
    return result
  }

  const loaded = loadSecrets(opts.env, opts.required, opts.optional)
  if (!loaded.ok) {
    log(`::error::redact-sessions refused, nothing written: required secret(s) empty: ${loaded.missing.join(', ')}`)
    return finish({ clean: false, refused: loaded.missing, files: [], rawCounts, scanCounts })
  }
  const { secrets } = loaded
  log(
    `redact-sessions: loaded ${secrets.loaded.length} secret(s): ${secrets.loaded.join(', ')}` +
      (secrets.optionalUnset.length ? `; optional, not set (nothing to redact): ${secrets.optionalUnset.join(', ')}` : ''),
  )
  for (const name of secrets.urlsWithoutKey) {
    log(`::warning::redact-sessions: ${name} is a URL with no key-bearing segment, so it is kept as it is`)
  }
  if (!(await isEmptyOrMissing(opts.stageDir)) || !(await isEmptyOrMissing(opts.outDir))) {
    log('::error::redact-sessions refused, nothing written: the staging or upload directory is not empty')
    return finish({ clean: false, refused: [], files: [], rawCounts, scanCounts })
  }

  const files = await listSessionFiles(opts.inPrefix)
  await mkdir(opts.stageDir, { recursive: true })
  for (const name of files) {
    const raw = await readFile(join(dirname(opts.inPrefix), name), 'utf8')
    const { text, counts } = redactSessionText(raw, { secrets, disabled: opts.disabled })
    for (const c of REDACTION_CLASSES) rawCounts[c] += counts[c]
    await writeFile(join(opts.stageDir, name), text, { mode: 0o600 })
  }
  // The positive control: what the rules found in the RAW input (numbers only).
  log(`redact-sessions: ${files.length} session file(s); redacted in the raw input: ${formatCounts(rawCounts)}`)

  for (const name of files) {
    const counts = scanSessionText(await readFile(join(opts.stageDir, name), 'utf8'), secrets)
    for (const c of REDACTION_CLASSES) scanCounts[c] += counts[c]
  }
  if (totalOf(scanCounts) > 0) {
    for (const c of REDACTION_CLASSES) {
      if (scanCounts[c] > 0) log(`::error::redact-sessions scan hit after redaction: ${c}: ${scanCounts[c]} — nothing uploaded`)
    }
    await rm(opts.stageDir, { recursive: true, force: true })
    return finish({ clean: false, files, rawCounts, scanCounts })
  }

  await mkdir(opts.outDir, { recursive: true })
  for (const name of files) await rename(join(opts.stageDir, name), join(opts.outDir, name))
  log(`redact-sessions: scan clean; ${files.length} file(s) ready for upload`)
  return finish({ clean: true, files, rawCounts, scanCounts })
}
