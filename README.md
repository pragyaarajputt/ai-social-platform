# AI-First Social Platform

A social media platform where AI is built into content creation and engagement: captions, hashtags, post writing, content improvement, comment suggestions, bios and feed summaries.

**Status:** Phase 1. Database and schema for identity and the social graph. No features yet.

## Tech stack

- **Frontend:** Next.js 16 (App Router, TypeScript, Tailwind CSS, ESLint)
- **Backend:** Node.js + Express 5 (TypeScript)
- **Database:** PostgreSQL 18 + Prisma ORM 7 (pg driver adapter)
- **Auth (planned):** JWT access tokens + rotating refresh tokens
- **Media (planned):** Cloudinary

## Structure

```
frontend/        Next.js app (src/app)
backend/
  prisma/
    schema.prisma  database schema
    migrations/    SQL migrations (committed)
  prisma.config.ts Prisma CLI config
  src/
    config/      environment, app config, Prisma client
    generated/   generated Prisma client (gitignored)
    controllers/ request handlers
    middleware/  express middleware
    routes/      route definitions
    services/    business logic
    utils/       helpers
    app.ts       express app setup
    server.ts    entry point
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
```

### Run

```bash
# Backend: http://localhost:4000
cd backend
cp .env.example .env        # then set DATABASE_URL with your password
npm install                 # also generates the Prisma client
npm run db:migrate          # apply migrations
npm run dev

# Frontend: http://localhost:3000
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Check the API is running: `curl http://localhost:4000/health`. Check the database connection: `curl http://localhost:4000/ready`.

### Scripts

| Folder | Command | What it does |
| --- | --- | --- |
| backend | `npm run dev` | Start with auto-reload (nodemon + tsx) |
| backend | `npm run build` | Compile TypeScript to `dist/` |
| backend | `npm start` | Run the compiled build |
| backend | `npm run typecheck` | Type-check without emitting |
| backend | `npm run db:migrate` | Create and apply migrations in development |
| backend | `npm run db:deploy` | Apply existing migrations (production/CI) |
| backend | `npm run db:status` | Show migration status |
| backend | `npm run db:generate` | Regenerate the Prisma client |
| backend | `npm run db:studio` | Open Prisma Studio |
| frontend | `npm run dev` | Start Next.js dev server |
| frontend | `npm run build` | Production build |
| frontend | `npm run lint` | Run ESLint |

TypeScript is pinned to 6.0.x because typescript-eslint does not yet support TypeScript 7.

## Docs

- [Product Requirements Document](docs/PRD.md)
