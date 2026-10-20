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
 *  3. SCAN the staged output with a SEPARATE detector per rule class. The
 *     scanner shares no code path with the redactor's rules: it builds its
 *     exact-value detectors from the raw secret values itself (a lowercased
 *     substring search over decoded strings and their JSON-escaped forms, its
 *     own URL splitter, a base64 DECODE of every base64-looking run), and it
 *     finds a merchant body with a different, broader predicate (any nested
 *     `result`) than the redactor's (the paid tool's results, or a `result`
 *     beside `payment_id` / `settlement_tx_hash`). A rule that stops
 *     redacting, or a needle built wrong, is caught by the scan.
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
 *
 * The agent's own assistant text and the stream's `{"type":"result"}` line
 * are kept even when they restate paid content (owner decision 2026-10-20).
 * One fail-safe cut still reaches them: a string that literally quotes a
 * JSON `"result":` key, or the `Merchant response:` label, is cut from that
 * point, because the scanner flags the same shapes and not cutting would
 * fail the run instead.
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

/** The paid MCP tools whose results carry the merchant's paid body. */
const PAID_TOOL = /(?:^|__)haven_(?:complete|settle)_mcp_tool$/

/**
 * Decode `\uXXXX` escapes (at any escape level) that stand for a printable
 * character other than a quote or a backslash, so an escaped `sk_agent_`
 * on a line that cannot be parsed is seen as `sk_agent_`. Structure
 * characters stay escaped.
 */
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\{1,8}u([0-9a-fA-F]{4})/g, (whole, hex: string) => {
    const code = Number.parseInt(hex, 16)
    return code >= 0x20 && code < 0x7f && code !== 0x22 && code !== 0x5c ? String.fromCharCode(code) : whole
  })
}

// ── Secrets ────────────────────────────────────────────────────────────────

/** One string the transcripts must not carry, as a global regex. */
interface Needle {
  cls: 'secret-exact' | 'rpc-key'
  re: RegExp
}

/** A loaded secret as the environment gave it (trimmed). The scanner reads only these. */
export interface RawSecret {
  name: string
  value: string
  required: boolean
}

export interface LoadedSecrets {
  /** Names whose values were loaded (required plus the optional ones set). */
  loaded: string[]
  /** Optional names that were empty, so nothing is redacted for them. */
  optionalUnset: string[]
  /** OPTIONAL URL-shaped secrets with no key-bearing segment: kept whole, with a warning. */
  urlsWithoutKey: string[]
  /** The redactor's needles. */
  needles: Needle[]
  /** The values themselves, for the scanner's own detectors. */
  raw: RawSecret[]
}

export type LoadSecretsResult = { ok: true; secrets: LoadedSecrets } | { ok: false; missing: string[] }

/**
 * Network slugs that pass the 12+ character rule but are public, never a key:
 * redacting them would blank the chain name out of every RPC error #4138 reads.
 */
const NETWORK_SLUGS = new Set([
  'base-sepolia',
  'base_sepolia',
  'base-mainnet',
  'base_mainnet',
  'polygon-amoy',
  'optimism-sepolia',
  'arbitrum-sepolia',
  'ethereum-sepolia',
  'eth-sepolia-testnet',
])

