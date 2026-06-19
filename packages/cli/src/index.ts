// Programmatic surface (also what tests import).
export { run, type RunDeps } from './commands.js'
export { parseArgs, helpText, type ParsedArgs } from './args.js'
export { createCliApi, CliApiError, type CliApi } from './api.js'
export {
  createSessionStore,
  sessionPath,
  type Session,
  type SessionStore,
} from './session.js'
