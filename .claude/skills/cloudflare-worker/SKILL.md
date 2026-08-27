---
name: cloudflare-worker
description: Develop, run, verify, and deploy the cf-web Cloudflare Worker — an Agents SDK agent on a SQLite Durable Object with Workers Observability tracing and a Tail Worker. Use this skill for any work touching wrangler.jsonc, wrangler.tail.jsonc, src/server.ts, src/tail.ts, Durable Object bindings or migrations, the Agents SDK, Workers AI, spans/tracing/observability, or diagnostics channel events — and also for plainer-sounding asks in this repo like "run it", "add an endpoint", "add a tool to the agent", "why is typecheck broken", "why are there no spans", or "ship it". The setup, tracing, and deploy rules here are non-obvious and fail silently when guessed at.
---

# cf-web Cloudflare Worker

Two Workers in one repo, deployed separately:

| Worker | Config | Entry | Role |
| --- | --- | --- | --- |
| `cf-web` | `wrangler.jsonc` | `src/server.ts` | `TracedAgent` — an Agents SDK agent on a SQLite Durable Object |
| `cf-web-tail` | `wrangler.tail.jsonc` | `src/tail.ts` | Tail consumer that logs the SDK's diagnostics channel events |

`routeAgentRequest` maps a class name to a kebab-case route, so `TracedAgent` is reachable at
`/agents/traced-agent/{instance}`. Each `{instance}` is its own Durable Object with its own
persisted state.

## Start every session here

```bash
npm install
npm run cf-typegen      # writes worker-configuration.d.ts
```

`worker-configuration.d.ts` is generated from `wrangler.jsonc` and is gitignored, so a fresh
checkout has no `Env`, `ExportedHandler`, or `TraceItem` types. Skip this and `tsc` reports
~8 errors that read like the source is broken (`Cannot find name 'Env'`,
`Property 'env' does not exist on type 'TracedAgent'`) when nothing is wrong. Rerun
`cf-typegen` after **any** change to bindings in `wrangler.jsonc` — the `Env` interface is
derived from them, so a new binding is invisible to the typechecker until you do.

## Verifying a change

```bash
npm run typecheck
```

That is the entire automated gate — there is no test suite and no linter/formatter config.
Because `tsc` is all that stands between a change and production, treat a clean typecheck as
necessary, not sufficient: exercise the affected route locally (below) before calling a
change done. If a change deserves real tests, `vitest` with `@cloudflare/vitest-pool-workers`
is the standard pairing for Workers, but adding it is a change to the repo's shape — propose
it rather than doing it silently.

Match the surrounding style: double quotes, semicolons, 2-space indent, comments that explain
*why* a flag exists rather than restating the API.

## Running locally

```bash
npm run dev     # wrangler dev on :8787
```

**`npm run dev` needs Cloudflare credentials.** The `ai` binding has no local implementation —
wrangler opens a remote proxy session to the real Workers AI service — so in a non-interactive
shell it exits with:

> Failed to start the remote proxy session … it's necessary to set a `CLOUDFLARE_API_TOKEN`
> environment variable

Fix it by exporting `CLOUDFLARE_API_TOKEN` (and usually `CLOUDFLARE_ACCOUNT_ID`) in the shell,
or `npx wrangler login` when a browser is available. Note `.dev.vars` will not help here: it
supplies secrets to the *Worker's* `env`, not to wrangler's own authentication.

When you have no credentials and the change does not touch inference, run against a copy of the
config with the `ai` binding and `tail_consumers` removed — everything else (Durable Object
state, routing, span capture) works fully offline:

```bash
# strip "ai" and "tail_consumers", set "main" to an absolute path, save as wrangler.local.json
npx wrangler dev -c /path/to/wrangler.local.json --port 8788
```

Exercise the routes:

```bash
curl localhost:8787/agents/traced-agent/test-1                      # {"agent":"test-1","state":{"count":0}}
curl -X POST localhost:8787/agents/traced-agent/test-1/increment    # {"count":1}
curl -X POST localhost:8787/agents/traced-agent/test-1/ask \
  -H 'content-type: application/json' -d '{"prompt":"hello"}'       # needs the AI binding
```

## Inspecting spans without leaving the terminal

`wrangler dev` captures spans into a local store you can query with read-only SQL. This is the
fastest way to confirm instrumentation actually fired, and it beats guessing from log output:

```bash
curl -X POST localhost:8787/cdn-cgi/local/explorer/api/local/observability/query \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT name, parent_id FROM spans"}'
```

