import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import authRoutes from '../routes/auth.js'
import userRoutes from '../routes/user.js'
import passkeyRoutes from '../routes/passkeys.js'
import safeDeployRoutes from '../routes/safe-deploy.js'
import { installRequestValidation } from '../openapi/request-validation.js'

export async function buildApp() {
  const app = Fastify({ logger: false })

  // The production wiring (#3030, slice 2 of #3028): root-scope install with
  // the four modules this helper mounts enforced, as index.ts enforces them —
  // off-spec requests answer the 400 envelope before the handler, conformant
  // ones reach it unchanged. `safe-deploy.ts` is unspecced (the 410
  // tombstone carries a coverage exemption), so the key is inert there and
  // the 410 stays a 410; its test pins that.
  installRequestValidation(app, {
    mode: 'enforce',
    enforcedModules: ['routes/auth.ts', 'routes/user.ts', 'routes/passkeys.ts', 'routes/safe-deploy.ts'],
  })

  await app.register(fastifyJwt, {
    secret: 'test-secret',
  })

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(userRoutes, { prefix: '/user' })
  await app.register(passkeyRoutes, { prefix: '/passkeys' })
  await app.register(safeDeployRoutes, { prefix: '/safe' })

  return app
}
