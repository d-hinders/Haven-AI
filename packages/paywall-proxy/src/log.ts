/**
 * The proxy's one log line writer: a JSON object per line on stdout. Every
 * line is passed through `redact`, which replaces any occurrence of a
 * configured secret (the upstream key, the Coinbase secret) with a marker, so
 * a secret that reached a field by mistake still never reaches the log. Fields
 * carry identifiers and outcomes only; never a request header or a body.
 */
export type LogFn = (event: string, fields?: Record<string, unknown>) => void

export function redactor(secrets: readonly string[]): (text: string) => string {
  const needles = secrets.filter((s) => s.length > 0)
  return (text) => needles.reduce((acc, secret) => acc.split(secret).join('[redacted]'), text)
}

export function createLogger(secrets: readonly string[], write: (line: string) => void = (l) => console.log(l)): LogFn {
  const redact = redactor(secrets)
  return (event, fields = {}) => {
    write(redact(JSON.stringify({ time: new Date().toISOString(), event, ...fields })))
  }
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * The shared payment core logs with `console.error` / `console.warn`, and its
 * lines carry an error's text, which comes from the facilitator or the network
 * and is not ours to vouch for. Passing every console call through the same
 * redaction means no secret reaches output by that route either. Returns a
 * function that puts the original console methods back.
 */
export function installConsoleRedaction(secrets: readonly string[]): () => void {
  const redact = redactor(secrets)
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const)
  for (const [method, original] of originals) {
    console[method] = (...args: unknown[]): void => {
      original.apply(
        console,
        args.map((arg) => {
          if (typeof arg === 'string') return redact(arg)
          if (arg !== null && typeof arg === 'object') {
            try {
              const text = JSON.stringify(arg)
              return redact(text) === text ? arg : redact(text)
            } catch {
              return arg
            }
          }
          return arg
        }),
      )
    }
  }
  return () => {
    for (const [method, original] of originals) console[method] = original
  }
}
