#!/usr/bin/env node
// The MCP↔CLI vocabulary guard (#3131, epic #3130).
//
// A settled x402 payment is reported by two surfaces that agree on almost
// nothing. This guard does not fix that — #3132/#3133/#3134 do. It freezes the
// problem at today's size, so that the later breaking slices are provable
// rather than hopeful, and so a NEW field cannot join either surface without
// someone deciding what its counterpart is.
//
// Precedent: #2907 pinned a census and an exact pattern before #2914
// contracted anything, and the census caught a reintroduced wire field
// (`safe_address` back in TRANSACTION_CSV_COLUMNS) that prose review passed.
//
// THE RULE. Every field on either ROW surface must be accounted for in
// `vocabulary-map.json`, as exactly one of:
//   - one side of a `concepts[]` entry (a pair, with a disposition and reason);
//   - an entry in `singleSurface[<surface>]` (no counterpart, with the reason).
// Anything else is an undeclared divergence and fails the run.
//
// #3133 added a THIRD surface on a different axis. The two above pair a receipt
// FIELD with a transaction field; the CLI's is the casing CONVENTION each
// command emits, declared under `cliConventions` and censused by
// `scanCliEnvelopes`. Same rule, different unit: every function that builds its
// own output object must have an entry saying which convention it chose.
//
// It fails the other way too: a map entry naming a field that no longer exists
// on its surface is stale, and a stale map is how a converged pair keeps
// looking like an open one.
//
// WHY A LINE SCANNER. Neither input is worth a TypeScript compiler here:
// `mapPaymentReceipt` is a flat `camelKey: raw.snake_key` list and
// `transactionBaseProperties` is a flat object literal. `scripts/lint-wire-types.mjs`
// set the precedent for reading TS source this way — and its own header
// documents four holes review closed in it, so this scanner inherits that
// fragility and says so:
//   - it reads ONE named block per file and stops at the first line that closes
//     it at column 0, so a stray CODE brace at column 0 inside the block would
//     truncate the scan. A brace inside a comment or a string no longer can:
//     both surface scanners read a stripped copy, which blanks it first. This
//     entry claimed the comment case for eleven rounds after it stopped being
//     true of the CLI path and until the stripping reached these two. The `assertPlausible` floor below is the backstop: a
//     truncated scan reports too few fields and the run fails rather than
//     passing on a short list.
//   - it cannot see a field spread in from elsewhere (`...someProps`), nor a
//     key nested inside another object literal. Neither surface does either
//     today; `assertPlausible` would not catch it if one started, because
//     neither removes anything. Review is the backstop.
//   - the transaction scan matches a bare identifier key, so a quoted or
//     hyphenated one (`'x-foo': {…}`) is invisible. An OpenAPI properties block
//     has no reason to carry one, but nothing here enforces that.
//   - the receipt scan matches ANY key at four spaces inside the function, so a
//     sibling object literal declared there would contribute phantom fields.
//     That one fails CLOSED — a phantom is undeclared, so the run goes red and
//     someone looks — which is why it is a noise risk rather than a blind spot.
//     Both surface scanners now read a STRIPPED copy. Before that they did not,
//     and the polarity was the other way round: a field commented out rather
//     than deleted still read as live, so the `stale` direction went silent —
//     a genuine blind spot, in the direction #3134's convergence work depends
//     on, and the file's own rationale for stripping applied to them all along.
//   - `scanCliEnvelopes` walks braces over a stripped copy, so it is not
//     line-bound and not fooled by a comment, a string or a regex literal. It
//     follows an identifier ONE hop — a `const` bound in the same function —
//     which is what every emit in this file needs. A second hop (a const
//     assigned from another const, or a literal built in a helper and returned)
//     is not followed. Nothing in the tree does that today.
//   - it resolves an emit's OWNER by the nearest preceding declaration, so an
//     envelope emitted from a callback defined before its command is attributed
//     to the enclosing function rather than the callback.
//   - a NESTED literal contributes only its container key. It still names the
//     owner, so the ratchet fires; it is the recorded key list that is partial.
//   - `const f = async function (…) {` is not an owner form, and neither is a
//     class method written with a modifier this scanner does not read, nor one
//     whose parameter list contains a `)` inside a type annotation
//     (`helper(cb: () => void) {`) — the most ordinary of the three, and so the
//     one most likely to arrive first. An envelope in any of them merges into
//     the previous function's entry SILENTLY: the audit compares function names
//     and key sets, but has no way to know a key set landed on the wrong owner.
//     This is the hole worth closing first if the file's style ever changes.
//   - a computed key (`{ [k]: 1 }`) is skipped — there is no literal name to
//     record.
//   - `scanCsvHeaders` reads ONE literal: the FIRST `const headers = [ … ]` in
//     commands.ts. That is an anchor, not just a limit — a non-CSV `const
//     headers` introduced ABOVE it silently retargets the whole scan.
//     A plain template-literal header (`` `chain_id` ``) reads correctly, since
//     the backtick is in the character class; an INTERPOLATED one
//     (`` `${pre}_id` ``) is captured verbatim and reddens.
//     Two shapes are silent false negatives, where map and code agree and the
//     shipped CSV does not: a column APPENDED after the literal
//     (`headers.push('fee')` — a `let headers` reassignment is NOT this case,
//     it fails loudly as `unscannable` because the search wants `const`), and a
//     CONDITIONAL
//     column — `...(flag ? ['fee'] : [])` reads as unconditional, and
//     `flag ? 'a' : 'b'` contributes both branches. The walk descends into
//     nested arrays and the match ignores element structure, so neither is
//     visible as a shape.
//   - it reads only `commands.ts`. `output.ts` builds two shapes of its own —
//     the export wrapper and the failure envelope — which are outside the
//     census by construction and recorded in the map's prose instead.
//   - `transactionBaseProperties` is spread into TWO closed schemas to keep
//     `expectMatchesSpec` truthful. This scanner reads the base object, which
//     is the shared shape both schemas carry — deliberately, since that is the
//     surface the two vocabularies actually diverge on.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  hasShrunk,
  loadBaseline,
  newViolations,
  runGate,
  updateRefusals,
  writeBaseline,
} from '../lib/ratchet.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAP_PATH = resolve(REPO_ROOT, 'scripts/ci/vocabulary-map.json')
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts/ci/vocabulary-divergence-baseline.json')

/**
 * The lowest field count each surface can plausibly have. A scan that reads
 * fewer has been truncated by a brace it should not have stopped at — the
 * exact failure `lint-wire-types.mjs`'s header records as a closed hole. The
 * floor turns that into a red run instead of a short, quietly-passing list.
 *
 * Deliberately well below today's counts (30 and 29): this catches truncation,
 * it is not a second ratchet, and a floor that tracks the real number would
 * fail every legitimate removal.
 */
