---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/Dockerfile
  - packages/mcp-server/Dockerfile
  - packages/demo-merchant-mcp/package.json
last-verified: "2026-10-06"
---

# Railway Services

The record of how Haven's Railway services are configured. **These settings
live in Railway, not in the repo.** No service uses config-as-code
(`railwayConfigFile` is unset on all eight), so this page is the only place
they are written down. When you change a setting in Railway, change this page
too.

Read the live values in each service's **Settings** in the dashboard, or with
the Railway CLI's token against the GraphQL API
(`serviceInstance(environmentId, serviceId) { startCommand sleepApplication … }`).

## Services

One Railway project, **Haven AI**, with two environments of the same shape:
`dev` deploys from the `dev` branch and `production` from `main`
([dev-environment.md](dev-environment.md)).

| Service | Build | Start command | Sleep (dev / prod) | Healthcheck |
|---|---|---|---|---|
| `@haven/backend` | `packages/backend/Dockerfile`; watch `/packages/backend/**`, `/packages/sdk/**` | `node packages/backend/dist/index.js` | off / off | none set (probe `GET /health`) |
| `Haven-AI-Hosted-MCP` | `packages/mcp-server/Dockerfile` | none: the Dockerfile `CMD` | **on** / off | `/healthz` |
| `Demo-merchant` | root `/`, build `npm ci && npm run build -w packages/demo-merchant-mcp` | `node packages/demo-merchant-mcp/dist/index.js` | **on** / **on** | none set (probe `GET /healthz`) |
| `Postgres` | image `ghcr.io/railwayapp-templates/postgres-ssl:18` | none | off / off | none |

Verified against both environments on 2026-10-06.

### Start commands run `node`, never `npm run start`

Until 2026-10-05 (dev) and 2026-10-06 (production), both start commands were
`npm run start --workspace=…`. That keeps an `npm` parent process resident
beside `node` for the life of the container, and puts `npm` between Railway's
`SIGTERM` and the app on shutdown. Dropping it cut about 25 MB of billed memory
from the dev backend, measured over the same 17 hours in which the unchanged
prod backend did not move.

The commands are relative to the repo root because both services run from it
(`WORKDIR /app` in the backend Dockerfile; root `/` for Demo-merchant). Neither
process depends on its working directory: configuration comes from Railway
service variables, and Demo-merchant reads no files from disk.

### Sleep

A sleeping service (Railway "serverless") stops after about 10 minutes without
outbound traffic and cold-starts on the next request. It is on for both
Demo-merchants and the dev hosted MCP. Dev Demo-merchant joined them on
2026-10-05; it is only exercised by QA.

## Reading cost

Railway bills Hobby usage per resource-minute, and **memory is nearly all of
it**: $8.20 of the $8.68 on the 2026-09 invoice. The cost of the project is
roughly how many MB the eight services keep resident, around the clock.

**Read memory from the billing meter, not the Metrics graph.** For a sleeping
service the graph holds the last reported value, so a service that slept most
of the day still draws a flat line at its awake size. The `usage` query
(grouped by `SERVICE_ID`, `ENVIRONMENT_ID`) is what Railway bills, and it does
fall while a service sleeps: dev Demo-merchant billed 41% less in the 17 hours
after sleep was switched on, while its graph rose.
