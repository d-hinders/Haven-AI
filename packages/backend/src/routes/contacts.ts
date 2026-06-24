import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '../lib/address.js'

interface Contact {
  id: string
  user_id: string
  name: string
  address: string
  created_at: string
  updated_at: string
}

interface CreateContactBody {
  name: string
  address: string
}

interface UpdateContactBody {
  name: string
}

export default async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /contacts
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const result = await pool.query<Contact>(
      `SELECT id, name, address, created_at, updated_at
       FROM contacts WHERE user_id = $1 ORDER BY name ASC`,
      [sub],
    )
    return { contacts: result.rows }
  })

  // POST /contacts
  app.post<{ Body: CreateContactBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, address } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (!address || !isValidAddress(address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    try {
      const result = await pool.query<Contact>(
        `INSERT INTO contacts (user_id, name, address)
         VALUES ($1, $2, $3)
         RETURNING id, name, address, created_at, updated_at`,
        [sub, name.trim(), address],
      )
      return reply.code(201).send(result.rows[0])
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'A contact with this address already exists' })
      }
      throw err
    }
  })

  // PUT /contacts/:id
  app.put<{ Params: { id: string }; Body: UpdateContactBody }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const { name } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }

    const result = await pool.query<Contact>(
      `UPDATE contacts SET name = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, address, created_at, updated_at`,
      [id, sub, name.trim()],
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Contact not found' })
    }

    return result.rows[0]
  })

  // DELETE /contacts/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const result = await pool.query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, sub],
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Contact not found' })
    }

    return { success: true }
  })
}

/**
 * Postgres unique-violation (SQLSTATE 23505). The contacts table has a single
 * unique constraint — UNIQUE(user_id, address) — so the code alone unambiguously
 * means "duplicate address for this user". Matches the `err.code` pattern used
 * in routes/agents.ts; detecting by a message substring would mask any other
 * error whose text happens to contain "unique".
 */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === '23505')
}
