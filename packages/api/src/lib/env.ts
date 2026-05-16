// Centralised environment access. Fail fast at boot if a required var is missing.

// Must run before any process.env read below — loads the root .env.
import "./load-env.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  jwtSigningKey: required("JWT_SIGNING_KEY"),
  port: Number(process.env.PORT ?? 3000),
  isDev: process.env.NODE_ENV !== "production",
};
