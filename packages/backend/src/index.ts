import dotenv from 'dotenv'
import path from 'path'

// Load .env from monorepo root (CWD is monorepo root when run via npm scripts)
dotenv.config({ path: path.resolve(process.cwd(), '.env') })
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import { runMigrations } from './db/migrate.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import balanceRoutes from './routes/balances.js'
import transactionRoutes from './routes/transactions.js'

const app = Fastify({ logger: true })

// --- Plugins ---
await app.register(cors, {
  origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
})

await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET ?? 'change_me_in_production',
})

// --- Routes ---
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

await app.register(authRoutes, { prefix: '/auth' })
await app.register(userRoutes, { prefix: '/user' })
await app.register(balanceRoutes, { prefix: '/balances' })
await app.register(transactionRoutes, { prefix: '/transactions' })

// --- Start ---
const start = async () => {
  try {
    await runMigrations()
    app.log.info('Database migrations complete')

    const port = Number(process.env.PORT) || 3001
    await app.listen({ port, host: '0.0.0.0' })
    app.log.info(`Haven backend running on port ${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
