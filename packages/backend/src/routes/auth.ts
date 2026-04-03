import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const SALT_ROUNDS = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface SignupBody {
  email: string
  password: string
}

interface LoginBody {
  email: string
  password: string
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/signup
  app.post<{ Body: SignupBody }>('/signup', async (request, reply) => {
    const { email, password } = request.body

    if (!email || !EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'Invalid email address' })
    }

    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    // Check for existing user
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase(),
    ])
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'An account with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email.toLowerCase(), passwordHash],
    )

    const user = result.rows[0]
    return reply.code(201).send({ id: user.id, email: user.email })
  })

  // POST /auth/login
  app.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    const { email, password } = request.body

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' })
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, wallet_address, safe_address, currency_preference FROM users WHERE email = $1',
      [email.toLowerCase()],
    )

    if (result.rows.length === 0) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)

    if (!valid) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const token = app.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: '7d' },
    )

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        wallet_address: user.wallet_address,
        safe_address: user.safe_address,
        currency_preference: user.currency_preference ?? 'USD',
      },
    }
  })

  // GET /auth/me — protected
  app.get('/me', { onRequest: authMiddleware }, async (request) => {
    const { sub } = request.user as { sub: string }

    const result = await pool.query(
      'SELECT id, email, wallet_address, safe_address, currency_preference, created_at FROM users WHERE id = $1',
      [sub],
    )

    if (result.rows.length === 0) {
      throw { statusCode: 404, message: 'User not found' }
    }

    return result.rows[0]
  })
}
