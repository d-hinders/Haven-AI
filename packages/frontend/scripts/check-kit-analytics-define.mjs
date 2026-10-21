// #4216 — build-output check for the @metamask/smart-accounts-kit analytics
// opt-out. The frontend mechanism is a bundler define (`env: { DO_NOT_TRACK:
// '1' }` in next.config.ts), which inlines the kit's `process.env?.DO_NOT_TRACK`
// read as the literal "1" in the client chunk. This script proves the define
// actually landed, over the real `next build` output:
//
//   1. the chunk that carries the kit's analytics endpoint must exist in the
//      client bundle (otherwise the check would be vacuously green), and
//   2. that chunk must contain NO `DO_NOT_TRACK` token at all — the property
//      name survives minification, so a runtime read still in the chunk fails
//      this check. Removing the define from next.config.ts reintroduces
//      `process.env?.DO_NOT_TRACK` into the chunk and fails here.
//
// Wired into `npm run build -w @haven/frontend` after `next build`. Run from
// packages/frontend (the .next directory is relative to it).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ANALYTICS_ENDPOINT = 'mm-sdk-analytics.api.cx.metamask.io'

const chunksRoot = join(process.cwd(), '.next', 'static', 'chunks')

function walkJsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkJsFiles(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

let jsFiles
try {
  jsFiles = walkJsFiles(chunksRoot)
} catch {
  console.error(
    `FAIL: no client chunks under ${chunksRoot}. Run \`next build\` before this check.`,
  )
  process.exit(2)
}

const kitChunks = jsFiles.filter((f) => {
  try {
    return readFileSync(f, 'utf8').includes(ANALYTICS_ENDPOINT)
  } catch {
    return false
  }
})

if (kitChunks.length === 0) {
  console.error(
    `FAIL: no client chunk contains ${ANALYTICS_ENDPOINT}. Either the kit left ` +
      `the bundle (re-point this check) or the build did not include it — ` +
      `a vacuous green here would prove nothing.`,
  )
  process.exit(1)
}

const offenders = kitChunks.filter((f) => readFileSync(f, 'utf8').includes('DO_NOT_TRACK'))

if (offenders.length > 0) {
  console.error(
    `FAIL: the kit chunk(s) still read DO_NOT_TRACK at runtime — the define did not land:\n` +
      offenders.map((f) => `  ${f}`).join('\n') +
      `\nRestored the env: { DO_NOT_TRACK: '1' } define in next.config.ts.`,
  )
  process.exit(1)
}

console.log(
  `OK: ${kitChunks.length} client chunk(s) carry the kit analytics endpoint and none reads DO_NOT_TRACK at runtime — the analytics opt-out define is in the bundle.`,
)
