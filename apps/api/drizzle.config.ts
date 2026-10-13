import { defineConfig } from "drizzle-kit";
import { configSchema } from "./src/config/config";

// Same validation as the app: DATABASE_URL is required and port 5432 is refused.
// Only the URL is parsed, so an unrelated bad env var cannot break a migration.
// Errors name the rule, never the value.
const parsed = configSchema.shape.DATABASE_URL.safeParse(process.env.DATABASE_URL);
if (!parsed.success) {
  throw new Error(`Invalid DATABASE_URL: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/platform/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: parsed.data },
});
