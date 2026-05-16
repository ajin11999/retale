import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { env } from "./env.ts";
import * as schema from "../db/schema/index.ts";

// Single shared connection pool for the API process.
const pool = mysql.createPool(env.databaseUrl);

export const db = drizzle(pool, { schema, mode: "default", casing: "snake_case" });

export type Db = typeof db;
