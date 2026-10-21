// `node --test` reporter for prove-red (#4234).
//
// prove-red runs a `node --test` target with this module as its reporter and
// reads the JSON lines it writes. Each line is one `test:start`, `test:pass` or
// `test:fail` event, reduced to what the classifier needs: the name, the
// nesting, whether the entry is a suite, skip/todo, and for a failure the error
// code, failure type and the *cause*'s name and code. The cause is what tells
// an assertion red (`ERR_ASSERTION`) from a compile, import or runtime red —
// the line between *caught* and *mutation-red* (`prove-red.mjs` § classify).
//
// No absolute paths are written, so a recorded run can be committed as a
// fixture (`scripts/ci/fixtures/prove-red/`) and replayed on any machine.

const KEPT = new Set(['test:start', 'test:pass', 'test:fail'])

const firstLine = (value) => (value === undefined || value === null ? null : String(value).split('\n')[0].slice(0, 300))

/** Reduce one reporter event to a JSON-safe record, or null when it is not kept. Pure. */
export function toRecord(event) {
  if (!event || !KEPT.has(event.type)) return null
  const data = event.data ?? {}
  const record = {
    type: event.type,
    name: String(data.name ?? ''),
    nesting: Number(data.nesting ?? 0),
  }
  if (data.details?.type) record.testType = data.details.type
  if (data.skip !== undefined && data.skip !== false) record.skip = true
  if (data.todo !== undefined && data.todo !== false) record.todo = true
  const error = data.details?.error
  if (event.type === 'test:fail' && error) {
    const cause = error.cause && typeof error.cause === 'object' ? error.cause : null
    record.error = {
      code: error.code ?? null,
      failureType: error.failureType ?? null,
      causeName: cause?.name ?? null,
      causeCode: cause?.code ?? null,
      message: firstLine(cause?.message ?? error.message),
    }
  }
  return record
}

export default async function* proveRedReporter(source) {
  for await (const event of source) {
    const record = toRecord(event)
    if (record) yield `${JSON.stringify(record)}\n`
  }
}
