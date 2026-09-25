# AI Social: social media management with AI

Connect your social accounts (Instagram first; LinkedIn, Facebook, Threads, X, YouTube and TikTok planned), write a post once with AI help, and publish or schedule it to every platform from one dashboard.

**Status:** Phase 6. Connect Instagram, upload photos and videos, publish to one or more Instagram accounts (single image, carousel, Reel) **now or on a schedule**, and plan posts on a calendar. AI writing tools come next.

> `docs/PRD.md` describes the original social-network idea and is out of date. The product is now a social media management tool.

## Tech stack

- **Frontend:** Next.js 16 (App Router, TypeScript, Tailwind CSS, ESLint)
- **Backend:** Node.js + Express 5 (TypeScript)
- **Database:** PostgreSQL 18 + Prisma ORM 7 (pg driver adapter)
- **Auth:** argon2id passwords, JWT access tokens (jose), rotating refresh tokens in an httpOnly cookie
- **Integrations:** Instagram API with Instagram Login (Graph API v26.0), plain `fetch`, tokens encrypted with AES-256-GCM
- **Media:** Cloudinary (direct browser uploads; REST API with plain `fetch`)
- **Jobs:** a Postgres-backed queue (`post_targets` rows claimed with `FOR UPDATE SKIP LOCKED`), no Redis

## Structure

```
frontend/
  src/
    app/         pages: (auth)/ login, signup, forgot/reset password, verify email;
                 (protected)/ account, accounts, calendar, posts (list, new, [id], [id]/edit); auth/callback
    components/  ui/ primitives, auth/ forms and guards, accounts/, calendar/, posts/, workspace/
    lib/         API client, session, workspaces, posts + uploads, dates, Instagram rules, form schemas
backend/
  prisma/
    schema.prisma  database schema
    migrations/    SQL migrations (committed)
  prisma.config.ts Prisma CLI config
  src/
    config/      environment, app config, Prisma client
    generated/   generated Prisma client (gitignored)
    integrations/ one adapter per social platform (instagram/), shared interface in types.ts
    jobs/        publish queue: claim, publish, retry
    storage/     Cloudinary client
    controllers/ request handlers
    middleware/  express middleware (auth, validation, rate limits, errors)
    routes/      route definitions
    schemas/     zod request schemas
    services/    business logic
    types/       type augmentations
    utils/       helpers
    app.ts       express app setup
    server.ts    API entry point
    worker.ts    background jobs (publishing every 5 s, hourly token refresh), run separately
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

## Workspaces and connected accounts

Everything belongs to a **workspace**, not a user. Each sign-up gets a personal workspace with the user as `OWNER`. Roles are `OWNER`, `ADMIN`, `EDITOR` and `VIEWER`; connecting or disconnecting accounts needs `ADMIN` or above.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/workspaces` | bearer | My workspaces |
| `GET /api/v1/workspaces/:id/social-accounts` | bearer, VIEWER+ | Connected accounts (never includes tokens) and which platforms are configured |
| `POST /api/v1/workspaces/:id/social-accounts/instagram/connect` | bearer, ADMIN+ | Returns the Instagram consent URL |
| `DELETE /api/v1/workspaces/:id/social-accounts/:accountId` | bearer, ADMIN+ | Disconnect: deletes the token |
| `GET /api/v1/integrations/instagram/callback` | — | Instagram redirects here; we redirect to `/accounts?connected=…` or `?error=…` |
| `POST /api/v1/integrations/instagram/deauthorize` | Meta `signed_request` | User removed our app on Instagram |
| `POST /api/v1/integrations/instagram/data-deletion` | Meta `signed_request` | User asked Meta to delete their data |

**Tokens** are encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) and never sent to the browser. **The worker** (`npm run worker`) refreshes Instagram tokens every hour once they are 24 hours old and expire within 10 days; an account whose token can't be refreshed is marked `NEEDS_REAUTH` and shown as "Reconnect needed". Running several workers is safe: a Postgres advisory lock lets only one do each run.

### Setting up Instagram

1. **Instagram account:** it must be a professional account (Business or Creator). In the Instagram app: Settings → Account type and tools → Switch to professional account.
2. **Meta app:** at developers.facebook.com create an app (type Business), add the **Instagram** product, and choose **API setup with Instagram business login**. Copy the **Instagram app ID and secret**.
3. **Testers:** App roles → Roles → Instagram testers → add your account, then accept the invite in Instagram (Settings → Apps and websites → Tester invites). In development mode, only tester accounts can connect.
4. **Redirect URI:** add `https://<your-host>/api/v1/integrations/instagram/callback` under "Business login settings". Meta needs an HTTPS URL, so local development needs a tunnel with a fixed address.
5. **Deauthorize and data deletion:** set the callback URLs to `…/api/v1/integrations/instagram/deauthorize` and `…/data-deletion` (required for app review).
6. Put `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` and `INSTAGRAM_REDIRECT_URI` in `backend/.env` and restart the backend.

