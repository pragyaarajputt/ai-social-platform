# AI-First Social Platform

A social media platform where AI is built into content creation and engagement: captions, hashtags, post writing, content improvement, comment suggestions, bios and feed summaries.

**Status:** Phase 0. Project scaffold only, no features yet.

## Tech stack

- **Frontend:** Next.js 16 (App Router, TypeScript, Tailwind CSS, ESLint)
- **Backend:** Node.js + Express 5 (TypeScript)
- **Database (planned):** PostgreSQL + Prisma ORM
- **Auth (planned):** JWT access tokens + rotating refresh tokens
- **Media (planned):** Cloudinary

## Structure

```
frontend/        Next.js app (src/app)
backend/
  src/
    config/      environment and app config
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

Requires Node.js 24+.

```bash
# Backend: http://localhost:4000
cd backend
cp .env.example .env
npm install
npm run dev

# Frontend: http://localhost:3000
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Check the API is running: `curl http://localhost:4000/health`

### Scripts

| Folder | Command | What it does |
| --- | --- | --- |
| backend | `npm run dev` | Start with auto-reload (nodemon + tsx) |
| backend | `npm run build` | Compile TypeScript to `dist/` |
| backend | `npm start` | Run the compiled build |
| backend | `npm run typecheck` | Type-check without emitting |
| frontend | `npm run dev` | Start Next.js dev server |
| frontend | `npm run build` | Production build |
| frontend | `npm run lint` | Run ESLint |

TypeScript is pinned to 6.0.x because typescript-eslint does not yet support TypeScript 7.

## Docs

- [Product Requirements Document](docs/PRD.md)
