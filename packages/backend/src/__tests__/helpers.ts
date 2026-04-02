import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import authRoutes from '../routes/auth.js'
import userRoutes from '../routes/user.js'

export async function buildApp() {
  const app = Fastify({ logger: false })

  await app.register(fastifyJwt, {
    secret: 'test-secret',
  })

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(userRoutes, { prefix: '/user' })

  return app
}
