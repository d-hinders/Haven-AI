/**
 * No frontend module may call a retired Safe INFLOW route (#2261, epic #1440).
 *
 * #1984 closed the inflow on the server: `POST /safe/deploy`,
 * `POST /user/safes/deploy`, `POST /user/safes` (import) and `PUT /user/safe`
 * all answer HTTP 410, and #1988 deleted the implementations behind them. The
 * client kept calling two of them anyway, from `app/onboarding/PasskeyEnrollFlow.tsx`
 * — a component `OnboardingClient` had stopped mounting, whose 472-line suite
 * asserted the 410 call sequence as CORRECT BEHAVIOUR. A green suite proving a
 * retired rail works is worse than no suite: it is a live claim that the code
 * is fine. #2261 deleted both.
 *
 * This guard is what stops the third instance. The deletion alone leaves no
 * signal — the next person to add a Safe-import affordance gets a 410 at
 * runtime, in a browser, with nothing red locally. Reachability was the only
 * thing keeping the previous copy harmless, and reachability is not enforced
 * by anything.
 *
 * Scoped to the RETIRED verbs, not the paths. `/user/safes` stays very much
 * alive for GET (list), PUT (rename, set default) and DELETE (unlink) — those
 * operate on EXISTING accounts, which must keep working (see
 * `hooks/useUserSafes.ts`). Only creation and import are gone.
 *
 * **Known limits — a partial net, documented here rather than implied to be a
 * closed guarantee** (haven-reviewer, #2261; the same treatment `CLAUDE.md`
 * gives the chain-default guard). All four were measured, not guessed:
 *
 * 1. Only a literal first argument is matched. `api.post(IMPORT_PATH, …)` with
 *    the path hoisted to a `const`, and `` api.post(`/user/${'safes'}`, …) ``,
 *    both pass green. Interpolation is excluded deliberately — `/user/safes/${id}`
 *    is the LIVE rename route, and matching it would make the guard cry wolf on
 *    the one thing that must keep working.
 * 2. `git ls-files` sees tracked files only, so a reintroduction that has not
 *    been `git add`ed yet is invisible locally. It is caught on the commit, i.e.
 *    before CI, which is the point at which it would matter.
 * 3. `packages/frontend/src` only. `packages/cli` is a second Haven API client
 *    with no equivalent guard (checked on this branch: it uses `GET /user/safes`
 *    and `PUT /user/safes/:id`, both live).
 * 4. `.post` / `.put` call shape only, not a bare `fetch`. What makes that
 *    adequate TODAY is that `ApiClient.request` is private (`lib/api.ts`), so
 *    these are the frontend's only POST/PUT channel to the Haven backend — the
 *    sole raw `fetch` outside `api.ts` is `lib/safe-tx.ts`, which targets Safe's
 *    own transaction service. If that ever stops being true, widen this guard.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/** This file names every retired path in prose; it must not check itself. */
const SELF = 'src/__tests__/safe-inflow-frontend-residue.test.ts'

/** Retired since #1984. Exact paths — a `${...}` sub-path is a different route. */
const RETIRED_POST = new Set(['/safe/deploy', '/user/safes', '/user/safes/deploy'])
const RETIRED_PUT = new Set(['/user/safe'])

/**
 * The `api` client helper that wrapped `POST /safe/deploy` until #2261. Named
 * separately from the path because a re-added wrapper would reintroduce the
 * call site by symbol, and the path literal would live in one file only.
 */
const RETIRED_HELPER = 'deployPasskeySafe'

function sourceFiles(): string[] {
  // Pathspec `src` plus an extension filter in JS, rather than a `src/**/*.ts`
  // glob: the glob form silently misses a file sitting directly in `src/`.
  const out = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => f !== SELF)
}

/** Literal string paths passed to `.post(...)` / `.post<T>(...)`, in order. */
function literalPaths(source: string, method: 'post' | 'put'): string[] {
  const call = new RegExp(
    `\\.${method}\\s*(?:<[^>]*>)?\\s*\\(\\s*['"\`](\\/[^'"\`$]*)['"\`]`,
    'g',
  )
  return [...source.matchAll(call)].map((m) => m[1])
}

const files = sourceFiles()
const sources = new Map(files.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]))

/**
 * Every offending file mapped to the retired paths it calls, `{}` when clean.
 *
 * Aggregate rather than one `it.each` case per file (haven-reviewer, #2261):
 * a per-file case reports only the FIRST offender and, at ~356 files × 2, added
 * ~714 near-identical greens — a third of the frontend suite's reported test
 * count, and enough extra wall-clock to tip four unrelated timing-sensitive
 * modal suites over their timeouts on a loaded machine. This form names every
 * offender at once and costs two tests.
 */
function offenders(method: 'post' | 'put', retired: Set<string>): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const file of files) {
    const hits = literalPaths(sources.get(file)!, method).filter((p) => retired.has(p))
    if (hits.length > 0) found[file] = hits
  }
  return found
}

describe('retired Safe inflow routes have no frontend caller (#2261, epic #1440)', () => {
  it('sees the frontend source tree — an empty sweep would pass forever', () => {
    // The guard's own floor. Every zero below is only evidence if this is not.
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('src/lib/api.ts')
    expect(files).toContain('src/app/onboarding/OnboardingClient.tsx')
  })

  it('extracts real POST paths — proving a retired one would be seen', () => {
    // The positive control for `literalPaths`. If the extractor silently
    // matched nothing, the assertions below would be vacuous, which is the
    // exact failure mode this repo keeps finding in its own guards. These are
    // LIVE routes; the extractor that finds them would find a retired one.
    const all = files.flatMap((f) => literalPaths(sources.get(f)!, 'post'))
    expect(all).toContain('/accounts/hybrid')
    expect(all).toContain('/auth/signup')
    expect(all).toContain('/safe/exec')
  })

  it('no frontend module POSTs to a retired inflow route', () => {
    expect(
      offenders('post', RETIRED_POST),
      'Retired by #1984 (epic #1440): the route answers 410 and #1988 deleted ' +
        'what was behind it. New accounts come from POST /accounts/hybrid.',
    ).toEqual({})
  })

  it('no frontend module PUTs the legacy single-Safe link', () => {
    expect(
      offenders('put', RETIRED_PUT),
      'PUT /user/safe is the legacy single-Safe link, retired by #1984. Note ' +
        'PUT /user/safes/:id (rename, set default) is a different, live route ' +
        'and is deliberately not matched here.',
    ).toEqual({})
  })

  it('the deployPasskeySafe api helper stays deleted', () => {
    const callers = files.filter((f) => sources.get(f)!.includes(RETIRED_HELPER))
    expect(
      callers,
      `${RETIRED_HELPER} was deleted from lib/api.ts by #2261 with its only caller. ` +
        'It wrapped POST /safe/deploy, which answers 410.',
    ).toEqual([])
  })
})
