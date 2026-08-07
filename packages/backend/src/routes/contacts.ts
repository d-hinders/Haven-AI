import { FastifyInstance } from 'fastify'
import {
  deleteContactForUser,
  insertContact,
  listContactsForUser,
  renameContactForUser,
} from '../infra/repositories/contacts.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'

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
    return { contacts: await listContactsForUser(sub) }
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
      const row = await insertContact(sub, name.trim(), address)
      return reply.code(201).send(row)
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

    const row = await renameContactForUser(id, sub, name.trim())

    if (row === null) {
      return reply.code(404).send({ error: 'Contact not found' })
    }

    return row
  })

  // DELETE /contacts/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const deleted = await deleteContactForUser(id, sub)

    if (!deleted) {
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
