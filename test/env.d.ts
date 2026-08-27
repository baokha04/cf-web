/**
 * `env` from "cloudflare:test" is typed as Cloudflare.Env, which wrangler
 * generates from the bindings in wrangler.jsonc. The migrations binding exists
 * only under vitest (see vitest.config.ts), so it is declared here rather than
 * being invented in wrangler.jsonc for the benefit of tests.
 */
declare namespace Cloudflare {
  interface Env {
    /**
     * migrations/d1/*.sql, read in vitest.config.ts and passed through as JSON.
     * Optional because it genuinely is: Agent<Env, State> constrains Env to
     * Cloudflare.Env, so a required member here would make the production Env
     * fail that constraint. The test asserts it rather than assuming it.
     */
    MIGRATIONS?: import("@cloudflare/vitest-pool-workers").D1Migration[];
  }
}
