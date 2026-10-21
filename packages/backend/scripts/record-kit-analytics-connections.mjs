// #4216 — connection recorder for the @metamask/smart-accounts-kit analytics
// host. Committed here because the scan's recorder lived outside the tree and
// the acceptance criteria require the suite-level net to be reproducible from
// the PR alone.
//
// Preload it so the net is in place before ANY module evaluates (the kit's
// HTTP client captures globalThis.fetch when the kit is imported, so a net
// installed later never sees its posts):
//
//   CI= DO_NOT_TRACK= \
//   NODE_OPTIONS="--import ./scripts/record-kit-analytics-connections.mjs" \
//   npm test -w @haven/backend
//
// Every observed connection to mm-sdk-analytics.api.cx.metamask.io is appended
// as one JSON line to $KIT_ANALYTICS_RECORDING_FILE (default
// `.kit-analytics-connections.jsonl` in the working directory). A clean run is
// zero lines. The recorder never changes behavior — it only observes.
//
// Note the `CI=` in the command: GitHub Actions exports CI=true, which is one
// of the kit's own opt-out inputs — a net run that inherits it measures
// nothing.

import { appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import path from 'node:path'

const ANALYTICS_HOST = 'mm-sdk-analytics.api.cx.metamask.io'
const RECORDING_FILE =
  process.env.KIT_ANALYTICS_RECORDING_FILE || '.kit-analytics-connections.jsonl'

function record(kind, where) {
  try {
    appendFileSync(
      RECORDING_FILE,
      `${JSON.stringify({ kind, where, at: new Date().toISOString() })}\n`,
    )
  } catch {
    // Never let the recorder break the process it observes.
  }
}

// fetch: the kit's actual path (openapi-fetch captures globalThis.fetch at
// module evaluation — the preload order guarantees the wrapper is what it
// captures).
if (typeof globalThis.fetch === 'function') {
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    try {
      let url = null
      if (typeof input === 'string' || input instanceof URL) url = String(input)
      else if (input && typeof input === 'object' && 'url' in input) url = input.url
      if (url && new URL(url).host === ANALYTICS_HOST) record('fetch', url)
    } catch {
      // Malformed input is the caller's problem; stay transparent.
    }
    return baseFetch(input, init)
  }
}

// http/https.request and tls.connect: the socket-level net, so posts that bypass
// the wrapped fetch (a direct Agent, undici internals) are still seen.
function hostFromOptions(options) {
  if (!options) return null
  if (typeof options === 'string' || options instanceof URL) {
    try {
      return new URL(options).host
    } catch {
      return null
    }
  }
  const host = options.host || options.hostname || options.servername
  return host ? `${host}${options.port ? `:${options.port}` : ''}` : null
}

for (const [mod, method] of [
  [https, 'request'],
  [http, 'request'],
]) {
  const base = mod[method].bind(mod)
  mod[method] = (...args) => {
    try {
      const first = args.find(
        (a) => typeof a === 'string' || a instanceof URL || (a && typeof a === 'object'),
      )
      const host = hostFromOptions(first)
      if (host && host.startsWith(ANALYTICS_HOST)) record(method, host)
    } catch {
      // Stay transparent.
    }
    return base(...args)
  }
}

const baseTlsConnect = tls.connect.bind(tls)
tls.connect = (...args) => {
  try {
    const host = hostFromOptions(args[0])
    if (host && host.startsWith(ANALYTICS_HOST)) record('tls.connect', host)
  } catch {
    // Stay transparent.
  }
  return baseTlsConnect(...args)
}
