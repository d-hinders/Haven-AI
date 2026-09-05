import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { authMiddleware } from '../middleware/auth.js'
import { authRateLimit } from '../middleware/rate-limit.js'
import { config } from '../config.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import { normalizeViaMarker } from '../domain/handoff-links.js'
import { OWNER_CLI_PURPOSE } from '../middleware/owner-cli.js'
import {
  DEVICE_CODE_TTL_MS,
  approveDeviceAuthorization,
  createDeviceAuthorization,
  denyDeviceAuthorization,
  findByDeviceCode,
  generateUserCode,
  purgeExpired,
  redeemDeviceAuthorization,
} from '../infra/repositories/device-authorizations.js'
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
  /**
   * Agent hand-off marker (#2522). `'agent'` when the signup link was pasted
   * by an agent; every other value is dropped. Sanitized, never refused —
   * attribution must never cost someone an account.
   */
  via?: string
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

export default async function authRoutes(
  app: FastifyInstance,
  opts: { trustProxyHops?: number } = {},
): Promise<void> {
  // #1670: the auth tier only arms when the deployment trusts its proxy —
  // see authRateLimit for why an untrusted per-IP limit here is a DoS, not a
  // protection. Injectable so tests can exercise both states; production
  // callers never pass it and get the environment's value.
  const trustProxyHops = opts.trustProxyHops ?? config.trustProxyHops

  // POST /auth/signup
  app.post<{ Body: SignupBody }>('/signup', { config: { ...authRateLimit(trustProxyHops, 'signup') } }, async (request, reply) => {
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

    // #2522: `via` is sanitized to the enum `agent` or null. It rides the
    // `signed_up` event as `handoff_via`, NOT as `via` — that key is already
    // used in this funnel's metadata to name which CODE PATH created a record
    // (see the `agent_created` emission in routes/agent-connection-setups.ts),
    // and giving one key two meanings would silently redefine historical rows.
    const via = normalizeViaMarker(request.body.via)
    const user = await insertUser(normalizedName, normalizedEmail, passwordHash, via)
    emitFunnelEvent(user.id, 'signed_up', via ? { handoff_via: via } : undefined)

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
  app.post<{ Body: LoginBody }>('/login', { config: { ...authRateLimit(trustProxyHops, 'login') } }, async (request, reply) => {
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
  /**
   * Device-authorization flow (#2526, RFC 8628 shaped).
   *
   * An agent must never hold its user's password, and until now that was the
   * only way to get an owner token. These three routes let the agent ask the
   * human to approve a CLI session in a browser instead.
   *
   * The token this mints carries `purpose: 'owner_cli'`, which every
   * authenticated route refuses by default (#1640). A route accepts it only by
   * opting in — see `middleware/owner-cli.ts` and the census test that proves
   * the opt-in has not become an opt-out.
   */

  // POST /auth/device/start — unauthenticated: this is where a CLI begins.
  app.post<{ Body: { client_label?: string } }>(
    '/device/start',
    { config: { ...authRateLimit(trustProxyHops, 'device_start') } },
    async (request, reply) => {
      // Opportunistic, not a cron: these rows are spent credentials rather
      // than history, and the cheapest moment to drop them is when a new one
      // is created.
      void purgeExpired().catch(() => undefined)

      const userCode = generateUserCode()
      const deviceCode = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS)

      // The label is free text from an unauthenticated caller and is SHOWN to
      // a human on the approval screen, so it is bounded and stripped of
      // control characters here. The screen still renders it as text, never
      // as markup — two independent reasons it cannot become a lure.
      const rawLabel = typeof request.body?.client_label === 'string' ? request.body.client_label : ''
      const clientLabel = rawLabel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || null

      await createDeviceAuthorization({ userCode, deviceCode, clientLabel, expiresAt })

      return reply.code(201).send({
        device_code: deviceCode,
        user_code: userCode,
        verification_url: `${config.frontendUrl.replace(/\/+$/, '')}/device?code=${encodeURIComponent(userCode)}`,
        expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
        interval: 5,
      })
    },
  )

  // POST /auth/device/approve — dashboard session only. An owner_cli token
  // must NOT reach this: a CLI session approving further CLI sessions would
  // turn one approval into an unbounded grant. It is absent from the
  // allow-list, so the default refusal covers it.
  app.post<{ Body: { user_code?: string; deny?: boolean } }>(
    '/device/approve',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const userCode = typeof request.body?.user_code === 'string' ? request.body.user_code : ''
      if (!userCode.trim()) {
        return reply.code(400).send({ error: 'user_code is required' })
      }

      const row = request.body?.deny === true
        ? await denyDeviceAuthorization(userCode)
        : await approveDeviceAuthorization(userCode, sub)

      if (!row) {
        // 404 for a wrong, expired or already-decided code alike — telling the
        // caller WHICH would make codes enumerable, and this endpoint is
        // reachable by any signed-in user.
        return reply.code(404).send({ error: 'No pending approval for that code' })
      }
      return { status: row.status, client_label: row.client_label }
    },
  )

  // POST /auth/device/token — the CLI's poll. Unauthenticated by design: the
  // device code IS the credential.
  app.post<{ Body: { device_code?: string } }>(
    '/device/token',
    { config: { ...authRateLimit(trustProxyHops, 'device_token') } },
    async (request, reply) => {
      const deviceCode = typeof request.body?.device_code === 'string' ? request.body.device_code : ''
      if (!deviceCode) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      const row = await findByDeviceCode(deviceCode)
      // An unknown code and an expired one answer the same way: a poll loop
      // does not need to tell them apart, and a difference here would let one
      // be used to probe for the other.
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'expired_token' })
      }
      if (row.status === 'denied') {
        return reply.code(400).send({ error: 'access_denied' })
      }
      if (row.status === 'pending') {
        return reply.code(400).send({ error: 'authorization_pending' })
      }

      // `redeemed` and a lost race both land here: the claim below is the only
      // place that decides, and it decides exactly once.
      const claimed = await redeemDeviceAuthorization(deviceCode)
      if (!claimed || !claimed.user_id) {
        return reply.code(400).send({ error: 'expired_token' })
      }

      const user = await findUserProfileById(claimed.user_id)
      if (!user) {
        return reply.code(400).send({ error: 'expired_token' })
      }

      const token = app.jwt.sign(
        // The JWT payload type is fixed at `{ sub, email }`; the purpose is
        // carried at runtime, the same cast the Fortnox OAuth state uses.
        { sub: user.id, email: user.email, purpose: OWNER_CLI_PURPOSE } as unknown as {
          sub: string
          email: string
        },
        { expiresIn: '7d' },
      )
      return { token, user: { id: user.id, name: user.name, email: user.email } }
    },
  )

}