/**
 * The key-like pieces of an endpoint URL: path segments, query keys and
 * values, and the fragment, of 12+ characters and without a colon. The same
 * rule as `secretSegments` in `packages/backend/src/infra/chain/rpc-transport.ts`
 * (#3371, #3391), which `scrubTransportErrorSecrets` uses: never the host, so
 * the URL keeps its shape. qa-agent cannot import the backend, so this is a
 * copy of the rule, plus the basic-auth userinfo (which that rule leaves to
 * its callers), minus the public network slugs above.
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
  ].filter((part) => part.length >= 12 && !part.includes(':') && !NETWORK_SLUGS.has(part.toLowerCase()))
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

/**
 * The base64 and base64url renderings of `value` at each of the three byte
 * alignments it can have inside a longer blob: only the characters that
 * encode the value's own bytes, so the blob around it does not matter.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  const forms: string[] = []
  for (let k = 0; k < 3; k++) {
    const encoded = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64').replace(/=+$/, '')
    const start = Math.ceil((8 * k) / 6)
    const end = Math.floor((8 * (k + bytes.length)) / 6)
    const core = encoded.slice(start, end)
    if (core.length >= 16) forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return [...new Set(forms)]
}

const PREFIXED_KEY = /^(?:sk_agent_|sk-ant-)(.+)$/

function exactNeedles(forms: string[]): Needle[] {
  return [...new Set(forms)]
    .filter((f) => f.length > 0)
    .sort((a, b) => b.length - a.length)
    .flatMap((f) => escapedForms(f).map((form) => ({ cls: 'secret-exact' as const, re: new RegExp(escapeRe(form), 'g') })))
}

function needlesFor(value: string, required: boolean): Needle[] {
  // A 32-byte hex key (the delegate key) has the shape of a tx hash, which
  // the transcripts must keep: only ITS exact value goes, case-insensitively,
  // with and without `0x`.
  const hex = value.match(/^(?:0x)?([0-9a-fA-F]{64})$/)
  if (hex) {
    const body = hex[1]
    return [
      { cls: 'secret-exact', re: new RegExp(`(?:0x)?${body}`, 'gi') },
      ...exactNeedles([`0x${body.toLowerCase()}`, body.toLowerCase(), body.toUpperCase()].flatMap(base64Forms)),
    ]
  }
  // A URL-shaped secret (the RPC URL, or a fallback URL set as a secret)
  // keeps its shape: only its key-bearing segments go, and the host never
  // does. A REQUIRED URL with no such segment is redacted whole (the key may
  // sit where the rule cannot see it); an optional one is kept, with a warning.
  if (isHttpUrl(value)) {
    const segments = urlKeySegments(value)
    if (segments.length > 0) {
      return segments
        .sort((a, b) => b.length - a.length)
        .flatMap((seg) => [seg, ...base64Forms(seg)])
        .flatMap((seg) => escapedForms(seg).map((form) => ({ cls: 'rpc-key' as const, re: new RegExp(escapeRe(form), 'g') })))
    }
    return required ? exactNeedles([value, ...base64Forms(value)]) : []
  }
  // The value, its base64 forms, and (for an `sk_agent_` / `sk-ant-` key)
  // its body without the prefix, so a stripped prefix does not save it.
  const body = value.match(PREFIXED_KEY)?.[1]
  return exactNeedles([value, ...base64Forms(value), ...(body && body.length >= 12 ? [body, ...base64Forms(body)] : [])])
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
  const raw: RawSecret[] = [
    ...required.map((name) => ({ name, value: valueOf(name), required: true })),
    ...optionalSet.map((name) => ({ name, value: valueOf(name), required: false })),
  ]
  // Longest first, so a secret that contains another is removed whole.
  const ordered = [...raw].sort((a, b) => b.value.length - a.value.length)
  return {
    ok: true,
    secrets: {
      loaded: raw.map((s) => s.name),
      optionalUnset: optional.filter((name) => valueOf(name) === ''),
      urlsWithoutKey: raw.filter((s) => !s.required && isHttpUrl(s.value) && urlKeySegments(s.value).length === 0).map((s) => s.name),
      needles: ordered.flatMap((s) => needlesFor(s.value, s.required)),
      raw,
    },
  }
}

// ── Redaction rules ────────────────────────────────────────────────────────
//
// Two kinds: KEY rules (a field whose name says what its value is) and STRING
// rules (a pattern anywhere in any string). In a parsed line the key rules
// run first on each field; every remaining string, and every key, gets the
// string rules. An unparseable line gets only the string rules, which include
// text forms of the key rules. Key names are compared lowercased with `_` and
// `-` removed, so `paymentHeader`, `PAYMENT-SIGNATURE` and `x_payment` match.

const normKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '')
const PAYMENT_KEYS = new Set(['paymentheader', 'paymentsignature', 'xpayment'])
const SIWX_KEYS = new Set(['signinwithx', 'signinwithxheader'])
const AUTH_KEYS = new Set(['authorization', 'proxyauthorization'])

/** MCP content-block discriminators kept inside a stripped merchant body. */
const MCP_CONTENT_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link'])

