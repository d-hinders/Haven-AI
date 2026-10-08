import type { PoolClient } from 'pg'

export const version = '107_catalog_call_semantics'

/**
 * #3769 — catalog rows can declare HOW a purchase calls the merchant:
 *
 *   - `tool_arguments_schema`: a JSON Schema a per-call MCP tool's arguments
 *     must satisfy (`haven_prepare_catalog_purchase` validates caller
 *     `arguments` against it and refuses a row without one — fixed-SKU rows
 *     like the CloudNest tiers keep refusing caller arguments entirely);
 *   - `http_method` / `body_type` / `body_example`: the request shape a
 *     plain-HTTP x402 resource needs, so the catalog verifier probes with
 *     the declared method and discovery suggests the right call instead of
 *     a GET-only hint for a POST paywall.
 *
 * Data fixes for the two rows the issue measured live on 2026-10-08:
 *   - Soundside `create_text` (https://mcp.soundside.ai/mcp) is a per-call
 *     text tool whose merchant schema has NO required fields (prompt and
 *     messages both default), so a `{}` call is accepted and paid and
 *     generates from nothing. The row pins the merchant's real inputSchema
 *     (read via tools/list on 2026-10-08) TIGHTENED with the required
 *     clause the issue asks for: at least one of prompt / messages must be
 *     present, so prepare with `{}` is refused before any payment exists.
 *   - Anchor token price (https://api.anchor-x402.com/v1/price/token) is a
 *     POST endpoint (its own 402 says "POST wrapper, body: {symbol} or
 *     {chain, contract}"). Pin POST + a JSON body example so the guided
 *     path quotes with the call the merchant can actually answer.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS tool_arguments_schema JSONB,
      ADD COLUMN IF NOT EXISTS http_method TEXT,
      ADD COLUMN IF NOT EXISTS body_type TEXT,
      ADD COLUMN IF NOT EXISTS body_example JSONB
  `)

  await client.query(`
    UPDATE merchant_catalog
    SET tool_arguments_schema = $1::jsonb
    WHERE resource_url = 'https://mcp.soundside.ai/mcp'
      AND tool_name = 'create_text'
  `, [
    JSON.stringify({
      type: 'object',
      title: 'create_textArguments',
      properties: {
        provider: {
          type: 'string',
          enum: ['minimax', 'vertex', 'grok', 'qwen'],
          default: 'vertex',
          description: 'AI provider for text generation',
        },
        messages: {
          type: 'array',
          items: { type: 'object', additionalProperties: { type: 'string' } },
          default: [],
          description: 'Chat messages with role and content',
        },
        prompt: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          default: null,
          description: 'Single prompt (alternative to messages)',
        },
        model: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          default: null,
          description: 'Model name override',
        },
        temperature: { type: 'number', default: 0.7, description: 'Sampling temperature (0-2)' },
        max_tokens: { type: 'integer', default: 512, description: 'Maximum tokens to generate' },
        advanced_options: {
          anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
          default: null,
          description: 'Provider-specific settings dict',
        },
        json_schema: {
          anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
          default: null,
          description: 'JSON schema for structured output',
        },
        store_response: { type: 'boolean', default: false, description: 'Store response as library resource' },
        project_id: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          default: null,
          description: 'Library project UUID',
        },
      },
      // #3769: the merchant's own schema has no required clause (both prompt
      // and messages default), which is exactly the paid generate-from-nothing
      // hole — the pin tightens the COPY, not the merchant.
      anyOf: [{ required: ['prompt'] }, { required: ['messages'] }],
    }),
  ])

  await client.query(`
    UPDATE merchant_catalog
    SET http_method = 'POST',
        body_type = 'json',
        body_example = '{"symbol":"BTC"}'::jsonb
    WHERE resource_url = 'https://api.anchor-x402.com/v1/price/token'
  `)
}

export async function down(client: PoolClient): Promise<void> {
  // The two UPDATEs are reverted by dropping the columns that hold them; no
  // other row was touched.
  await client.query(`
    ALTER TABLE merchant_catalog
      DROP COLUMN IF EXISTS tool_arguments_schema,
      DROP COLUMN IF EXISTS http_method,
      DROP COLUMN IF EXISTS body_type,
      DROP COLUMN IF EXISTS body_example
  `)
}
