export {
  MAX_LEGAL_NAME_LENGTH,
  MAX_ORG_NUMBER_LENGTH,
  STALE_PENDING_MINUTES,
  nextViesStatus,
  readCompanyDetails,
  recheckIfStalePending,
  removeCompanyDetails,
  runViesCheck,
  shouldTriggerViesCheck,
  triggerManualRecheck,
  validateCompanyDetailsInput,
  writeCompanyDetails,
  type CompanyDetailsInput,
  type CompanyDetailsValidationError,
  type NormalizedCompanyDetails,
  type WriteCompanyDetailsResult,
} from './service.js'
export { VIES_CHECK_URL, VIES_REQUEST_TIMEOUT_MS, checkVatWithVies, type ViesCheckResult, type ViesCheckStatus } from './vies-client.js'
export type { OwnerCompanyDetailsRow, ViesStatus } from '../../infra/repositories/owner-company-details.js'