/** Which class, if any, a field's NAME assigns to its (string) value. */
function keyClass(key: string, value: unknown): RedactionClass | undefined {
  if (value === null || value === undefined || isMarker(value)) return undefined
  const k = normKey(key)
  if (k === 'merchantbody') return 'merchant-body'
  if (typeof value !== 'string') return undefined
  if (PAYMENT_KEYS.has(k)) return 'payment-header'
  if (SIWX_KEYS.has(k)) return 'siwx-header'
  if (AUTH_KEYS.has(k)) return 'auth-header'
  if (k.endsWith('signature')) return 'signature'
  return undefined
}

// Text forms of the key rules, for unparseable lines and free text: the key
// (quoted or not, at up to 8 JSON escape levels), a `:` or `=`, then the
// value up to the next delimiter. A value that is already a marker is left
// alone. Every repetition is bounded, so a hostile line stays linear.
const Q = `(?:\\\\{0,8}["'])?`
const VALUE = `[^\\s"'\\\\,;}\\]]+`
const textKeyRule = (cls: RedactionClass, key: string, valuePrefix = '') => ({
  cls,
  re: new RegExp(`(${key}${Q}\\s{0,8}[:=]\\s{0,8}${Q})(?!\\[REDACTED:)${valuePrefix}${VALUE}`, 'gi'),
})
const TEXT_KEY_RULES: Array<{ cls: RedactionClass; re: RegExp }> = [
  textKeyRule('payment-header', '\\b(?:payment[_-]?header|payment[_-]?signature|x[_-]?payment)'),
  textKeyRule('siwx-header', '\\bsign[_-]?in[_-]?with[_-]?x(?:[_-]?header)?'),
  textKeyRule('auth-header', '\\b(?:proxy[_-]?)?authorization', '(?![A-Za-z]{1,32}\\s{1,8}\\[REDACTED:)(?:[A-Za-z][A-Za-z0-9-]{0,31}\\s{1,8})?'),
  // No prefix before `signature`: any key that ENDS in it, matched linearly.
  textKeyRule('signature', 'signature', '(?!null\\b)'),
]

/** The pattern rules, in application order. */
const PATTERN_RULES: Array<{ cls: RedactionClass; re: RegExp }> = [
  // `Bearer <token>` anywhere, the scheme word included.
  { cls: 'auth-header', re: /\bBearer\s{1,8}[A-Za-z0-9._~+/=-]+/gi },
  { cls: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]*/g },
  { cls: 'agent-key', re: /sk_agent_[A-Za-z0-9_-]*/g },
  // A base64(url) blob of JSON (x402 headers, JWTs), with any `.`-joined
  // segments that follow it.
  { cls: 'b64-json', re: /eyJ[A-Za-z0-9+/_=-]{20,}(?:\.[A-Za-z0-9+/_=-]+){0,2}/g },
  // A 65-byte signature (`0x` + 130 hex) or anything longer.
  { cls: 'signature', re: /0x[0-9a-fA-F]{130,}/g },
]

