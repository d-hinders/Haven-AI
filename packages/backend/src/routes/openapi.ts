import { FastifyInstance } from 'fastify'
import { openapiSpec } from '../openapi/spec.js'

export default async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', async (_request, reply) => {
    return reply
      .header('cache-control', 'public, max-age=300')
      .send(openapiSpec)
  })
}
