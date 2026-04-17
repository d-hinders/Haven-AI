// config.ts loads dotenv and validates required env vars — import first
import { config } from './config.js'

import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import { runMigrations } from './db/migrate.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import balanceRoutes from './routes/balances.js'
import transactionRoutes from './routes/transactions.js'
import portfolioRoutes from './routes/portfolio.js'
import safeDetailRoutes from './routes/safe-details.js'
import agentRoutes from './routes/agents.js'
import contactRoutes from './routes/contacts.js'
import paymentRoutes from './routes/payments.js'
import approvalRoutes from './routes/approvals.js'
import agentActivityRoutes from './routes/agent-activity.js'
import x402Routes from './routes/x402.js'
import userSafesRoutes from './routes/user-safes.js'
import pool from './db.js'

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
})

// --- Global error handler ---
app.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error.statusCode ?? 500

  if (statusCode >= 500) {
    request.log.error({ err: error, reqId: request.id }, 'Unhandled server error')
  } else {
    request.log.warn({ err: error, reqId: request.id }, 'Client error')
  }

  reply.status(statusCode).send({
    error: statusCode >= 500 ? 'Internal server error' : error.message,
    statusCode,
  })
})

// --- Process-level error handlers ---
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection')
})

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception — shutting down')
  process.exit(1)
})

// --- Plugins ---
await app.register(cors, {
  origin: config.frontendUrl,
})

await app.register(fastifyJwt, {
  secret: config.jwtSecret,
})

// --- Routes ---
app.get('/health', async (_request, reply) => {
  const start = Date.now()
  try {
    await pool.query('SELECT 1')
    const dbLatencyMs = Date.now() - start
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: { status: 'ok', latencyMs: dbLatencyMs },
    }
  } catch (err) {
    reply.status(503)
    return {
      status: 'degraded',
      timestamp: new Date().toISOString(),
      db: { status: 'error', error: err instanceof Error ? err.message : String(err) },
    }
  }
})

await app.register(authRoutes, { prefix: '/auth' })
await app.register(userRoutes, { prefix: '/user' })
await app.register(balanceRoutes, { prefix: '/balances' })
await app.register(transactionRoutes, { prefix: '/transactions' })
await app.register(portfolioRoutes, { prefix: '/portfolio' })
await app.register(safeDetailRoutes, { prefix: '/safe' })
await app.register(agentRoutes, { prefix: '/agents' })
await app.register(contactRoutes, { prefix: '/contacts' })
await app.register(paymentRoutes, { prefix: '/payments' })
await app.register(approvalRoutes, { prefix: '/approvals' })
await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
await app.register(x402Routes, { prefix: '/x402' })
await app.register(userSafesRoutes, { prefix: '/user/safes' })

// --- Start ---
const start = async () => {
  try {
    await runMigrations()
    app.log.info('Database migrations complete')

    await app.listen({ port: config.port, host: '0.0.0.0' })
    app.log.info(`Haven backend running on port ${config.port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
