/**
 * The expected installed-shell identity, derived from the app's own source
 * (#2735, epic #2736).
 *
 * `packages/frontend/scripts/screenshot.mjs` proves the installed-app shell
 * (#2729/#2765) survived a branch: it fetches `/manifest.webmanifest` and
 * checks the identity keys, and probes the root document for the iOS meta
 * tags. To do that it needs the EXPECTED values — and restating them as
 * literals in the harness would be the same defect the fixture section of
 * that script warns about for contract addresses: a harness that passes while
 * the shell drifted, because both sides were hand-written.
 *
 * So the expected side is READ from `src/lib/installed-app.ts` — the same pure
 * functions (`installedAppIdentity`, `buildWebManifest`, `installedAppMetadata`)
 * the manifest route and root layout call. `havenEnvironment` lives beside it
 * in `src/lib/env.ts` and is loaded too, so the environment reading comes from
 * the same module the app uses rather than a re-derivation here.
 *
 * `installed-app.ts` imports `./brand-colours` and `./env` extensionlessly, so
 * a plain `import()` from an .mjs cannot resolve it. esbuild (already in the
 * dependency tree — Next bundles it) resolves the sibling `.ts` imports and
 * strips the types; `bundle: true` with a stdin entry re-exporting both
 * modules produces one self-contained ESM text, which is written to a cache
 * file and imported dynamically.
 *
 * Why the transpile runs in a CHILD `node -e` process rather than in-process:
 * inside vitest's jsdom worker realm `new TextEncoder().encode('')` is not an
 * `instanceof` that realm's Uint8Array, and esbuild's JS API refuses to load
 * there ("your JavaScript environment is broken" — its startup invariant, not
 * an esbuild defect). A child process runs in the plain node realm where the
 * invariant holds (verified in-repo), so the same code path serves both the
 * harness CLI and the vitest tests of the verdict logic.
 *
 * The cache file lives INSIDE the package (`scripts/.installed-app-source.cache.mjs`,
 * gitignored): vite/vitest refuse dynamic imports of files outside the project
 * root, and the vitest suite loads this module too. The `?run=` query on the
 * import defeats the ESM loader's cache so a changed source re-loads within
 * one long-lived process.
 *
 * Dependency-free guarantee of the docs validators does NOT extend here: the
 * screenshot harness already requires the dev toolchain (it boots `next dev`
 * and Playwright), so requiring esbuild adds nothing a run does not already
 * need. A transpile failure surfaces as a thrown error naming the entry.
 */

import { statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'lib')
const TARGET = join(SRC, 'installed-app.ts')
const CACHE_FILE = join(HERE, '.installed-app-source.cache.mjs')

let cache = { mtimeMs: null, value: null }

/**
 * Run esbuild in a child node process (plain realm — see the docblock) and
 * return the bundle text for a stdin entry that re-exports BOTH identity
 * modules. stdin's `resolveDir` is what makes the sibling specifiers
 * resolvable; their own extensionless imports are resolved by
 * `resolveExtensions`.
 */
function bundleInChildNode() {
  const script = `
    const { createRequire } = require('node:module');
    const req = createRequire(${JSON.stringify(HERE + '/')});
    const esbuild = req('esbuild');
    const result = esbuild.buildSync({
      stdin: {
        contents: 'export * from "./installed-app";\\nexport * from "./env";\\n',
        loader: 'ts',
        sourcefile: 'installed-app-entry.ts',
        resolveDir: ${JSON.stringify(SRC)},
      },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
      outfile: 'installed-app.mjs',
      loader: { '.ts': 'ts' },
      resolveExtensions: ['.ts'],
      logLevel: 'silent',
    });
    if (result.errors.length > 0) {
      console.error(result.errors[0].text);
      process.exit(3);
    }
    process.stdout.write(result.outputFiles[0].text);
  `
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

/** Transpile once per source mtime and return the module namespace. */
export async function loadInstalledAppModule() {
  const mtimeMs = statSync(TARGET).mtimeMs
  if (cache.value && cache.mtimeMs === mtimeMs) return cache.value

  const code = bundleInChildNode()
  writeFileSync(CACHE_FILE, code)
  try {
    // `?run=` defeats the ESM loader's cache so a changed source re-loads
    // within one long-lived process. The PROMISE is what gets cached — one
    // load per mtime, shared by concurrent callers.
    const mod = import(`${pathToFileURL(CACHE_FILE).href}?run=${mtimeMs.toFixed(6)}`)
    cache = { mtimeMs, value: await mod }
    return cache.value
  } catch (err) {
    // A failed load must not poison the cache file for the next caller.
    try {
      rmSync(CACHE_FILE, { force: true })
    } catch {
      /* best effort */
    }
    throw err
  }
}

/**
 * The EXPECTED state for one environment, in the shape
 * `installedShellProblems` consumes:
 *
 *   { environment, expectedManifest, expectedTitle }
 *
 * - `expectedManifest` — the exact `buildWebManifest(env)` object.
 * - `environment` — the `havenEnvironment()` reading (`production` or `dev`).
 * - `expectedTitle` — the apple-mobile-web-app-title the layout must emit.
 *
 * `env.ts` reads `process.env.NEXT_PUBLIC_HAVEN_ENV` literally for Next's
 * build-time inlining; in this bridge nothing defines it, so the member
 * expression reads undefined at runtime — which the env module's own
 * convention maps to `production`. That matches what an UNSET build serves,
 * which is exactly what `npm run dev` in this harness runs.
 */
export async function loadInstalledAppExpectations() {
  const mod = await loadInstalledAppModule()
  const env = mod.havenEnvironment(undefined)
  return {
    environment: env,
    expectedManifest: mod.buildWebManifest(env),
    expectedTitle: mod.installedAppMetadata(env).appleWebApp.title,
  }
}