/** A merchant body echoed in a refusal message (`paid-mcp-completion.ts`, MERCHANT_REJECTED_AFTER_FUNDING). */
const MERCHANT_RESPONSE_LABEL = /Merchant response:\s{0,8}/i
/** A `result` key at up to 8 escape levels (group 1: the backslashes). */
const RESULT_KEY = /(\\{0,8})"result\1"\s{0,8}:\s{0,8}/g

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
  /** `tool_use.id` → tool name, from the assistant lines seen so far in this file. */
  private readonly toolNames = new Map<string, string>()

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
  strings(text: string, resultLine = false): string {
    let out = text
    for (const needle of this.opts.secrets.needles) out = this.replace(out, needle.cls, needle.re)
    out = this.replace(out, 'auth-header', PATTERN_RULES[0].re)
    out = this.merchantBodyText(out, resultLine)
    for (const rule of TEXT_KEY_RULES) out = this.replace(out, rule.cls, rule.re, true)
    for (const rule of PATTERN_RULES.slice(1)) out = this.replace(out, rule.cls, rule.re)
    return out
  }

  /**
   * Text that cannot be walked: from the first merchant-body carrier to the
   * end of the text becomes one marker, so a cut-off line loses its tail
   * rather than leak a paid body. The carriers are a `result` key (except the
   * stream's own top-level `result` on a `{"type":"result"}` line), a
   * `merchant_body` key, and a refusal's `Merchant response:` echo.
   */
  private merchantBodyText(text: string, resultLine: boolean): string {
    if (!this.on('merchant-body')) return text
    const cuts: Array<{ at: number; tail: string }> = []
    for (const m of text.matchAll(RESULT_KEY)) {
      if (resultLine && m[1] === '') continue
      const q = m[1]
      const at = m.index + m[0].length
      if (!text.startsWith(`${q}"${marker('merchant-body')}`, at)) cuts.push({ at, tail: `${q}"${marker('merchant-body')}${q}"` })
      break
    }
    const body = /(\\{0,8})"merchant[_-]?body\1"\s{0,8}:\s{0,8}/i.exec(text)
    if (body) {
      const q = body[1]
      const at = body.index + body[0].length
      if (!text.startsWith(`${q}"${marker('merchant-body')}`, at)) cuts.push({ at, tail: `${q}"${marker('merchant-body')}${q}"` })
    }
    const label = MERCHANT_RESPONSE_LABEL.exec(text)
    if (label) {
      const at = label.index + label[0].length
      if (!text.startsWith(marker('merchant-body'), at)) cuts.push({ at, tail: marker('merchant-body') })
    }
    if (cuts.length === 0) return text
    const first = cuts.reduce((a, b) => (b.at < a.at ? b : a))
    this.counts['merchant-body'] += 1
    return `${text.slice(0, first.at)}${first.tail}`
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

  /**
   * Walk a parsed value structurally. `paid`: this value sits inside the
   * result of `haven_complete_mcp_tool` / `haven_settle_mcp_tool`, so every
   * `result` in it is the merchant's paid body (`paid-mcp-completion.ts`:
   * `data.result` on both tools, with or without `payment_id`).
   */
  value(value: unknown, paid = false): unknown {
    if (typeof value === 'string') return this.stringValue(value, paid)
    if (Array.isArray(value)) return value.map((v) => this.value(v, paid))
    if (value === null || typeof value !== 'object') return value
    const obj = value as Record<string, unknown>
    // Outside the tool keying: a `result` beside `payment_id` or
    // `settlement_tx_hash` is a paid-completion envelope all the same.
    const paidEnvelope = Object.hasOwn(obj, 'result') && (paid || Object.hasOwn(obj, 'payment_id') || Object.hasOwn(obj, 'settlement_tx_hash'))
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
      out[safeKey] = this.value(member, paid)
    }
    return out
  }

  /** A string leaf: nested JSON is parsed and walked; anything else takes the string rules. */
  private stringValue(text: string, paid: boolean): string {
    const nested = parseMaybeJson(text)
    if (nested !== undefined && typeof nested === 'object' && nested !== null) {
      const indent = text.match(/\n( +)\S/)?.[1].length ?? 0
      return JSON.stringify(this.value(nested, paid), null, indent || undefined)
    }
    return this.strings(text)
  }

  /** Remember which tool each `tool_use` id names; true when this line answers a paid tool. */
  private trackTools(line: unknown): boolean {
    const content = (line as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) return false
    let paid = false
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') this.toolNames.set(block.id, block.name)
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && PAID_TOOL.test(this.toolNames.get(block.tool_use_id) ?? '')) paid = true
    }
    return paid
  }

  line(line: string): string {
    if (line.trim() === '') return line
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Not JSON (a stream cut off by SIGKILL): string rules, never raw.
      return this.strings(decodeUnicodeEscapes(line), /^\{"type":"result"/.test(line))
    }
    const paid = this.trackTools(parsed)
    return JSON.stringify(this.value(parsed, paid))
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
// NOT the redaction rules run again. Each class has its own detector, and the
// exact-value classes are built here from the raw secret values with
// different code from the redactor's needles, so a needle built wrong (a lost
// `i` flag, a missed escape form) is still caught. The pattern detectors
// mirror the acceptance grep on #4137.

const D_Q = `\\\\{0,8}["']?`
const detectKey = (cls: RedactionClass, key: string, extra = '') => ({
  cls,
  re: new RegExp(`${key}${D_Q}\\s{0,8}[:=]\\s{0,8}${D_Q}(?!\\[REDACTED:)${extra}[A-Za-z0-9{[]`, 'gi'),
})
const DETECT_TEXT: Array<{ cls: RedactionClass; re: RegExp }> = [
  { cls: 'agent-key', re: /sk_agent_/g },
  { cls: 'anthropic-key', re: /sk-ant-/g },
  { cls: 'auth-header', re: /\bBearer\s{1,8}[A-Za-z0-9]/gi },
  detectKey('auth-header', '\\bauthorization', '(?![A-Za-z]{1,32}\\s{1,8}\\[REDACTED:)'),
  detectKey('payment-header', '\\b(?:payment[_-]?header|payment[_-]?signature|x[_-]?payment)'),
  detectKey('siwx-header', '\\bsign[_-]?in[_-]?with[_-]?x(?:[_-]?header)?'),
  { cls: 'signature', re: /0x[0-9a-fA-F]{130}/g },
  detectKey('signature', 'signature', '(?!null\\b)'),
  { cls: 'b64-json', re: /eyJ[A-Za-z0-9_-]{20,}/g },
  { cls: 'merchant-body', re: /merchant[_-]?body\\{0,8}"\s{0,8}:(?!\s{0,8}\\{0,8}"\[REDACTED:)(?!\s{0,8}null\b)/gi },
  { cls: 'merchant-body', re: /Merchant response:(?!\s{0,8}\[REDACTED:merchant-body\])\s{0,8}\S/gi },
]

/** The scanner's own exact-value probe, built from the raw values. */
interface Probe {
  cls: 'secret-exact' | 'rpc-key'
  /** Lowercased strings, any of which is a hit. */
  forms: string[]
  /** Values to look for inside DECODED base64 runs (lowercased). */
  decoded: string[]
}

/** The scanner's URL splitter: every 12+ token between URL delimiters that is not a host or a slug. */
function scannerUrlTokens(url: string): string[] {
  return url
    .split(/[/?&=#@:]+/)
    .filter((t) => t.length >= 12 && !t.includes('.'))
    .filter((t) => !['base-sepolia', 'base_sepolia', 'base-mainnet', 'base_mainnet', 'polygon-amoy', 'optimism-sepolia', 'arbitrum-sepolia', 'ethereum-sepolia', 'eth-sepolia-testnet'].includes(t.toLowerCase()))
}

function escapeLevels(s: string): string[] {
  const out = [s]
  let cur = s
  for (let i = 0; i < 2; i++) {
    cur = JSON.stringify(cur).slice(1, -1)
    out.push(cur)
  }
  return out
}

function buildProbes(raw: RawSecret[]): Probe[] {
  const probes: Probe[] = []
  for (const s of raw) {
    const v = s.value
    if (/^(0x)?[0-9a-f]{64}$/i.test(v)) {
      const body = v.toLowerCase().replace(/^0x/, '')
      probes.push({ cls: 'secret-exact', forms: [body], decoded: [body] })
      continue
    }
    if (/^https?:\/\//i.test(v)) {
      const tokens = scannerUrlTokens(v)
      if (tokens.length > 0) {
        probes.push({ cls: 'rpc-key', forms: tokens.flatMap(escapeLevels).map((t) => t.toLowerCase()), decoded: tokens.map((t) => t.toLowerCase()) })
      } else if (s.required) {
        probes.push({ cls: 'secret-exact', forms: escapeLevels(v).map((t) => t.toLowerCase()), decoded: [v.toLowerCase()] })
      }
      continue
    }
    const stripped = v.replace(/^sk_agent_|^sk-ant-/, '')
    const values = stripped !== v && stripped.length >= 12 ? [v, stripped] : [v]
    probes.push({ cls: 'secret-exact', forms: values.flatMap(escapeLevels).map((t) => t.toLowerCase()), decoded: values.map((t) => t.toLowerCase()) })
  }
  return probes
}

/** Every base64(url)-looking run of 16+ characters, decoded at each of the four character offsets. */
function decodedRuns(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{16,}/g)) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/')
    for (let s = 0; s < 4; s++) {
      // Node decodes a trailing partial group, so an unpadded tail keeps its bytes.
      const part = run.slice(s)
      if (part.length >= 16) out.push(Buffer.from(part, 'base64').toString('latin1').toLowerCase())
    }
  }
  return out
}

