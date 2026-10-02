# @haven/ops

The private operations console (#3515, epic #3507). A Next.js app — the same
Next major as `packages/frontend` — that signs founders in through GitHub and
reads through the backend's `/ops/*` surface (#3509). It defines no primitives
of its own; everything visual comes from `@haven_ai/ui` (#3508), and shared
primitives belong in `packages/ui`, not here.

## Environments

One env var holds every backend this console may talk to:

```
NEXT_PUBLIC_OPS_ENVIRONMENTS='{"dev":"https://api.dev.example","prod":"https://api.example"}'
```

Keys are environment labels; the key `prod` is production. Origins must be
`https`, except `localhost`, which may use http. An environment absent from
the registry is not offered. A registry that cannot offer any environment
shows a config error screen instead of a console.

The Vercel Preview scope never contains `prod` (`VERCEL_ENV=preview` strips
it server-side), so preview deployments cannot be promoted into production by
an env-var slip.

A full-width red banner shows on every page whenever `prod` is selected.

## Sign-in and token handling

The handoff contract is shared with the backend (#3509):

1. The app generates a nonce, stores `{nonce, backendOrigin}` in
   `sessionStorage`, and navigates to
   `<backendOrigin>/ops/auth/github/start?return_to=<ops origin>&nonce=<n>`.
2. On return, before the first render, the app scrubs the URL fragment with
   `history.replaceState`. The fragment is either
   `#token=<ops token>&nonce=<n>` or `#error=<code>&nonce=<n>`; the error
   codes (`not_allowed`, `two_factor_required`, `github_denied`,
   `github_unavailable`, `missing_code`) each render as a sign-in message. A
   token is accepted only when its nonce matches; it is filed under the
   BACKEND ORIGIN, never under an environment label.
3. The fetch wrapper (`src/lib/api.ts`) attaches only the token whose key
   equals the request's origin. A prod token can never reach the dev
   backend, and vice versa.

Tokens live in `sessionStorage` only: never a cookie, never `localStorage`.
Sign-out clears every environment's token, and a 401 returns the user to
sign-in.

## Running it

```
npm run dev -w packages/ops
```

With no local backend running, set the registry to a backend that is:

```
NEXT_PUBLIC_OPS_ENVIRONMENTS='{"dev":"http://localhost:3001"}' npm run dev -w packages/ops
```

The console works against a local backend (the backend's
`OPS_REDIRECT_ORIGINS` must include this console's origin, e.g.
`http://localhost:3000`) and against the dev backend; only origins in the
registry are offered in the switcher. `POST /ops/reveal` and every data read
are audited server-side; this app holds no credentials of its own.
