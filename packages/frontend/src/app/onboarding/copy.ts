/**
 * Shared onboarding copy (#1162).
 *
 * Onboarding is passkey-only — there is no wallet fallback to point at — so the
 * unsupported-browser message has to be an honest dead end with a concrete way
 * forward, not advice toward a destination that no longer exists. Shared by
 * both enroll flows so the two can't drift.
 */

export const PASSKEY_REQUIRED_MESSAGE =
  "This browser can't create a passkey, and Haven needs one. Open Haven in Safari, Chrome, or Edge on a device with Face ID, Touch ID, Windows Hello, or a device PIN."
