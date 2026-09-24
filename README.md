# AI-First Social Platform

A social media platform where AI is built into content creation and engagement: captions, hashtags, post writing, content improvement, comment suggestions, bios and feed summaries.

**Status:** planning. No application code yet.

## Tech stack

- **Frontend:** Next.js 15 (App Router, TypeScript, Tailwind)
- **Backend:** Node.js + Express
- **Database:** PostgreSQL + Prisma ORM (pgvector for embeddings)
- **Auth:** JWT access tokens + rotating refresh tokens
- **Media:** Cloudinary
- **Infra (planned):** Redis, BullMQ workers, Socket.IO

## Planned structure

```
apps/
  web/        Next.js frontend
  api/        Express API (feature modules)
  worker/     Background jobs (AI, moderation, fan-out)
packages/
  db/         Prisma schema and client
  contracts/  Shared Zod schemas and types
  config/     Shared tsconfig, eslint, tailwind
docs/
  PRD.md      Product requirements
```

## Docs

- [Product Requirements Document](docs/PRD.md)