const PLAUSIBLE_FLOOR = { receipt: 20, transaction: 20 }

/**
 * The CLI census has the same exposure and needs the same backstop: a scanner
 * that silently finds NOTHING reports every declared entry as stale, which
 * reads as "the map is wrong" rather than "the scanner broke". The `stale`
 * direction would catch a total failure; a partial one — a changed emit helper
 * name, say — would not, so the floor is what turns it into a red run.
 */
const CLI_EMITTER_FLOOR = 10

/** Read a named block's body: from `<needle>` to the first line closing it at column 0. */
export function readBlock(source, needle) {
  const start = source.indexOf(needle)
  if (start === -1) return null
  const rest = source.slice(start)
  const end = rest.search(/\n\}/)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Fields `mapPaymentReceipt` puts on a receipt.
 *
 * Three emit shapes, all of which carry the concept→column edge that
 * `sdk/src/types.ts` (camel names, no column link) does not:
 *   `camelKey: raw.snake_key,`           the flat list
 *   `camelKey: mapParties(raw.parties),` a mapped sub-shape
 *   `receipt.camelKey = raw.snake_key`   the conditional tail
 */
export function scanReceiptSurface(source) {
  // Over a STRIPPED copy. A field commented out rather than deleted still read
  // as live, so the `stale` direction went silent — and `stale` is what fires
  // when #3134 converges a pair and someone forgets to remove its row. The
  // conditional-tail pattern below matches at ANY indentation, so a commented
  // `receipt.x = raw.y` was caught by it too. These two scanners were the ones
  // the stripper never reached, while this file's stated reason for stripping —
  // that documenting a shape in a comment is what the work encourages — applied
  // to them all along.
  const body = readBlock(stripCommentsAndStrings(source), 'export function mapPaymentReceipt')
  if (body === null) return {}
  const fields = {}
  // Shape-AGNOSTIC on purpose. An earlier version required the value to be
  // `raw.x` or `fn(raw.x)`, which made any other shape invisible — and the
  // sibling mapper in the same file already emits one
  // (`explorerUrl: buildExplorerUrl(...)`). A field the guard cannot see is a
  // field nobody has to declare, which is the one failure this guard exists to
  // prevent, so the key is what counts and the column is best-effort.
  for (const m of body.matchAll(/^ {4}(\w+):\s*(.*)$/gm)) {
    fields[m[1]] = /raw\.(\w+)/.exec(m[2])?.[1] ?? null
  }
  for (const m of body.matchAll(/^\s*receipt\.(\w+) = (.*)$/gm)) {
    fields[m[1]] = /raw\.(\w+)/.exec(m[2])?.[1] ?? null
  }
  return fields
}

/** Top-level keys of `transactionBaseProperties` (two-space indent, the object's own level). */
export function scanTransactionSurface(source) {
  // Stripped, for the reason on `scanReceiptSurface` above.
  const body = readBlock(stripCommentsAndStrings(source), 'const transactionBaseProperties = {')
  if (body === null) return {}
  const fields = {}
  for (const m of body.matchAll(/^ {2}(\w+):/gm)) fields[m[1]] = true
  return fields
}

/**
 * Blank out comments and string/template literals, preserving offsets so the
 * result can still be scanned positionally (#3133).
 *
 * Without this, `{ ok: true, legacy_key: 1 }` inside a JSDoc or a help string
 * reads as a real emit — and documenting an envelope's shape in a comment above
 * the command is exactly what this slice's own documentation encourages. A
 * guard that reddens on that teaches people it is noise.
 */
/** Whether the `/` at `i` opens a regex literal rather than being division. */
function startsRegex(source, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(source[j])) j -= 1
  if (j < 0) return true
  return '=(,:[!&|?{};+-*%<>~^'.includes(source[j]) || /\breturn$|\bcase$|\btypeof$/.test(source.slice(0, j + 1))
}

/**
 * `source` with every comment, string and regex literal blanked to spaces,
 * offsets preserved exactly.
 *
 * `blanked` — when given an array — collects `{ start, end, kind }` for each
 * span, where `kind` is `'string'` or `'comment'`. `objectKeys` needs the
 * distinction: it reads a QUOTED KEY back out of the original at a blanked
 * position, and a comment is blanked the same way a string is. A quoted string
 * sitting at a key position inside a comment (`// was "legacy_key": 1`) was
 * therefore read as a key — and worse, it consumed the key slot, so the
 * literal's REAL keys were dropped. Both directions wrong at once, and the
 * obvious remedy is to write the phantom into the map, which would then
 * permanently mis-describe the shape.
 *
 * That is the failure this function's own rationale warns against: documenting
 * an envelope's shape in a comment is what this slice encourages.
 */
export function stripCommentsAndStrings(source, blanked) {
  let out = ''
  let i = 0
  const blank = (n) => ' '.repeat(n)
  const record = (start, stop, kind) => {
    if (blanked) blanked.push({ start, end: stop, kind })
  }
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const nl = source.indexOf('\n', i)
      const stop = nl === -1 ? source.length : nl
      out += blank(stop - i)
      record(i, stop, 'comment')
      i = stop
    } else if (two === '/*') {
      const close = source.indexOf('*/', i + 2)
      const stop = close === -1 ? source.length : close + 2
      // Keep newlines so line-oriented reasoning downstream stays honest.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      record(i, stop, 'comment')
      i = stop
    } else if (source[i] === '/' && startsRegex(source, i)) {
      // A regex literal containing a quote (`/["']/g`) otherwise opens a fake
      // string that swallows the rest of the file — silently, because what it
      // swallows is usually code appended AFTER the last declared emitter.
      let j = i + 1
      let inClass = false
      while (j < source.length) {
        const c = source[j]
        if (c === '\\') j += 1
        else if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        else if (c === '\n') break
        j += 1
      }
      out += source.slice(i, Math.min(j + 1, source.length)).replace(/[^\n]/g, ' ')
      record(i, Math.min(j + 1, source.length), 'comment')
      i = j + 1
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i]
      let j = i + 1
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') j += 1
        j += 1
      }
      out += source.slice(i, Math.min(j + 1, source.length)).replace(/[^\n]/g, ' ')
      record(i, Math.min(j + 1, source.length), 'string')
      i = j + 1
    } else {
      out += source[i]
      i += 1
    }
  }
  return out
}

/**
 * The top-level keys of the object literal starting at `open` (`{`).
 *
 * Walks rather than pattern-matches, because a key and its VALUE look alike:
 * an earlier version read `agent_id: id` as two keys and `ok: true` as `ok`
 * plus `true`. A key is an identifier that appears where a key can appear —
 * right after `{` or a top-level `,` — and it is `key: value` when a colon
 * follows and shorthand when a comma or brace does. Both forms pick a
 * convention, so both count; a spread (`...prepared`) contributes no name of
 * its own and is skipped.
 */
