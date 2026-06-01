// Centralised environment access. Fail fast at boot if a required var is missing.

// Must run before any process.env read below — loads the root .env.
import "./load-env.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Pick the database. Under `bun test` (which sets NODE_ENV=test) we use a
 * dedicated TEST_DATABASE_URL and refuse to fall back to DATABASE_URL — the
 * test suites truncate tables, so this hard stop is what keeps a stray test
 * run from wiping the dev database. Run `bun run test:db:setup` once to create
 * and migrate the test database.
 */
function resolveDatabaseUrl(): string {
  if (process.env.NODE_ENV === "test") {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) {
      throw new Error(
        "NODE_ENV=test but TEST_DATABASE_URL is not set. Refusing to run the " +
          "(table-truncating) tests against DATABASE_URL. Add TEST_DATABASE_URL " +
          "to .env, then run `bun run test:db:setup`.",
      );
    }
    if (testUrl === process.env.DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL must point at a different database than DATABASE_URL.");
    }
    return testUrl;
  }
  return required("DATABASE_URL");
}

export const env = {
  databaseUrl: resolveDatabaseUrl(),
  jwtSigningKey: required("JWT_SIGNING_KEY"),
  twoFactorEncKey: required("TWO_FACTOR_ENC_KEY"),
  port: Number(process.env.PORT ?? 3000),
  isDev: process.env.NODE_ENV !== "production",
};
