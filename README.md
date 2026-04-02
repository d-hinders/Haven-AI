# Haven

Agent-first wallet infrastructure for the autonomous economy. Haven gives AI agents the ability to hold, send, and receive money within strict, user-defined guardrails — without requiring agents to manage private keys.

## What's in the repo

This is a TypeScript monorepo with two packages:

- **`packages/backend`** — Fastify API server (auth, user management, Safe integration)
- **`packages/frontend`** — Next.js app (landing page, auth UI, wallet connection, Safe deployment, dashboard)

## Prerequisites

You need these installed on your machine:

- **Node.js** (v18 or later) — [nodejs.org](https://nodejs.org)
- **Docker Desktop** — [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
- **A browser wallet** (MetaMask, Rabby, etc.) with Gnosis Chain added

## Getting started

### 1. Clone the repo

```bash
git clone https://github.com/d-hinders/Haven.git
cd Haven
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

The defaults work for local development. Optionally, update:

| Variable | What it does | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://haven:haven@localhost:5432/haven` |
| `JWT_SECRET` | Secret for signing auth tokens | `change_me_in_production` |
| `RPC_URL` | Gnosis Chain RPC endpoint | `https://rpc.gnosischain.com` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID (optional — MetaMask works without it) | — |

### 4. Start PostgreSQL

Make sure Docker Desktop is running, then:

```bash
npm run docker:up
```

This starts a PostgreSQL container on port 5432. The database and tables are created automatically when the backend starts.

### 5. Start the dev servers

```bash
npm run dev
```

This starts both services:

- **Frontend** → [http://localhost:3000](http://localhost:3000)
- **Backend** → [http://localhost:3001](http://localhost:3001)

### 6. Try it out

1. Go to [http://localhost:3000](http://localhost:3000)
2. Click **Get Early Access** → create an account
3. Log in
4. Connect your browser wallet (switch to **Gnosis Chain** if prompted)
5. Deploy a Safe — confirm the transaction in your wallet
6. You'll land on the dashboard with your Safe address

> **Note:** Deploying a Safe requires a small amount of xDAI on Gnosis Chain for gas. You can bridge DAI from Ethereum or get xDAI from a faucet.

## Available scripts

Run these from the project root:

| Command | What it does |
|---|---|
| `npm run dev` | Start backend + frontend in dev mode |
| `npm run build` | Build both packages |
| `npm run docker:up` | Start PostgreSQL container |
| `npm run docker:down` | Stop PostgreSQL container |
| `npm run docker:logs` | Tail PostgreSQL logs |

## Project structure

```
Haven/
├── package.json              # Root monorepo config
├── docker-compose.yml        # PostgreSQL for local dev
├── .env.example              # Environment variable template
├── tsconfig.base.json        # Shared TypeScript config
└── packages/
    ├── backend/
    │   └── src/
    │       ├── index.ts          # Fastify server entry
    │       ├── db.ts             # PostgreSQL connection pool
    │       ├── db/migrate.ts     # Auto-migration on startup
    │       ├── middleware/auth.ts # JWT auth middleware
    │       └── routes/
    │           ├── auth.ts       # POST /auth/signup, /auth/login, GET /auth/me
    │           └── user.ts       # PUT /user/wallet, /user/safe
    └── frontend/
        └── src/
            ├── app/
            │   ├── page.tsx              # Landing page
            │   ├── signup/page.tsx       # Sign up
            │   ├── login/page.tsx        # Log in
            │   ├── onboarding/           # Wallet connect + Safe deploy
            │   └── dashboard/            # Post-deploy dashboard
            ├── context/AuthContext.tsx    # Auth state management
            └── lib/
                ├── api.ts        # API client with JWT
                ├── wagmi.ts      # Wagmi + Gnosis Chain config
                └── safe.ts       # Safe deployment via protocol-kit
```

## Tech stack

- **TypeScript** throughout
- **Fastify** (backend API)
- **Next.js 15** (frontend)
- **PostgreSQL** (data)
- **Safe SDK** (smart account deployment)
- **wagmi + viem + RainbowKit** (wallet connection)
- **Tailwind CSS** (styling)
- **Gnosis Chain** (target network)
