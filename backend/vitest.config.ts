import { readFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";
import { defineConfig } from "vitest/config";

function readEnv(file: string): Record<string, string> {
  return existsSync(file) ? parse(readFileSync(file)) : {};
}

const testEnv = readEnv(".env.test");
const devEnv = readEnv(".env");

// Use the dev database credentials, but always against a separate *_test database.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? devEnv.DATABASE_URL?.replace(/\/([^/?]+)(\?|$)/, "/social_test$2");

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.endsWith("_test")) {
  throw new Error("Tests need a database whose name ends in _test (set DATABASE_URL in .env or TEST_DATABASE_URL)");
}

// Read by tests/globalSetup.ts, which runs in this process rather than in a test worker.
process.env.TEST_DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    env: { ...testEnv, DATABASE_URL: testDatabaseUrl },
    globalSetup: ["./tests/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
