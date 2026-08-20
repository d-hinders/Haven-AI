import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { authMiddleware } from '../middleware/auth.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import {
  findUserCredentialsByEmail,
  findUserIdByEmail,
  findUserProfileById,
  insertUser,
} from '../infra/repositories/users.js'
import { listSessionSafesForUser } from '../infra/repositories/user-safes.js'
import { sessionSafePayload } from '../modules/accounts/index.js'

const SALT_ROUNDS = 10

/**
 * A real bcrypt hash of a value nobody can present, computed ONCE at module
 * load (#1646).
 *
 * Login answers the same 401 for an unknown email and a wrong password so the
 * endpoint is not an account-enumeration oracle. That was true of the STATUS
 * and BODY and false of the timing: `bcrypt.compare` at cost factor 10 takes
 * tens of milliseconds and used to run only when a user row existed, so an
 * unknown address returned after a single fast SELECT. The difference is
 * consistent, measurable by anyone unauthenticated, and discloses exactly what
 * the equal-401 was there to hide.
 *
 * Comparing against this hash on the unknown-email path makes both paths do
 * the same work. The value is unguessable and never stored, so a compare
 * against it can only ever fail — it costs time, not security.
 */
const ABSENT_USER_PASSWORD_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), SALT_ROUNDS)
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

    // The lookup takes the NORMALISED address: an exact match on the raw
    // input would let `ADA@Example.com` pass this check against a stored
    // `ada@example.com`, giving one person two accounts and two treasuries.
    if (await findUserIdByEmail(normalizedEmail)) {
      return reply.code(409).send({ error: 'An account with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

    const user = await insertUser(normalizedName, normalizedEmail, passwordHash)
    emitFunnelEvent(user.id, 'signed_up')

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

    const user = await findUserCredentialsByEmail(normalizedEmail)

    // Same 401 as a wrong password, deliberately: telling the two apart would
    // make this endpoint an account-enumeration oracle. The comparison runs
    // on BOTH paths (#1646) — against the absent-user hash when there is no
    // row — so the answer costs the same whether or not the account exists.
    // Skipping it for an unknown email leaked, through latency alone, exactly
    // what the identical 401 was hiding.
    const valid = await bcrypt.compare(password, user?.password_hash ?? ABSENT_USER_PASSWORD_HASH)

    if (!user || !valid) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const token = app.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: '7d' },
    )

    const safes = (await listSessionSafesForUser(user.id)).map(sessionSafePayload)

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        wallet_address: user.wallet_address,
        safe_address: user.safe_address,
        currency_preference: user.currency_preference ?? 'USD',
        safes,
      },
    }
  })

  // GET /auth/me — protected
  app.get('/me', { onRequest: authMiddleware }, async (request) => {
    const { sub } = request.user as { sub: string }

    // `sub` is the JWT subject — never a client-supplied id. Both reads below
    // are scoped to it.
    const profile = await findUserProfileById(sub)

    if (!profile) {
      throw { statusCode: 404, message: 'User not found' }
    }

    const safes = (await listSessionSafesForUser(sub)).map(sessionSafePayload)

    return { ...profile, safes }
  })
}
