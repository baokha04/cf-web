import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd, so the D1 statement builders are exercised against
 * a real SQLite rather than a mock. That is the point: batch atomicity and the
 * last-writer-wins ON CONFLICT clause are properties of the database, not of
 * the strings this code assembles.
 *
 * The schema comes from the same migrations/d1 files wrangler applies, so a
 * migration and its test cannot drift apart. They are handed to the test as a
 * plain binding because they are JSON-serialisable and that avoids threading
 * anything through global setup.
 *
 * Note wrangler.jsonc is deliberately NOT loaded here: its `ai` binding has no
 * local implementation and would force a remote proxy session, and no test
 * needs inference.
 */
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["REPLICA"],
        bindings: { MIGRATIONS: await readD1Migrations("./migrations/d1") }
      }
    })
  ]
}));
