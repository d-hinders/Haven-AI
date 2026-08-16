/**
 * The app-wide Fastify error handler, extracted from index.ts so it can be
 * tested without booting the app (#1464 — the previous inline handler had no
 * test, which is how a whole error class shipped as 500s).
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Postgres `invalid_text_representation` — the input could not be cast to the
 * column's type. In a request context this is CLIENT input by construction:
 * a malformed uuid path param hitting a UUID column (`/contacts/not-a-uuid`),
 * or a malformed value in a body field. Nothing server-side changed state.
 */
const PG_INVALID_TEXT_REPRESENTATION = '22P02'

/**
 * Map a raised error to the response the client sees.
 *
 * #1464: 22P02 becomes a 400, centrally, instead of the generic 500. The
 * choke point is deliberate — per-route schemas would cover only the routes
 * someone remembered to audit, while every uuid path param in the app (15
 * routes across 9 files at the time of writing, and every future one) flows
 * through THIS handler when Postgres rejects the cast.
 *
 * 400, not the issue's suggested 404, for a reason worth keeping: this
 * handler cannot know whether the malformed uuid came from a path param or a
 * request BODY, and a body field must be 400. One consistent answer for both
 * leaks nothing — the caller can see their own input is not a uuid — and the
 * not-found-or-not-owned 404 indistinguishability for WELL-FORMED ids is
 * untouched, because those never raise 22P02.
 */
export function httpErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if ((error as { code?: string }).code === PG_INVALID_TEXT_REPRESENTATION) {
    // Logged as a warn with the real error: if a 22P02 ever originates from
    // server-constructed values rather than client input, the log is where
    // that bug surfaces instead of being masked by the 400.
    request.log.warn({ err: error, reqId: request.id }, 'Invalid identifier in client input (22P02)')
    reply.status(400).send({
      error:
        'Invalid identifier format — an id in the request is not a valid value for its type ' +
        '(for example a path or body id that is not a UUID).',
      statusCode: 400,
    })
    return
  }

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
}
