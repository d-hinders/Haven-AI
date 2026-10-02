/**
 * The root route (#3515/#3516). Everything above this point — the
 * config-error screen, the fragment consumption, the sign-in gate, the
 * shell — renders from `OpsApp` via the root layout; the console redirects
 * `/` to `/overview` from `OpsApp`. This file exists so the app router has a
 * root page and so a deep link lands on the console, not a 404.
 */
export default function HomePage() {
  return null
}
