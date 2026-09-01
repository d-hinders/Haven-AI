/**
 * Shared onboarding copy (#1162).
 *
 * Onboarding is passkey-only — there is no wallet fallback to point at — so the
 * unsupported-browser message has to be an honest dead end with a concrete way
 * forward, not advice toward a destination that no longer exists.
 *
 * It lived here to keep two enroll flows from drifting; since #2261 deleted the
 * unreachable `PasskeyEnrollFlow`, `HybridEnrollFlow` is the only consumer. The
 * module stays because this is the one string onboarding shows when the browser
 * cannot do WebAuthn at all, and it is worth reviewing on its own terms rather
 * than buried mid-component.
 */

export const PASSKEY_REQUIRED_MESSAGE =
  "This browser can't create a passkey, and Haven needs one. Open Haven in Safari, Chrome, or Edge on a device with Face ID, Touch ID, Windows Hello, or a device PIN."