Read span attributes with `json(attributes)`; the `logs` table is available too. A healthy turn
shows `agent_initialization`, then `invoke_agent TracedAgent` with `chat {model}` and
`execute_tool {tool}` beneath it.

## Tracing rules that fail silently

Nothing here throws when you get it wrong — you just end up with missing spans, or with prompt
data in observability that should not be there. Both are easy to ship and hard to notice.

1. **Use the wrapped AI SDK functions.** `src/server.ts` calls `wrapAISDK(ai, …)` once at
   module scope and destructures `generateText`/`streamText` from it. Importing those names
   from `"ai"` directly still compiles and still works — it just produces no `chat` or
   `execute_tool` spans. Any new inference call must come from the wrapped object.
2. **Tracing is gated on config.** The SDK's spans are Workers-native custom spans and are
   no-ops until `observability.traces.enabled` is true in `wrangler.jsonc`. "No spans" is far
   more often this flag than a code bug.
3. **Durable identity is automatic.** `gen_ai.agent.name`, `gen_ai.agent.id` and
   `gen_ai.conversation.id` are attached on every inference from the class name, the DO
   instance name, and the DO ID. Don't set them by hand.
4. **`storeMessages` and `storeTools` write real payloads.** They are `true` in this scaffold
   so traces are legible immediately, which means prompts, model output, tool arguments and
   tool results land in Workers Observability. Both default to `false` in the SDK. Before this
   agent handles anything sensitive, ask the user whether to turn them off. (Schemas, request
   headers, provider options and raw error messages are never recorded either way.)
5. **`includeRuntimeContext` takes scalars only** — objects and arrays are dropped silently.
   Keys surface as `cloudflare.agents.runtime_context.{key}`.
6. **`head_sampling_rate` is `1`** — every trace. Lower it as traffic grows, and add configured
   OTLP destination names to `observability.traces.destinations` to fan out externally.

## Adding an agent or a Durable Object class

1. Export a class extending `Agent<Env, State>` from `src/server.ts`.
2. Add it to `durable_objects.bindings` in `wrangler.jsonc`.
3. Add a **new** migration tag — never edit one that has already been deployed, since
   Cloudflare tracks applied tags and a rewritten one desynchronizes the account's state:

   ```jsonc
   "migrations": [
     { "tag": "v1", "new_sqlite_classes": ["TracedAgent"] },
     { "tag": "v2", "new_sqlite_classes": ["MyAgent"] }
   ]
   ```

   Agents require SQLite-backed Durable Objects: `new_sqlite_classes`, not `new_classes`.
4. Rerun `npm run cf-typegen`.
5. The new route is the kebab-case class name: `MyAgent` → `/agents/my-agent/{instance}`.

Inside an agent, `@callable()` exposes a method to RPC/WebSocket clients; `onRequest` is the
plain-HTTP entry point and is what the curl examples above hit. Both run inside the agent's
traced context, so anything reachable either way is instrumented without extra wiring.

## Diagnostics channel events and the Tail Worker

The SDK publishes structured events to `node:diagnostics_channel` — hence the required
`nodejs_compat` compatibility flag. They are silent by default (zero overhead with no
listener) and are forwarded to Tail Workers automatically in production; **no `subscribe()`
call belongs in the agent**.

Raw channel names on the wire are snake_case — `agents:rpc`, `agents:state`,
`agents:schedule`, `agents:lifecycle`, `agents:workflow`, `agents:mcp`, `agents:email`,
`agents:agent_tool`. Only the typed `subscribe()` helper uses camelCase keys
(`subscribe("agentTool", …)`). Filtering on the camelCase form against `msg.channel` matches
nothing.

To watch the deployed tail output: `npx wrangler tail cf-web-tail`.

## Deploying

Deploy order is load-bearing — `wrangler.jsonc` lists `cf-web-tail` in `tail_consumers`, and
deploying the main Worker fails if that service does not exist yet:

```bash
npm run deploy:tail     # cf-web-tail, from wrangler.tail.jsonc
npm run deploy          # cf-web
```

Deploying pushes code to a live account, so do it only when the user explicitly asks for a
deploy — a request to "finish", "commit", or "make it work" is not one. Production secrets go
through `npx wrangler secret put NAME`; `.dev.vars` is local-only and gitignored.

## Never commit

`node_modules/`, `.wrangler/`, `.dev.vars`, `dist/`, `worker-configuration.d.ts`, `*.log` —
all gitignored. `worker-configuration.d.ts` in particular is a generated artifact that goes
stale against `wrangler.jsonc`; committing it produces confusing type errors for the next
person rather than saving them a step.
