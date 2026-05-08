import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const SALT_ROUNDS = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 255
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

interface SignupBody {
  name: string
  email: string
  password: string
}

interface LoginBody {
  email: string
  password: string
}

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null

  const normalized = email.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !EMAIL_RE.test(normalized)
  ) {
    return null
  }

  return normalized
}

function normalizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null

  const normalized = name.trim().replace(/\s+/g, ' ')
  if (
    normalized.length === 0 ||
    normalized.length > MAX_NAME_LENGTH ||
    CONTROL_CHAR_RE.test(name)
  ) {
    return null
  }

  return normalized
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/signup
  app.post<{ Body: SignupBody }>('/signup', async (request, reply) => {
    const { name, email, password } = request.body
    const normalizedName = normalizeName(name)
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedName) {
      return reply.code(400).send({ error: 'Enter a name using 80 characters or fewer' })
    }

    if (!normalizedEmail) {
      return reply.code(400).send({ error: 'Invalid email address' })
    }

    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: 'Password must be 128 characters or fewer' })
    }

    // Check for existing user
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
      normalizedEmail,
    ])
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'An account with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
      [normalizedName, normalizedEmail, passwordHash],
    )

    const user = result.rows[0]

    const token = app.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: '7d' },
    )

    return reply.code(201).send({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        wallet_address: null,
        safe_address: null,
        currency_preference: 'USD',
        safes: [],
      },
    })
  })

  // POST /auth/login
  app.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    const { email, password } = request.body
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedEmail || !password) {
      return reply.code(400).send({ error: 'Email and password are required' })
    }

    const result = await pool.query(
      'SELECT id, name, email, password_hash, wallet_address, safe_address, currency_preference FROM users WHERE email = $1',
      [normalizedEmail],
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

    // Fetch user's Safes
    const safesResult = await pool.query(
      `SELECT id, safe_address, chain_id, name, is_default, created_at
       FROM user_safes WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    )

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        wallet_address: user.wallet_address,
        safe_address: user.safe_address,
        currency_preference: user.currency_preference ?? 'USD',
        safes: safesResult.rows,
      },
    }
  })

  // GET /auth/me — protected
  app.get('/me', { onRequest: authMiddleware }, async (request) => {
    const { sub } = request.user as { sub: string }

    const result = await pool.query(
      'SELECT id, name, email, wallet_address, safe_address, currency_preference, created_at FROM users WHERE id = $1',
      [sub],
    )

    if (result.rows.length === 0) {
      throw { statusCode: 404, message: 'User not found' }
    }

    // Fetch user's Safes
    const safesResult = await pool.query(
      `SELECT id, safe_address, chain_id, name, is_default, created_at
       FROM user_safes WHERE user_id = $1 ORDER BY created_at ASC`,
      [sub],
    )

    return {
      ...result.rows[0],
      safes: safesResult.rows,
    }
  })
}