/**
 * The scanner's merchant-body predicate, deliberately broader than the
 * redactor's: ANY `result` below a line's top level (only the stream's own
 * `{"type":"result","result":…}` field is the agent's text). Haven tools
 * emit `result` only on the two paid tools, so an unstripped one anywhere is
 * a hit, whatever the tool keying or the sibling fields said.
 */
class Scanner {
  readonly counts = zeroCounts()
  private readonly probes: Probe[]

  constructor(secrets: LoadedSecrets) {
    this.probes = buildProbes(secrets.raw)
  }

  private hit(cls: RedactionClass, n = 1) {
    this.counts[cls] += n
  }

  text(text: string, resultLine = false) {
    const lower = text.toLowerCase()
    const runs = decodedRuns(text)
    for (const probe of this.probes) {
      let n = 0
      for (const form of probe.forms) if (form && lower.includes(form)) n += 1
      for (const want of probe.decoded) if (want.length >= 12 && runs.some((r) => r.includes(want))) n += 1
      if (n) this.hit(probe.cls, n)
    }
    for (const rule of DETECT_TEXT) {
      const n = text.match(rule.re)?.length ?? 0
      if (n) this.hit(rule.cls, n)
    }
    for (const m of text.matchAll(/(\\{0,8})"result\1"\s{0,8}:/g)) {
      if (resultLine && m[1] === '') continue
      let at = m.index + m[0].length
      for (let i = 0; i < 8 && /\s/.test(text[at] ?? ''); i++) at++
      if (!text.startsWith(`${m[1]}"${marker('merchant-body')}`, at)) this.hit('merchant-body')
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

  value(value: unknown, top = false) {
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
    const agentResult = top && obj.type === 'result'
    for (const [key, member] of Object.entries(obj)) {
      this.text(key)
      if (member === null || member === undefined) continue
      if (key === 'result' && !agentResult) {
        const n = this.bodyLeaks(member)
        if (n) this.hit('merchant-body', n)
      }
      const k = key.toLowerCase().split(/[-_]/).join('')
      if (!isMarker(member)) {
        if (k === 'merchantbody') this.hit('merchant-body')
        if (typeof member === 'string') {
          if (k === 'paymentheader' || k === 'paymentsignature' || k === 'xpayment') this.hit('payment-header')
          else if (k === 'signinwithx' || k === 'signinwithxheader') this.hit('siwx-header')
          else if (k === 'authorization' || k === 'proxyauthorization') this.hit('auth-header')
          else if (k.endsWith('signature')) this.hit('signature')
        }
      }
      this.value(member)
    }
  }

  line(line: string) {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      const resultLine = /^\{"type":"result"/.test(line)
      this.text(line, resultLine)
      const decoded = decodeUnicodeEscapes(line)
      if (decoded !== line) this.text(decoded, resultLine)
      return
    }
    this.value(parsed, true)
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
