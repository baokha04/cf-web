# cf-web

A Cloudflare Worker running an [Agents SDK](https://www.npmjs.com/package/agents) agent with
tracing enabled end-to-end.

## What tracing gives you

Two independent signals, both configured here:

**1. Native trace spans** (OpenTelemetry GenAI semantic conventions)

Turned on by `observability.traces.enabled` in `wrangler.jsonc`. Agents are traced out of
the box once that flag is set — the SDK's spans are Workers-native custom spans and are a
no-op until traces are on. Per turn you get:

| Span | What it covers |
| --- | --- |
| `agent_initialization` | Agent constructor setup — method wrapping, schema creation, MCP client init |
| `invoke_agent {AgentClass}` | The agent operation span |
| `chat {model}` | Model call, child of `invoke_agent` |
| `execute_tool {tool}` | Tool call, child of `invoke_agent` |

Durable identity is attached automatically on every inference:

```text
gen_ai.agent.name      = "TracedAgent"   (the class name)
gen_ai.agent.id        = this.name       (the Durable Object instance name)
gen_ai.conversation.id = this.ctx.id     (the opaque Durable Object ID)
```

**2. Structured agent events** (diagnostics channels)

The SDK publishes events for RPC calls, state changes, schedules, workflow transitions and
MCP connections to `node:diagnostics_channel`. They are silent by default — zero overhead
when nobody is listening. In production they are forwarded automatically to the Tail Worker
in `src/tail.ts`; no `subscribe()` call is needed inside the agent.

## Layout

| File | Purpose |
| --- | --- |
| `src/server.ts` | The agent, plus the `/__sync/*` routes and the `scheduled()` handler. |
| `src/tail.ts` | Tail Worker consuming `diagnosticsChannelEvents`. Deployed separately. |
| `src/sync/` | Postgres → D1 replication. See below. |
| `migrations/d1/` | D1 schema migrations. Not to be confused with the `migrations` key in `wrangler.jsonc`, which is a Durable Object *class* migration. |
| `sql/postgres/` | Source-side fixture, applied by hand. Wrangler does not own this tree. |
| `wrangler.jsonc` | Main Worker. Traces, logs, AI/DO/D1/Hyperdrive bindings, cron, tail consumer. |
| `wrangler.tail.jsonc` | Config for the Tail Worker. |

## Run it

```bash
npm install
npm run dev
```

```bash
curl localhost:8787/agents/traced-agent/test-1                     # {"agent":"test-1","state":{"count":0}}
curl -X POST localhost:8787/agents/traced-agent/test-1/increment   # {"count":1}
curl -X POST localhost:8787/agents/traced-agent/test-1/ask \
  -H 'content-type: application/json' -d '{"prompt":"hello"}'
```

`wrangler dev` captures spans locally. Query them without leaving the terminal:

```bash
curl -X POST localhost:8787/cdn-cgi/local/explorer/api/local/observability/query \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT name, json(attributes) FROM spans WHERE name = '\''agent_initialization'\''"}'
```

## Postgres → D1 replication

Postgres is the system of record; D1 is a read-optimized replica the Worker reads at the
edge. A cron tick pulls rows changed since a per-table watermark and upserts them, resuming
from a cursor held in `_sync_state` inside D1 itself. Registering a table is a `TableSpec`
in `src/sync/registry.ts` plus a D1 migration — no new code.

**It ships disabled.** The `d1_databases` and `hyperdrive` ids in `wrangler.jsonc` are
placeholders, and `SYNC_ENABLED` is `"false"`. To turn it on:

```bash
npx wrangler d1 create cf-web-replica                  # paste database_id into wrangler.jsonc
npx wrangler hyperdrive create cf-web-pg \
  --connection-string="postgres://..." --caching-disabled
npx wrangler secret put SYNC_TRIGGER_TOKEN
npm run cf-typegen                                     # required after any binding change
```

`--caching-disabled` is not optional. Hyperdrive caches eligible non-mutating reads for 60s
by default and never invalidates on writes, so a retried page would be served a stale
snapshot and the watermark would advance past rows that were never read. Local development
cannot reproduce this: `wrangler dev` connects straight to Postgres with Hyperdrive out of
the path.

Local setup and operation:

```bash
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PG="postgres://..."
echo 'SYNC_TRIGGER_TOKEN="dev-token"' >> .dev.vars    # gitignored
npm run db:migrate:local
psql "$DATABASE_URL" -f sql/postgres/0001_demo_items.sql

curl -H "authorization: Bearer dev-token" "localhost:8787/__sync/status?preflight=1"
curl -X POST -H "authorization: Bearer dev-token" localhost:8787/__sync/run
curl -X POST -H "authorization: Bearer dev-token" localhost:8787/__sync/reconcile
curl -X POST -H "authorization: Bearer dev-token" -H 'content-type: application/json' \
  -d '{"table":"demo_items","truncate":true}' localhost:8787/__sync/reset
```

`preflight=1` checks the source against the spec's preconditions: a NOT NULL key and cursor
column, an index covering `(cursorColumn, primaryKey)`, and a `BEFORE UPDATE` trigger. That
trigger is mandatory — a write path that forgets to move the cursor column makes the row
invisible to replication forever.

A hard `DELETE` cannot be observed by a watermark: the row and its timestamp disappear
together. Use soft deletes, or opt a table into the nightly `reconcileDeletes` key walk.

Design rationale, limits and known gaps:
[`docs/decisions/0001-postgres-to-d1-one-way-sync.md`](docs/decisions/0001-postgres-to-d1-one-way-sync.md)
and [`docs/plans/active/postgres-d1-sync.md`](docs/plans/active/postgres-d1-sync.md).

## Checks

```bash
npm run typecheck   # src and the test project
npm test            # vitest, including the D1 statement builders against a real D1
```

## Deploy

The Tail Worker must exist before the main Worker that references it:

```bash
npm run deploy:tail
npm run deploy
```

## Payload storage — read before enabling in production

`storeMessages` and `storeTools` in `src/server.ts` are **on** in this scaffold so you can
see full traces immediately. They write real data into your spans:

- `storeMessages` → `gen_ai.input.messages` / `gen_ai.output.messages` on `chat`
- `storeTools` → `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` on `execute_tool`

Both default to `false` in the SDK. Turn them off if the agent handles anything you would
not want stored in Workers Observability. Schemas, request headers, provider options and raw
error messages are never recorded regardless of these flags.

## Sampling

`head_sampling_rate` is `1` (every trace). Lower it as traffic grows. To export to an
external OTLP collector, add its configured name to `observability.traces.destinations`.
