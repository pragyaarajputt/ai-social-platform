# AI-First Social Platform

A social media platform where AI is built into content creation and engagement: captions, hashtags, post writing, content improvement, comment suggestions, bios and feed summaries.

**Status:** Phase 3. Authentication end to end: backend API plus sign-up, login, email verification, password reset and account pages.

## Tech stack

- **Frontend:** Next.js 16 (App Router, TypeScript, Tailwind CSS, ESLint)
- **Backend:** Node.js + Express 5 (TypeScript)
- **Database:** PostgreSQL 18 + Prisma ORM 7 (pg driver adapter)
- **Auth:** argon2id passwords, JWT access tokens (jose), rotating refresh tokens in an httpOnly cookie
- **Media (planned):** Cloudinary

## Structure

```
frontend/
  src/
    app/         pages: (auth)/ login, signup, forgot/reset password, verify email;
                 (protected)/ account; auth/callback
    components/  ui/ primitives, auth/ forms and guards
    lib/         API client, session, form schemas
backend/
  prisma/
    schema.prisma  database schema
    migrations/    SQL migrations (committed)
  prisma.config.ts Prisma CLI config
  src/
    config/      environment, app config, Prisma client
    generated/   generated Prisma client (gitignored)
    controllers/ request handlers
    middleware/  express middleware (auth, validation, rate limits, errors)
    routes/      route definitions
    schemas/     zod request schemas
    services/    business logic
    types/       type augmentations
    utils/       helpers
    app.ts       express app setup
    server.ts    entry point
  tests/         API integration tests (vitest + supertest)
docs/
  PRD.md         product requirements
```

## Getting started

Requires Node.js 24+ and PostgreSQL 18.

### Database (one time)

Create an app user and database (as the `postgres` superuser):

```sql
CREATE ROLE social_app LOGIN PASSWORD 'your-password' CREATEDB;  -- CREATEDB is needed for Prisma's shadow database
CREATE DATABASE social_dev OWNER social_app;
CREATE DATABASE social_test OWNER social_app;                    -- used by npm test
```

### Run

```bash
# Backend: http://localhost:4000
cd backend
cp .env.example .env        # then set DATABASE_URL and JWT_ACCESS_SECRET
npm install                 # also generates the Prisma client
npm run db:migrate          # apply migrations
npm run dev

# Frontend: http://localhost:3000
cd frontend
cp .env.example .env.local  # API_URL: where Express runs
npm install
npm run dev
```

Open http://localhost:3000. The browser only ever talks to the frontend: `/api/v1/*` is forwarded to Express by a rewrite in `frontend/next.config.ts`, so the refresh cookie is first-party and no CORS is needed.

Check the API is running: `curl http://localhost:4000/health`. Check the database connection: `curl http://localhost:4000/ready`.

Without `SMTP_URL`, verification and password-reset emails are printed in the backend console.

## Auth API

All under `/api/v1/auth`. Responses that start a session return `{ user, accessToken, expiresIn }` and set a `refresh_token` cookie (httpOnly, 30 days, path `/api/v1/auth`). Send the access token as `Authorization: Bearer <token>`. It expires after 15 minutes; call `POST /refresh` for a new one.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /register` | — | `{ email, username, password, displayName }` |
| `POST /login` | — | `{ email, password }`. 5 failures per email + IP → 15 min lockout |
| `POST /refresh` | cookie | Rotates the refresh token. Reusing an old one revokes the whole session |
| `POST /logout` | cookie | Ends this session |
| `POST /logout-all` | bearer | Ends every session |
| `GET /me` | bearer | Current user |
| `POST /verify-email` | — | `{ token }` from the email link |
| `POST /resend-verification` | bearer | Max 3 per hour |
| `POST /forgot-password` | — | `{ email }`. Always returns 200 |
| `POST /reset-password` | — | `{ token, password }`. Signs out every session |
| `GET /google` | — | Starts Google sign-in (needs `GOOGLE_*` env vars, otherwise 501) |

Errors always look like `{ "error": { "code": "...", "message": "...", "details": ... } }`.

### How the frontend keeps you signed in

- The access token is kept in memory only (never in localStorage). On page load the app calls `POST /refresh`, and the httpOnly cookie restores the session.
- It refreshes 60 seconds before the token expires, and retries once if a request gets `TOKEN_EXPIRED`.
- Only one refresh runs at a time, across all tabs (Web Locks API). This matters because the server treats a refresh token used twice as stolen and ends the session.
- Pages under `app/(protected)` redirect to `/login?next=...` when signed out. The API is the real security boundary: every protected endpoint checks the token.

### Client IPs behind the rewrite

Requests reach Express from the Next.js server, so set `TRUST_PROXY` in `backend/.env` (`loopback` locally) or every user shares one IP for rate limiting. In production, run Next.js behind a load balancer that sets `X-Forwarded-For` itself and trust only that hop: Next.js passes through an `X-Forwarded-For` header sent by the client, so trusting it directly would let clients choose their own IP.

## Tests

```bash
cd backend && npm test    # API integration tests
cd frontend && npm test   # API client and session unit tests
```

Backend tests run against a separate `social_test` database, derived from `DATABASE_URL` in `.env` (or set `TEST_DATABASE_URL`). Migrations are applied automatically, and tables are emptied before each test.

### Scripts

| Folder | Command | What it does |
| --- | --- | --- |
| backend | `npm run dev` | Start with auto-reload (nodemon + tsx) |
| backend | `npm run build` | Compile TypeScript to `dist/` |
| backend | `npm start` | Run the compiled build |
| backend | `npm run typecheck` | Type-check without emitting |
| backend | `npm test` | Run API tests |
| backend | `npm run db:migrate` | Create and apply migrations in development |
| backend | `npm run db:deploy` | Apply existing migrations (production/CI) |
| backend | `npm run db:status` | Show migration status |
| backend | `npm run db:generate` | Regenerate the Prisma client |
| backend | `npm run db:studio` | Open Prisma Studio |
| frontend | `npm run dev` | Start Next.js dev server |
| frontend | `npm run build` | Production build |
| frontend | `npm run lint` | Run ESLint |
| frontend | `npm run typecheck` | Type-check without emitting |
| frontend | `npm test` | Run unit tests |

TypeScript is pinned to 6.0.x because typescript-eslint does not yet support TypeScript 7.

## Docs

- [Product Requirements Document](docs/PRD.md)
