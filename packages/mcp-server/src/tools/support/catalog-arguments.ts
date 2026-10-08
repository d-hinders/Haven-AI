/**
 * Shared hosted-MCP support — catalog argument resolution for the guided
 * preflight (#3769).
 *
 * `haven_prepare_catalog_purchase` historically refused caller arguments
 * outright: the merchant URL, tool name and tool arguments came from the
 * catalog row, never from the call. That is right for fixed-SKU rows (the
 * CloudNest tiers) but made every per-call tool (text, images, songs,
 * search) unbuyable through the guided path. A row can now DECLARE an
 * argument schema; for such rows caller `arguments` are accepted, merged
 * over the row's pinned ones and validated against the schema BEFORE the
 * merchant is contacted — so an invalid call is refused before any payment
 * exists, never after.
 *
 * One-direction dependencies: imports only the SDK and sibling support
 * (`errors`, `guidance`). Never imports a capability module.
 */
import { AgentPaymentNextAction, type HavenCatalogEntry } from '@haven_ai/sdk'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { HostedToolError } from './errors.js'
import { refusalNextStep } from './guidance.js'

/**
 * allErrors: the refusal should name every failing path of a bad call, not
 * just the first — an agent correcting `arguments` wants the whole list.
 * strict: false — these schemas are the MERCHANT's (copied or pinned by an
 * operator row), and a schema the merchant would honor must not be refused
 * because it mixes draft conventions or carries unknown keywords; ajv still
 * validates everything it understands.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false })

/** The row's schema as ajv should read it: `$schema` URIs stripped. */
function compilableCopy(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _stripped, ...rest } = schema
  return rest
}

function argumentRefusal(entry: HavenCatalogEntry, detail: string): HostedToolError {
  return new HostedToolError({
    code: 'INVALID_CATALOG_ARGUMENTS',
    message: detail,
    statusCode: 400,
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason:
        'the arguments have to satisfy the catalog row before anything is called again',
    }),
  })
}

/**
 * Resolve the merchant call arguments for a prepared catalog purchase.
 *
 * A row WITHOUT a declared schema is a fixed SKU: its arguments are the
 * row's own, and caller arguments are refused (INVALID_INPUT — the same
 * code the cap refusals use, and a hardening of the old drop-in-silence
 * contract, so the caller cannot mistake an ignored `arguments` for a
 * honored one).
 *
 * A row WITH a declared schema accepts caller arguments, merged over the
 * row's pinned ones (the preset first, the caller may override per key),
 * and the merged object must satisfy the schema. The row's own preset is
 * validated too — an operator row whose pinned arguments violate its own
 * schema is refused the same way, before any network call.
 *
 * The schema itself is trusted to be a JSON Schema the local ajv can
 * compile; an uncompilable row schema refuses with the same code and names
 * the row, rather than making the failure look like the caller's.
 */
export function resolveCatalogCallArguments(
  entry: HavenCatalogEntry,
  callerArguments: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const preset = entry.toolArguments ?? {}

  if (!entry.toolArgumentsSchema) {
    if (callerArguments !== undefined && Object.keys(callerArguments).length > 0) {
      throw new HostedToolError({
        code: 'INVALID_INPUT',
        message:
          `Catalog entry "${entry.id}" (${entry.name}) is a fixed-SKU purchase: its arguments are pinned by ` +
          `the catalog row (${JSON.stringify(preset)}) and the row declares no argument schema, so caller ` +
          `arguments are refused. No merchant was contacted and no payment exists. Per-call arguments are ` +
          `only accepted on rows that declare an argument schema.`,
        statusCode: 400,
        nextStep: refusalNextStep({
          nextAction: AgentPaymentNextAction.StopAndTellUser,
          nextTool: null,
          nextToolOmittedReason: 'the catalog row pins the call; nothing to decide before a retry without arguments',
        }),
      })
    }
    return preset
  }

  const merged = { ...preset, ...(callerArguments ?? {}) }
  let validate: ValidateFunction
  try {
    validate = ajv.compile(compilableCopy(entry.toolArgumentsSchema))
  } catch (err) {
    throw argumentRefusal(
      entry,
      `Catalog entry "${entry.id}" (${entry.name}) declares an argument schema that could not be ` +
        `compiled (${err instanceof Error ? err.message : String(err)}). This is a catalog row defect, ` +
        'not an argument problem: the arguments were not validated and nothing was contacted or paid. ' +
        'Report it; use haven_quote_mcp_tool + haven_pay_mcp_tool manually in the meantime.',
    )
  }
  if (!validate(merged)) {
    const details = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
      .join('; ')
    throw argumentRefusal(
      entry,
      `The arguments for catalog entry "${entry.id}" (${entry.name}) do not satisfy the row's declared ` +
        `argument schema: ${details}. No merchant was contacted and no payment exists. Read the row's ` +
        'tool_arguments_schema (haven_discover_tools / the catalog detail), send a valid `arguments` ' +
        'object, and re-run this tool.',
    )
  }
  return merged
}
