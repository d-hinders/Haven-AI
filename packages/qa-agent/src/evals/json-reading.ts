/**
 * The eval lanes' tolerant JSON reading, shared by the Hermes log parser
 * (`hermes.ts`) and the session-transcript redactor (`redact-sessions.ts`,
 * #4137). Moved here from `hermes.ts`, where both were module-private, so
 * the redactor reads a hosted tool result exactly the way the graders do.
 */

/**
 * Parse `text` when it looks like a JSON object or array (after trimming);
 * anything else, or a parse failure, is `undefined`. A bare scalar is never
 * parsed: a tool result that says `"ok"` stays text.
 */
export function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Deep-search a parsed payload for one field's value (string or boolean only). */
export function deepFind(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key && (typeof v === 'string' || typeof v === 'boolean')) return v
    const hit = deepFind(v, key)
    if (hit !== undefined) return hit
  }
  return undefined
}
