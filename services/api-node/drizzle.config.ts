import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db",
  dbCredentials: {
    url: process.env.DRIZZLE_DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
});