Serving accounts you don't own needs Meta **app review** (advanced access).

## Publishing

1. **Upload:** the browser asks the API for a signed upload (`POST /workspaces/:id/media/upload-signature`), sends the file **straight to Cloudinary**, then registers it (`POST /workspaces/:id/media`). The API reads size, dimensions and duration from Cloudinary, not from the browser.
2. **Create:** `POST /workspaces/:id/posts` with a caption, media IDs and accounts. It is validated against each platform's rules (Instagram: 2,200 characters, 30 hashtags, 20 mentions, aspect ratio 4:5 to 1.91:1, MP4/MOV video of 3 s to 15 min, up to 10 carousel items). The post and one **target** per account are saved and queued in one transaction.
3. **Publish:** `npm run worker` claims due targets every 5 s. For Instagram: create media container(s) → wait while Instagram processes video (checked every 30 s, for up to 30 min) → publish → fetch the link. Images are sent as JPEG; Cloudinary converts them.
4. **Status:** `GET /workspaces/:id/posts/:postId` shows each account's status. The post page refreshes itself until everything is done.

**No double posts:** container IDs and the published media ID are saved the moment Instagram returns them. A retry reuses the saved container (Instagram publishes a container only once). If the worker died right after publishing, the post is found among the account's recent media instead of being published again.

**Retries:** temporary errors (rate limits, Instagram unavailable) are retried after 30 s, 2 min, 8 min and 30 min, then marked failed. A rejected token marks the account "Reconnect needed". Media Instagram can't process fails at once with its reason. Failed accounts can be retried from the post page (`POST …/posts/:postId/targets/:targetId/retry`).

Needs `CLOUDINARY_*` in `backend/.env`, a connected Instagram account, and the worker running. Videos are sent as uploaded, so only MP4 and MOV are accepted for now.

## Scheduling

Pass `scheduledAt` (ISO 8601 with offset) when creating a post, or pick **Schedule** in the composer. Times are chosen and shown in the browser's own time zone and stored in UTC.

| Rule | Detail |
| --- | --- |
| Window | At least 2 minutes and at most 365 days ahead |
| Editing | `PATCH /workspaces/:id/posts/:postId` (caption, media, accounts, time; `scheduledAt: null` publishes now) and `POST …/cancel` work only until publishing starts; after that they return **409**. Edits lock the post's rows (`FOR UPDATE`), and the worker claims with `SKIP LOCKED`, so an edit and a publish never interleave |
| Deleting | `DELETE …/posts/:postId` for posts never published anywhere (scheduled, cancelled or failed) |
| Late posts | If the worker was down at the scheduled time, the post is published when it's back if less than 24 hours late; otherwise it's marked **missed** and not published. Retrying a missed post publishes it now |
| Retries | Never change the chosen time (`scheduledAt`); only `nextAttemptAt` moves |
| Warnings | Hourly, the worker looks for scheduled posts due in the next 24 hours whose account needs reconnecting or whose access expires first, and emails the author **once**. The dashboard (`GET …/posts/at-risk`), calendar and post page show the same warning |

`GET /workspaces/:id/posts?from=&to=&status=` filters by date (a post's scheduled time, or creation time if published right away) and status. It feeds the calendar and the posts list tabs.

## Tests

```bash
cd backend && npm test    # API integration tests (auth, workspaces, Instagram connect, publishing, scheduling; fake Instagram and Cloudinary APIs)
cd frontend && npm test   # API client and session unit tests
```

Backend tests run against a separate `social_test` database, derived from `DATABASE_URL` in `.env` (or set `TEST_DATABASE_URL`). Migrations are applied automatically, and tables are emptied before each test.

### Scripts

| Folder | Command | What it does |
| --- | --- | --- |
| backend | `npm run dev` | Start with auto-reload (nodemon + tsx) |
| backend | `npm run build` | Compile TypeScript to `dist/` |
| backend | `npm start` | Run the compiled build |
| backend | `npm run worker` | Run background jobs: publishing (including scheduled posts), token refresh, scheduled-post warnings. **Posts only go out while this runs** |
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
