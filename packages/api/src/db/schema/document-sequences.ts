import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { timestamps } from "./_helpers.ts";

export const documentSequences = mysqlTable("document_sequences", {
  prefix: varchar({ length: 100 }).primaryKey(),
  lastNumber: int().notNull().default(0),
  ...timestamps,
});
