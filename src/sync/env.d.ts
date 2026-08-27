/**
 * `wrangler types` derives Env from the bindings and vars in wrangler.jsonc. A
 * secret created with `wrangler secret put` is not in that file, so it is
 * invisible to the generator and has to be declared here.
 *
 * Keep the name in sync with the secret:
 *   npx wrangler secret put SYNC_TRIGGER_TOKEN     # production
 *   echo 'SYNC_TRIGGER_TOKEN="dev-token"' >> .dev.vars   # local, gitignored
 *
 * Optional on purpose: an unset token makes the /__sync/* guard fail closed
 * rather than silently opening the routes.
 */
interface Env {
  SYNC_TRIGGER_TOKEN?: string;
}
