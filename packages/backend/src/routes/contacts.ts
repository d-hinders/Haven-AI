import { FastifyInstance } from 'fastify'
import {
  deleteContactForUser,
  insertContact,
  listContactsForUser,
  renameContactForUser,
} from '../infra/repositories/contacts.js'
import { authMiddleware } from '../middleware/auth.js'

interface CreateContactBody {
  name: string
  address: string
}

interface UpdateContactBody {
  name: string
}

/**
 * The request-validation PROOF MODULE (#3029, epic #3028 slice 1): the first
 * module enforced against the spec. Its request schemas — name `minLength: 1`,
 * the `address` pattern, the `id` uuid — arrive through the plugin registered
 * by the tests (`installRequestValidation(app, { mode, enforcedModules:
 * ['routes/contacts.ts'] })`), the same wiring `index.ts` uses; the shape refusals are
 * asserted per handler with `expectRejectsOffSpec`. The `typeof` ladders are
 * gone as of this slice; what remains is the semantic guard the spec does not
 * express in schema.
 */
export default async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /contacts
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    return { contacts: await listContactsForUser(sub) }
  })

  // POST /contacts
  // The request schema (spec: name minLength 1, the 40-hex address pattern) is
  // enforced through the request-validation plugin (#3029) — a shape-refused
  // body never reaches this handler. The pre-plugin `isAddress` guard is GONE
  // as of this slice: it was the same `^0x[0-9a-fA-F]{40}$` format check the
  // spec's `address` schema carries (core's own header says "a *format* check
  // only"), so the plugin refuses exactly what it refused and the duplicate
  // ladder would be dead weight. What remains is the one thing the spec does
  // NOT express in schema: a name blank after trimming ("blank after trimming
  // is a 400", spec.ts).
  app.post<{ Body: CreateContactBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, address } = request.body

    if (!name || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
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
  // The request schema (spec: name minLength 1, id uuid) is enforced through
  // the request-validation plugin (#3029); the trimmed-blank guard stays for
  // the same reason as POST above.
  app.put<{ Params: { id: string }; Body: UpdateContactBody }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const { name } = request.body

    if (!name || name.trim().length === 0) {
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
