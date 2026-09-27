import { RELEASE_NOTES_PATH } from '@haven_ai/core'
import { config } from '../config.js'

/**
 * The public release notes page (#3304), absolute: it lives on the dashboard
 * origin, not the API's. The host comes from `config.frontendUrl`, never a
 * request header — the same rule as the hand-off links (`handoff-links.ts`).
 * Named by `GET /discovery` and by every `client_update` hint (#3303).
 */
export function releaseNotesUrl(frontendUrl: string = config.frontendUrl): string {
  return `${frontendUrl.replace(/\/+$/, '')}${RELEASE_NOTES_PATH}`
}
