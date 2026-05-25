import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import openapiRoutes from '../routes/openapi.js'
import { openapiSpec } from './spec.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../lib/agent-payment-taxonomy.js'

describe('openapiSpec', () => {
  it('publishes an OpenAPI 3.1 document for the agent payment surface', () => {
    expect(openapiSpec.openapi).toBe('3.1.0')
    expect(openapiSpec.paths).toHaveProperty('/openapi.json')
    expect(openapiSpec.paths).toHaveProperty('/agents')
    expect(openapiSpec.paths).toHaveProperty('/agents/{id}')
    expect(openapiSpec.paths).toHaveProperty('/agents/{id}/revoke')
    expect(openapiSpec.paths).toHaveProperty('/payments')
    expect(openapiSpec.paths).toHaveProperty('/payments/{id}')
    expect(openapiSpec.paths).toHaveProperty('/payments/{id}/resume_state')
    expect(openapiSpec.paths).toHaveProperty('/x402/authorize')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/authorize')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/{id}/status')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/evidence')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/reconciliation-events')
    expect(openapiSpec.paths).toHaveProperty('/transactions')
  })

  it('keeps payment taxonomy enums in sync with backend exports', () => {
    expect(openapiSpec.components.schemas.AgentPaymentPhase.enum).toEqual(
      Object.values(AgentPaymentPhase),
    )
    expect(openapiSpec.components.schemas.AgentPaymentNextAction.enum).toEqual(
      Object.values(AgentPaymentNextAction),
    )
    expect(openapiSpec.components.schemas.AgentPaymentRail.enum).toEqual(
      Object.values(AgentPaymentRail),
    )
  })

  it('documents the non-custodial authority boundary in security schemes and resume state', () => {
    const agentScheme = openapiSpec.components.securitySchemes.AgentApiKey
    expect(agentScheme.description).toMatch(/identity/i)
    expect(agentScheme.description).toMatch(/signature is authority/i)
    expect(agentScheme.description).toMatch(/API keys alone cannot move funds/i)

    const resumeDescription =
      openapiSpec.paths['/payments/{id}/resume_state'].get.description
    expect(resumeDescription).toMatch(/context only/i)
    expect(resumeDescription).toMatch(/does not sign/i)
  })

  it('serves the exact spec at /openapi.json', async () => {
    const app = Fastify({ logger: false })
    await app.register(openapiRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('max-age=300')
    expect(response.json()).toEqual(openapiSpec)

    await app.close()
  })
})