function objectKeys(src, open, original = src, commentSpans = []) {
  // The readback below reads `original`, but with COMMENTS blanked out. Two
  // reasons, and they pull the same way: a quoted string inside a comment at a
  // key position was read as a key (and consumed the key slot, dropping the
  // literal's real keys), and a comment between a quoted key and its colon
  // (`{ 'a'/*x*/: 1 }`) broke the `\s*:` match so the key was silently lost.
  // Blanking once serves both, where a filter over match positions serves
  // neither cleanly.
  let readable = original
  for (const sp of commentSpans) {
    if (sp.kind !== 'comment') continue
    readable = readable.slice(0, sp.start) + ' '.repeat(sp.end - sp.start) + readable.slice(sp.end)
  }
  const keys = []
  let depth = 0
  let expectKey = false
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{' || c === '[' || c === '(') {
      depth += 1
      if (depth === 1) expectKey = true
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (c === ',') {
      expectKey = true
      continue
    }
    if (/\s/.test(c)) {
      // A QUOTED key was blanked to whitespace by the stripper, so the walk
      // would skip straight past it — and an emit whose keys ALL vanish is
      // dropped from the census entirely. Offsets are preserved exactly, so
      // read it back from the original at this position.
      // Read from the comment-blanked copy, so only a blank that came from a
      // STRING can yield a key.
      if (expectKey) {
        const q = /^['"]([^'"]+)['"]\s*:/.exec(readable.slice(i))
        if (q) {
          keys.push(q[1])
          expectKey = false
        }
      }
      continue
    }
    if (!expectKey) continue

    if (src.startsWith('...', i)) {
      expectKey = false
      continue
    }
    const m = /^([A-Za-z_$][\w$]*)\s*([:,}])/.exec(src.slice(i))
    if (m) keys.push(m[1])
    // Whether it was a key or not, the next candidate position is the next
    // top-level comma — never the value we just walked past.
    expectKey = false
  }
  return keys
}

/**
 * Every function in `commands.ts` that emits an object literal it CONSTRUCTED
 * ITSELF, mapped to the keys it puts in one (#3133).
 *
 * The predicate is "an inline object literal passed to `emit(…)` or
 * `d.o.data(…)`", not "a line containing `{ ok: true`". The first version used
 * the latter and it was wrong three ways, all of them present in this tree:
 *
 *   - it needed `{` and `ok: true` on ONE PHYSICAL LINE, so it could not see
 *     `deviceLogin`'s wrapped device-start envelope at all — and wrapping is
 *     simply what an object with a few long values gets;
 *   - it keyed on `ok: true`, so the SEVEN emitters that carry no `ok` key were
 *     outside the ratchet entirely though every one picks a convention:
 *     `cmdWalletsBalances` (`{ account, chainId, balances }`, which re-maps the
 *     backend's `chain_id`), `cmdWhoami`, the `emitGrant`/`emitRevoke`
 *     preparation pair, `cmdAgentsConnect`, and the two export `meta` literals
 *     (`cmdActivityExport`, `exportSie`). Seven, not two and not three: three
 *     earlier drafts of this file each wrote a different number, so the count is
 *     now spelled out by name rather than summarised;
 *   - it assigned rather than merged, so a function emitting TWO envelopes had
 *     its first silently dropped — which `deviceLogin` does.
 *
 * A command that forwards a backend value (`emit(d, json, accounts, …)`) passes
 * an identifier, not a literal, so it is correctly absent: there is no casing
 * choice there for a ratchet to hold.
 *
 * "Function" means the nearest enclosing DECLARATION, which is not always a
 * command: `cmdBudgetGrant` and `cmdBudgetRevoke` emit through the local arrow
 * consts `emitGrant` / `emitRevoke`, and those two names are what the census and
 * the map carry. Stable — a rename fails loudly as `stale` — but a reader
 * looking for the command will not find it.
 *
 * Keyed on the ENCLOSING FUNCTION, not a line number. #3133's own line anchors
 * were wrong three times across two correction passes, and a guard keyed on
 * them goes red on an unrelated edit above — which trains people to update the
 * anchor rather than read it. Declarations (`function f`), arrow consts
 * (`const f = … =>`, including `async <T>(…) =>` and a form whose type
 * annotation itself contains `=>`, and a nested type-parameter list such as
 * `<T extends Record<string, string>>`) and object/class methods (`f(args) {`)
 * all count. A `const f = async function (…) {` expression does NOT, and is named
 * in the hole list below — missing an owner form is the worst failure this
 * scanner has, because the undeclared envelope merges into the PREVIOUS
 * function's entry and the audit compares names, never keys, so the run stays
 * green.
 */
export function scanCliEnvelopes(source) {
  const commentSpans = []
  const src = stripCommentsAndStrings(source, commentSpans)
  const found = {}

  // `if (…) {`, `for (…) {` and friends match the method shape exactly, and an
  // envelope inside one was being attributed to a control-flow keyword.
  const NOT_A_FUNCTION = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try',
    'typeof', 'await', 'new', 'delete', 'void', 'in', 'of', 'case',
  ])

  const owners = []
  for (const m of src.matchAll(
    /(?:function\s+([A-Za-z_$][\w$]*)|^\s{0,4}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/gm,
  )) {
    const name = m[1] ?? m[2]
    if (!NOT_A_FUNCTION.has(name)) owners.push({ at: m.index, name })
  }

  // Arrow consts are detected by WALKING rather than by one regex. A single
  // pattern has to describe the type annotation, the generic parameter list and
  // the arrow at once, and every tightening of it lost a form the looser
  // version caught — `async <T>(…) =>` and an annotation that itself contains
  // `=>` both stopped being owners, and the cost of missing one is silent: the
  // new command's envelope merges into the PREVIOUS function's entry, and the
  // audit compares names, never keys, so the run stays green.
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (NOT_A_FUNCTION.has(m[1])) continue
    let i = m.index + m[0].length
    // Skip a type annotation, which may itself contain `=>` and `<…>`.
    let depth = 0
    if (src[i] === ':') {
      i += 1
      for (; i < src.length; i += 1) {
        const c = src[i]
        if ('<([{'.includes(c)) depth += 1
        else if ('>)]}'.includes(c)) depth -= 1
        else if (c === '=' && depth <= 0 && src[i + 1] !== '>' && src[i - 1] !== '=') break
        // A `;` at depth 0 ends the declaration: `let pending: string;` has no
        // initializer, so there is no arrow to find and the walk must stop.
        // The earlier test sliced FROM the `;`, so it could never be blank and
        // the walk ran on until a later statement's arrow — making a phantom
        // owner named after a local variable, positioned inside the real
        // command, which then stole that command's envelope.
        else if (c === ';' && depth <= 0) break
        // A NEWLINE at depth 0 ends the declaration too, unless the annotation
        // is plainly continued (`:`, `|`, `&`, `,`, `<`, `extends` at the line
        // end). Without this, `let pending: string` written with no `;` walked
        // past the line end into the next statement's `=`, adopted ITS arrow
        // and became a phantom owner — the same failure the `;` break above
        // fixes, reachable through ASI. The earlier blank-line-only form of
        // this test could not see it: the following line is not blank.
        else if (c === '\n' && depth <= 0) {
          const line = src.slice(src.lastIndexOf('\n', i - 1) + 1, i).trimEnd()
          if (!/(?:[:|&,<]|\bextends|\bkeyof)$/.test(line)) break
        }
      }
    }
    while (i < src.length && /[\s]/.test(src[i])) i += 1
    if (src[i] !== '=' || src[i + 1] === '>' || src[i + 1] === '=') continue
    i += 1
    // `= [async] [<T,…>] (params)|ident [: ret] =>`
    // The window only has to cover the SIGNATURE prefix, and every `eat` below
    // is anchored, so a generous bound costs nothing while a tight one silently
    // drops an owner with a long parameter list.
    const rest = src.slice(i, i + 4000)
    let j = 0
    const eat = (re) => {
      const mm = re.exec(rest.slice(j))
      if (mm) j += mm[0].length
      return Boolean(mm)
    }
    eat(/^\s+/)
    eat(/^async\s*/)
    // BALANCED, not `<[^>]*>`: a type-parameter list may nest
    // (`<T extends Record<string, string>>`), and stopping at the first `>`
    // broke the walk, so the const was not an owner and its envelope merged
    // into the previous function's entry — silently, since the audit compares
    // names and never keys. That is the failure this scanner calls its worst,
    // reintroduced by the fix for it.
    if (rest[j] === '<') {
      let angle = 0
      let k = j
      for (; k < rest.length; k += 1) {
        if (rest[k] === '<') angle += 1
        else if (rest[k] === '>') {
          angle -= 1
          if (angle === 0) break
        }
      }
      if (angle === 0 && rest[k] === '>') {
        j = k + 1
        eat(/^\s*/)
      }
    }
    if (!eat(/^\([^)]*\)\s*/) && !eat(/^[A-Za-z_$][\w$]*\s*/)) continue
    eat(/^:[^=]*?(?==>)/)
    if (!/^=>/.test(rest.slice(j))) continue
    owners.push({ at: m.index, name: m[1] })
  }
  owners.sort((a, b) => a.at - b.at)

  const ownerAt = (at) => {
    let name = null
    for (const o of owners) {
      if (o.at <= at) name = o.name
      else break
    }
    return name
  }

  // Every `const NAME = { … }`, with the function it was bound in. An envelope
  // built into a variable and handed to an emit helper a line later is still
  // the CLI's own shape — `agents connect --run` does exactly that, and an
  // inline-only predicate left that entire user-visible result undeclared.
  const bound = []
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/g)) {
    bound.push({ name: m[1], open: m.index + m[0].length - 1, owner: ownerAt(m.index) })
  }

  /** Top-level argument slices of a call whose `(` is at `lparen`. */
  const argsOf = (lparen) => {
    const out = []
    let depth = 0
    let start = lparen + 1
    for (let i = lparen; i < src.length; i += 1) {
      const c = src[i]
      if (c === '(' || c === '{' || c === '[') depth += 1
      else if (c === ')' || c === '}' || c === ']') {
        depth -= 1
        if (depth === 0) {
          out.push({ text: src.slice(start, i), at: start })
          break
        }
      } else if (c === ',' && depth === 1) {
        out.push({ text: src.slice(start, i), at: start })
        start = i + 1
      }
    }
    return out
  }

  // `emit(d, json, PAYLOAD, human)`, `d.o.data(PAYLOAD, human)` and
  // `d.o.text(content, META)` are the three sinks; an `emitSomething` helper
  // exists to be called from several commands, so its argument list is searched
  // too — a helper is where the shapes that travel furthest live.
  //
  // `d.o.text` was missed at first because the wrapper it feeds is built in
  // `output.ts` (`{ ok: true, ...meta, content }`), which the census does not
  // read — so the gap looked structural, a file outside the scanner. It is not:
  // `meta` is an object literal built in THIS file, and its keys are top-level
  // `--json` keys like any other. Today they carry no casing (`format`, `rows`),
  // which is exactly why it could sit there green.
  for (const call of src.matchAll(/\b(emit[A-Za-z_$]*|d\.o\.data|d\.o\.text)\s*\(/g)) {
    // A DECLARATION is not a call. `function emitConnectResult(d, json, merged:
    // { relay: string | null; … }, …)` matches the sink pattern, and its
    // parameter's TYPE ANNOTATION is an object literal — which read as the
    // emitted shape and invented a one-key envelope.
    //
    // REDUNDANT with the close-follow test below, and kept anyway: a `function`
    // declaration is always followed by a body or a return annotation, so
    // removing this line changes no result today. It is the cheap exact test for
    // the case that motivated the guard, and it is marked redundant here so
    // nobody reads its survival as evidence that it is doing work.
    if (/\bfunction\s*$/.test(src.slice(Math.max(0, call.index - 24), call.index))) continue
    // A class/interface/type member named `emit*(…)` is a declaration too, and
    // its parameter annotations are not payloads. Detected by what follows the
    // BALANCED close of the argument list: a declaration is followed by a body
    // (`{`) or a return annotation then a body, while a call is followed by
    // `;`, `,`, `)`, `.` or a line end.
    //
    // The first attempt tested `\([^)]*:[^)]*\)\s*:`, which stops at the first
    // `)` in the call TEXT — for `emit(d, json, { … }, (): string => 'x')` that
    // is the renderer arrow's own `()`, so the whole real call was skipped.
    // Silent, and `(): T =>` is idiomatic, so it was a trap for the next edit.
    //
    // The close below is BALANCED, and that is load-bearing, not defensive. A
    // sink-named member whose parameter list contains a `)` inside a callback
    // type (`emitOther(payload: { a_b: string }, cb: () => void): void`) closes
    // naively at that `()`, so the text tested as "what follows" is the middle
    // of the declaration — neither a body nor an annotation — and the
    // declaration is processed as a CALL. The sink is then an `emit*` helper
    // rather than bare `emit`, so EVERY argument becomes a payload candidate and
    // the parameters' type annotations are censused onto the previous real
    // command: silent key drift on the wrong owner, which this file calls its
    // worst failure. An earlier pass claimed no fixture could make a naive
    // `indexOf(')')` misfire; that was wrong, and there is a test for it.
    {
      let depth = 0
      let k = call.index + call[0].length - 1
      for (; k < src.length; k += 1) {
        if (src[k] === '(') depth += 1
        else if (src[k] === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      const after = src.slice(k + 1, k + 200)
      // A BODY follows a declaration — bare (`emitX(a: T) {`) or annotated
      // (`emitX(a: T): void {`). Both forms, which the earlier `\)\s*:` test
      // missed for the bare one while its own comment claimed to cover "a
      // return annotation or a body".
      //
      // Do NOT also treat "nothing else on this line" as a declaration: a
      // multi-line call closes its argument list at the end of a line too, so
      // that test skipped nearly every real call and the census silently went
      // to zero.
      const isBody = /^\s*(?::[^;={]*)?\{/.test(after)
      // An INTERFACE member has no body: `emitX(a: T): void` — with or without
      // a trailing `;`, since the separator inside an interface is optional.
      // A call can be followed by `;` or a line end, but never by a RETURN
      // ANNOTATION first, so requiring `:` plus a type-shaped token keeps this
      // narrow. The one shape it would misread is a ternary whose alternative
      // is a bare identifier (`cond ? emit(…) : fallback`); `emit` returns
      // void, so that is not written.
      //
      // If it ever is, the failure is NOT loud in general: the owner drops out
      // of the census, so a brand-new function shaped that way produces no
      // `undeclared` and no `keyDrift`, and the run stays GREEN. It is loud for
      // a function the map already lists — as `stale` if that was its only
      // envelope, as `keyDrift.gone` if it emits others.
      const isAmbient = /^\s*:\s*[A-Za-z_$][\w$.<>[\]| ]*\s*[;\n}]/.test(after)
      if (isBody || isAmbient) continue
    }
    const lparen = call.index + call[0].length - 1
    const sink = call[1]
    const args = argsOf(lparen)
    const candidates =
      sink === 'emit'
        ? args.slice(2, 3)
        : sink === 'd.o.data'
          ? args.slice(0, 1)
          : sink === 'd.o.text'
            ? // `text(content, META)` — the SECOND argument is the literal; the
              // first is the file body and carries no keys.
              args.slice(1, 2)
            : args

    const opens = []
    for (const arg of candidates) {
      // EVERY top-level literal in the payload argument, so a ternary
      // (`cond ? { a_b: 1 } : { cD: 2 }`) contributes both branches instead of
      // naming no owner at all — which is what a leading-literal-only test did,
      // silently, while the header claimed the ratchet still fired.
      let d2 = 0
      for (let k = 0; k < arg.text.length; k += 1) {
        const ch = arg.text[k]
        if (ch === '{' && d2 === 0) opens.push(arg.at + k)
        if ('({['.includes(ch)) d2 += 1
        else if (')}]'.includes(ch)) d2 -= 1
      }
      // Do NOT break yet: a ternary may mix a literal with an identifier
      // (`cond ? v : { … }`), and stopping here dropped the bound branch.
      const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(arg.text)
      if (id) {
        // Only a binding from the SAME function counts. Without that the deps
        // object — `const d = { sessionStore, makeApi, … }`, built once and
        // passed to every command — resolves as every call's payload.
        const b = bound.find((x) => x.name === id[1] && x.owner === ownerAt(call.index))
        if (b) opens.push(b.open)
      }
      // Only for a TERNARY argument, and only for a bare identifier branch.
      // Scanning every identifier merged in any same-function const merely
      // MENTIONED inside an envelope (`{ a_b: limits.max_n }` pulled in all of
      // `limits`), which drifts the recorded key list without moving red/green.
      if (/\?/.test(arg.text)) {
        for (const branch of arg.text.split(/[?:]/)) {
          const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(branch)
          if (!bare) continue
          const b = bound.find((x) => x.name === bare[1] && x.owner === ownerAt(call.index))
          if (b && !opens.includes(b.open)) opens.push(b.open)
        }
      }
      if (opens.length > 0) break
    }
    if (opens.length === 0) continue

    const keys = [...new Set(opens.flatMap((o) => objectKeys(src, o, source, commentSpans)))]
    if (keys.length === 0) continue

    let owner = null
    for (const o of owners) {
      if (o.at <= call.index) owner = o.name
      else break
    }
    if (!owner) continue
    // MERGE, never assign: a function may emit more than one envelope, and
    // dropping the first is how a whole shape goes undocumented.
    found[owner] = [...new Set([...(found[owner] ?? []), ...keys])]
  }
  return found
}

/** Every field the map accounts for, per surface, and how. */
export function declaredFields(map) {
  const declared = { receipt: new Map(), transaction: new Map() }
  for (const entry of map.concepts) {
    for (const surface of ['receipt', 'transaction']) {
      declared[surface].set(entry[surface].field, {
        how: 'concept',
        concept: entry.concept,
        disposition: entry.disposition,
      })
    }
  }
  for (const surface of ['receipt', 'transaction']) {
    for (const field of Object.keys(map.singleSurface[surface])) {
      declared[surface].set(field, { how: 'single-surface' })
    }
  }
  return declared
}

/**
 * The CSV export's column headers, read out of `const headers = [ … ]` in
 * commands.ts.
 *
 * A separate scan because they are not an object literal and not `--json`: they
 * are a FILE-FORMAT contract, snake_case over a camelCase JSON source. The map
 * declared them from the start and nothing compared them to the code, so the
 * page could promise enforcement over a list that was free to drift — and the
 * drift with teeth is re-introducing a retired wire name (`safe_address`),
 * which is the very case this guard's header cites as its precedent (#2907).
 *
 * Returns `null` when the array cannot be found, so a renamed binding fails as
 * a missing census rather than as an empty one that agrees with nothing.
 */
export function scanCsvHeaders(source) {
  const blanked = []
  const src = stripCommentsAndStrings(source, blanked)
  const at = src.search(/\bconst headers\s*=\s*\[/)
  if (at === -1) return null
  const open = src.indexOf('[', at)
  let depth = 0
  let close = -1
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1
    else if (src[i] === ']') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return null
  // Read the ORIGINAL over that span: the stripper blanked the very strings
  // this scan is after, and offsets are preserved exactly.
  //
  // Skipping the COMMENT spans is the whole of the care here. Without it a
  // commented-out header (`// 'safe_address', retired in #2914`) reads as a
  // shipped column, the audit goes red naming it, and the obvious remedy is to
  // add it to the map — which would then permanently assert that the CSV export
  // ships a retired wire name. The #2907 case, reached from the other side. It
  // is the same defect the quoted-key readback in `objectKeys` had, at a second
  // site: any read of the original at a blanked offset needs the kind.
  // BLANK the comments first, then match — do not match and then filter. A
  // filter tests only where a match STARTS, and the regex runs over the
  // original where a comment's apostrophe is still a quote: `// don't ship
  // safe_address here` opens a match inside the comment that runs on into the
  // next real header, so `'chain_id'` and everything after it vanish and a
  // phantom column appears. `don't`, `merchant's`, `it's` is ordinary comment
  // prose; the earlier fixture missed it only because its comment happened to
  // have balanced quotes.
  let scan = source
  for (const sp of blanked) {
    if (sp.kind !== 'comment') continue
    scan = scan.slice(0, sp.start) + ' '.repeat(sp.end - sp.start) + scan.slice(sp.end)
  }
  return [...scan.slice(open, close).matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
}

/**
 * The key names inside a `keys` string, which is prose: comma-separated names,
 * `;`-separated groups when a function emits more than one envelope, and a
 * parenthetical after each group saying which envelope that group is.
 *
 * Parsed rather than merely required, because the guard compares KEY SETS and
 * not only function names. Comparing names alone let a key be added to an
 * already-declared envelope with a green run.
 *
 * Returns `null` when a group carries prose the parser cannot account for
 * (`ok, format, content — plus rows on the CSV branch only`). Silently keeping
 * the names it recognised would SHRINK the declared set, and a shrunk set is
 * loud in one direction only: a dropped key still emitted shows up as `added`,
 * but a dropped key that STOPPED being emitted produces the `gone` that never
 * fires. Refusing the string is the honest answer.
 */
export function declaredKeys(keysProse) {
  const keys = new Set()
  for (const group of String(keysProse).split(';')) {
    const withoutAside = group.replace(/\([^)]*\)/g, ' ')
    for (const token of withoutAside.split(',')) {
      const name = token.trim()
      if (name === '') continue
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
      keys.add(name)
    }
  }
  return keys
}

/**
 * Compare the two surfaces against the map.
 *
 * `undeclared` — a field on a surface with no entry: the guard's whole point.
 * `stale`      — an entry naming a field that is no longer on its surface:
 *                the other direction, and the one that matters after #3134
 *                converges a pair and someone forgets to remove its row.
 */
/**
 * The CSV headers the map declares, against the ones the code builds — ORDER
 * INCLUDED, because a column order is as much of the file-format contract as
 * the names are.
 */
export function auditCsvHeaders(headers, map) {
  const entry = map.cliConventions?.passthrough?.['activity export --format csv']
  if (!entry) return { missing: true }
  const want = declaredKeys(entry.keys)
  if (want === null) return { unparsed: true }
  if (headers === null) return { unscannable: true }
  // Parsed the way `declaredKeys` parses, not by a raw `split(',')`: the map's
  // own grammar permits a parenthetical aside and `;` groups, so a raw split
  // turned `date, chain_id (the numeric id)` into a column literally named
  // "chain_id (the numeric id)" and reddened the run for a legal `keys` string.
  // `declaredKeys` returns a Set, which loses order, so the order comes from
  // re-walking the groups here.
  const declaredOrder = entry.keys
    .split(';')
    .flatMap((group) => group.replace(/\([^)]*\)/g, ' ').split(','))
    .map((k) => k.trim())
    .filter((k) => k !== '')
  const same =
    declaredOrder.length === headers.length && declaredOrder.every((k, i) => k === headers[i])
  return same ? {} : { declared: declaredOrder, actual: headers }
}

export function auditCliEnvelopes(emitters, map) {
  const entries = Object.entries(map.cliConventions?.envelopes ?? {}).filter(
    ([k]) => !k.startsWith('$'),
  )
  const declared = new Set(entries.map(([k]) => k))
  const undeclared = Object.keys(emitters).filter((fn) => !declared.has(fn))
  const stale = [...declared].filter((fn) => !(fn in emitters))
  // Per-function key drift, the third direction. Without it a key added to an
  // envelope that is ALREADY declared passed green, and the entry's `keys` —
  // required by `validateMap` "so the reason can be checked" — was never
  // compared to anything, so the `reason` went on describing a shape that no
  // longer ships.
  const keyDrift = []
  for (const [fn, entry] of entries) {
    if (!(fn in emitters)) continue
    const want = declaredKeys(entry.keys)
    if (want === null) {
      keyDrift.push({ fn, added: [], gone: [], unparsed: true })
      continue
    }
    const have = new Set(emitters[fn])
    const added = [...have].filter((k) => !want.has(k))
    const gone = [...want].filter((k) => !have.has(k))
    if (added.length > 0 || gone.length > 0) keyDrift.push({ fn, added, gone })
  }
  return { undeclared, stale, keyDrift }
}

export function audit({ receipt, transaction, map }) {
  const declared = declaredFields(map)
  const undeclared = []
  const stale = []
  const live = { receipt, transaction }

  for (const surface of ['receipt', 'transaction']) {
    for (const field of Object.keys(live[surface])) {
      if (!declared[surface].has(field)) undeclared.push({ surface, field })
    }
    for (const [field, meta] of declared[surface]) {
      if (!(field in live[surface])) stale.push({ surface, field, ...meta })
    }
  }
  return { undeclared, stale }
}

/**
 * The CLOSED set of dispositions: for each, whether it still owes work and why.
 *
 * Closed, not an allowlist of open states. With an open-state allowlist any
 * OTHER string counted as resolved, so a typo (`blocked_on_fallback`) or a
 * novel word silently discharged the debt — "a decision was recorded" degrades
 * to "a word was typed", which is the failure this guard argues against.
 *
 * `open` lives HERE rather than in a second `Set`, because two structures is
 * how the same hole reopens one level up: add a word to one and not the other
 * and the gauge drops without anyone deciding anything. `OPEN_DISPOSITIONS` is
 * derived, and the test asserts every disposition is classified.
 *
 * `converge-pending` is deliberately not spelled `converged`. They are one
 * letter apart and opposite: `converged` means the two surfaces already share
 * a name, `converge-pending` means the rename has not been made yet. Counting the
 * second as done printed "2 still open" while four pairs differed.
 */
export const DISPOSITIONS = {
  'converged': { open: false, why: 'already one name on both surfaces' },
  'permanently-divergent': { open: false, why: 'different concepts; must never converge' },
  'converge-pending': { open: true, why: 'same concept, two names — the rename has not been made' },
  'blocked-on-fallback': { open: true, why: 'cannot converge until the value defect is fixed' },
  'undecided': { open: true, why: 'nobody has decided yet' },
}

export const OPEN_DISPOSITIONS = new Set(
  Object.entries(DISPOSITIONS)
    .filter(([, d]) => d.open)
    .map(([name]) => name),
)

/**
 * Structural validation of the map itself (#3131 AC3/AC4).
 *
 * Without this the guard read only `disposition` and `field`: an entry with no
 * `reason`, or with no `recorded`/`defaulted` flag, passed silently. Both are
 * acceptance criteria, and a criterion nothing checks is satisfied only by the
 * author having been careful once.
 */
export function validateMap(map) {
  const problems = []
  const seen = { receipt: new Set(), transaction: new Set() }

  for (const entry of map.concepts) {
    const where = `concept "${entry.concept}"`
    if (!(entry.disposition in DISPOSITIONS)) {
      problems.push(
        `${where}: unknown disposition "${entry.disposition}" — one of: ` +
          Object.keys(DISPOSITIONS).join(', '),
      )
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      problems.push(`${where}: needs a written reason of at least 20 characters`)
    }
    // `blocked-on-fallback` means "cannot converge until the value defect is
    // fixed" — a claim that is unanchored without the issue that owns the fix.
    if (entry.disposition === 'blocked-on-fallback' && !Number.isInteger(entry.blockedBy)) {
      problems.push(`${where}: blocked-on-fallback needs a numeric blockedBy issue`)
    }
    for (const surface of ['receipt', 'transaction']) {
      const side = entry[surface]
      if (!side || typeof side.field !== 'string') {
        problems.push(`${where}: missing ${surface}.field`)
        continue
      }
      if (side.value !== 'recorded' && side.value !== 'defaulted') {
        problems.push(
          `${where}: ${surface}.value must be "recorded" or "defaulted" (AC4), got ${JSON.stringify(side.value)}`,
        )
      }
      if (typeof side.column !== 'string' || side.column.trim() === '') {
        problems.push(`${where}: missing ${surface}.column`)
      }
      if (seen[surface].has(side.field)) {
        problems.push(`${where}: ${surface}.field "${side.field}" is declared more than once`)
      }
      seen[surface].add(side.field)
    }
  }

  // #3133: the CLI section is a different axis, so it gets its own shape rules —
  // same principle as above, that a decision must be written down to count.
  const CONVENTIONS = new Set(['snake', 'camel', 'mixed', 'snake-csv', 'none'])
  // Report a missing section rather than throwing: `validateMap` runs first in
  // `main`, so a TypeError here replaces the "map is malformed" path with a
  // stack trace — the one output guaranteed not to say what to do about it.
  for (const section of ['passthrough', 'envelopes', 'onDisk']) {
    const entries = map.cliConventions?.[section]
    if (entries === undefined || entries === null || typeof entries !== 'object') {
      problems.push(`cliConventions.${section}: missing or not an object`)
      continue
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (name.startsWith('$')) continue
      const where = `cliConventions.${section}.${name}`
      if (!CONVENTIONS.has(entry.convention)) {
        problems.push(
          `${where}: unknown convention "${entry.convention}" — one of: ` +
            [...CONVENTIONS].join(', '),
        )
      }
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
        problems.push(`${where}: needs a written reason of at least 20 characters`)
      }
      if (typeof entry.keys !== 'string' || entry.keys.trim() === '') {
        problems.push(`${where}: needs the keys it emits, so the reason can be checked`)
      }
    }
  }

  for (const surface of ['receipt', 'transaction']) {
    for (const [field, reason] of Object.entries(map.singleSurface[surface])) {
      if (typeof reason !== 'string' || reason.trim().length < 20) {
        problems.push(`singleSurface.${surface}.${field}: needs a written reason`)
      }
      if (seen[surface].has(field)) {
        problems.push(`singleSurface.${surface}.${field}: also declared as part of a concept pair`)
      }
      seen[surface].add(field)
    }
  }

  return problems
}

/**
 * The shrink-only number: pairs whose divergence is recorded but NOT yet
 * resolved. "Different on purpose" (`permanently-divergent`) and "already one
 * name" (`converged`) are decisions and do not count; `blocked-on-fallback`
 * and anything explicitly `undecided` do, so #3132/#3134 burn them down and
 * nobody can add a new one.
 *
 * Counted globally rather than per-file: both surfaces contribute to one
 * concept list, so a per-file split would just be this number written twice.
 */
export function openCounts(map) {
  const open = map.concepts.filter((c) => OPEN_DISPOSITIONS.has(c.disposition))
  return open.length === 0 ? {} : { 'scripts/ci/vocabulary-map.json': { open: open.length } }
}

const REMEDY =
  'Add the field to scripts/ci/vocabulary-map.json — either as one side of a\n' +
  'concepts[] pair with a disposition and a written reason, or under\n' +
  'singleSurface.<surface> with the reason it will never have a counterpart\n' +
  '(or, for a deprecated twin in a dual-emit window, its removal condition).\n' +
  '"Different on purpose" is a legitimate entry; "nobody decided" is not.'

function readSurfaces() {
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'))
  const cliSource = readFileSync(resolve(REPO_ROOT, map.surfaces.cli.file), 'utf8')
  const cli = scanCliEnvelopes(cliSource)
  const csvHeaders = scanCsvHeaders(cliSource)
  const receipt = scanReceiptSurface(
    readFileSync(resolve(REPO_ROOT, map.surfaces.receipt.file), 'utf8'),
  )
  const transaction = scanTransactionSurface(
    readFileSync(resolve(REPO_ROOT, map.surfaces.transaction.file), 'utf8'),
  )
  return { map, receipt, transaction, cli, csvHeaders }
}

/**
 * The plausibility problems in a scan, as messages — empty when all three
 * surfaces cleared their floor.
 *
 * Separated from the exit so the floors can be TESTED. They lived inline behind
 * `process.exit`, where disabling either left the whole suite green: the one
 * backstop against a silently truncated scan was itself unproven.
 */
export function plausibilityProblems(receipt, transaction, cli) {
  const problems = []
  const emitters = Object.keys(cli).length
  if (emitters < CLI_EMITTER_FLOOR) {
    problems.push(
      `the CLI scan found only ${emitters} emitter(s), below the plausibility ` +
        `floor of ${CLI_EMITTER_FLOOR}.\n` +
        '  The scanner resolves emits by walking `emit(…)` / `d.o.data(…)` /\n' +
        '  `d.o.text(…)` calls in commands.ts. This usually means the emit helper was\n' +
        '  renamed or the file moved. Fix the scanner, not the floor.',
    )
  }
  const sizes = { receipt: Object.keys(receipt).length, transaction: Object.keys(transaction).length }
  for (const [surface, floor] of Object.entries(PLAUSIBLE_FLOOR)) {
    if (sizes[surface] < floor) {
      problems.push(
        `the ${surface} scan found only ${sizes[surface]} field(s), below the ` +
          `plausibility floor of ${floor}.\n` +
          '  The scanner reads one named block and stops at the first line closing it at\n' +
          '  column 0, so this usually means the block moved, was renamed, or a CODE\n' +
          '  brace at column 0 inside it ended the read early — a brace in a comment or\n' +
          '  a string cannot, the source is stripped first. Fix the scanner, not the floor.',
      )
    }
  }
  return problems
}

/** Fail loudly on a truncated scan rather than passing on a short list. */
function assertPlausible(receipt, transaction, cli) {
  const problems = plausibilityProblems(receipt, transaction, cli)
  if (problems.length > 0) {
    for (const p of problems) console.error(`\n✗ ${p}`)
    process.exit(1)
  }
  return {
    receipt: Object.keys(receipt).length,
    transaction: Object.keys(transaction).length,
  }
}

async function main() {
  const { map, receipt, transaction, cli, csvHeaders } = readSurfaces()
  const malformed = validateMap(map)
  if (malformed.length > 0) {
    console.error('\n✗ the vocabulary map is malformed:\n')
    for (const m of malformed) console.error(`  ${m}`)
    process.exit(1)
  }
  const sizes = assertPlausible(receipt, transaction, cli)
  const { undeclared, stale } = audit({ receipt, transaction, map })
  const cliAudit = auditCliEnvelopes(cli, map)
  const csvAudit = auditCsvHeaders(csvHeaders, map)
  const counts = openCounts(map)
  const openTotal = Object.values(counts)[0]?.open ?? 0

  console.log(
    `vocabulary gauge: ${sizes.receipt} receipt field(s), ${sizes.transaction} transaction ` +
      `field(s), ${map.concepts.length} declared concept(s), ${openTotal} still open; ` +
      `${Object.keys(cli).length} CLI envelope emitter(s) found.`,
  )

  if (process.argv.includes('--update')) {
    const { baseline, firstRun } = loadBaseline(BASELINE_PATH)
    const acceptNew = process.argv.includes(ACCEPT_NEW_BASELINE_FLAG)
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  let failed = false

  if (undeclared.length > 0) {
    failed = true
    console.error('\n✗ field(s) on a surface with no entry in the vocabulary map:\n')
    for (const u of undeclared) console.error(`  [${u.surface}] ${u.field}`)
    console.error(`\n${REMEDY}`)
  }

  if (stale.length > 0) {
    failed = true
    console.error('\n✗ vocabulary-map entries naming a field that is no longer on its surface:\n')
    for (const s of stale) {
      const which = s.how === 'concept' ? `concept "${s.concept}"` : `singleSurface.${s.surface}`
      console.error(`  [${s.surface}] ${s.field} — declared by ${which}`)
    }
    console.error(
      '\nThe field moved, was renamed, or the pair converged. Update the map so it\n' +
        'describes what ships: a converged pair leaves the list and cannot come back\n' +
        'silently, which is the whole point of the ratchet.',
    )
  }

  if (
    cliAudit.undeclared.length > 0 ||
    cliAudit.stale.length > 0 ||
    cliAudit.keyDrift.length > 0
  ) {
    failed = true
    if (cliAudit.undeclared.length > 0) {
      console.error('\n✗ CLI function(s) emitting a self-built object literal with no entry:\n')
      for (const fn of cliAudit.undeclared) console.error(`  ${fn}`)
      console.error(
        '\nDeclare it under cliConventions.envelopes in scripts/ci/vocabulary-map.json,\n' +
          'with the keys it emits and the reason for the convention it picked. The CLI\n' +
          'casing split is deliberate (#3133, owner decision) — a NEW envelope still has\n' +
          'to choose on purpose rather than by copying its neighbour.',
      )
    }
    if (cliAudit.stale.length > 0) {
      console.error('\n✗ cliConventions.envelopes entries whose function no longer emits one:\n')
      for (const fn of cliAudit.stale) console.error(`  ${fn}`)
      console.error('\nThe function was renamed or its envelope removed. Update the map to match.')
    }
    if (cliAudit.keyDrift.length > 0) {
      console.error('\n✗ cliConventions.envelopes entries whose keys no longer match the code:\n')
      for (const d of cliAudit.keyDrift) {
        if (d.unparsed) {
          console.error(`  ${d.fn} — its \`keys\` string carries prose the parser cannot read`)
          continue
        }
        const bits = []
        if (d.added.length > 0) bits.push(`emitted but not declared: ${d.added.join(', ')}`)
        if (d.gone.length > 0) bits.push(`declared but no longer emitted: ${d.gone.join(', ')}`)
        console.error(`  ${d.fn} — ${bits.join('; ')}`)
      }
      console.error(
        '\nA key added to an ALREADY-declared envelope is a convention choice too, and\n' +
          "the entry's `reason` is now describing a shape that no longer ships. Write\n" +
          '`keys` as bare names, comma-separated, `;` between envelopes, with any aside\n' +
          'in parentheses — a group the parser cannot read is refused rather than\n' +
          'silently shrunk.',
      )
    }
  }

  if (Object.keys(csvAudit).length > 0) {
    failed = true
    console.error('\n✗ the CSV export headers no longer match the map:\n')
    if (csvAudit.missing) console.error('  the `activity export --format csv` entry is gone')
    else if (csvAudit.unparsed) console.error('  its `keys` string carries prose the parser cannot read')
    else if (csvAudit.unscannable)
      console.error('  `const headers = [ … ]` was not found in commands.ts — the scan, not the map')
    else {
      console.error(`  declared: ${csvAudit.declared.join(', ')}`)
      console.error(`  actual:   ${csvAudit.actual.join(', ')}`)
    }
    console.error(
      '\nHeaders are a file-format contract read by spreadsheets and importers, so a\n' +
        'rename or a reorder breaks consumers that the --json surface never touches.\n' +
        'Order counts. A retired wire name coming back here (`safe_address`) is the\n' +
        'case #2907 caught, and it used to ship green.',
    )
  }

  const { baseline } = loadBaseline(BASELINE_PATH)
  const grew = newViolations(counts, baseline)
  if (grew.length > 0) {
    failed = true
    console.error('\n✗ undecided divergences grew (shrink-only, #3131):\n')
    for (const v of grew) console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    console.error(
      '\nA new pair may be declared, but not left open. Resolve it, or record why it is\n' +
        'blocked and on what — an open entry is a debt someone has to burn down.',
    )
  }

  if (failed) process.exit(1)

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (open divergences are below the baseline — lock it in: node scripts/ci/vocabulary-divergence.mjs --update)',
    )
  }
  console.log('✓ every field on both surfaces is accounted for, and nothing undecided grew.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGate('vocabulary-divergence', main)
}
