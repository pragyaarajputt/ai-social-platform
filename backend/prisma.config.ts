import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations need a direct connection. Hosted Postgres with a connection pooler (e.g. Neon on
    // Vercel) provides one as DATABASE_URL_UNPOOLED; the app itself uses the pooled DATABASE_URL.
    url: process.env.DATABASE_URL_UNPOOLED || env("DATABASE_URL"),
  },
});
