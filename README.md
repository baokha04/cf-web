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
| `src/server.ts` | The agent. Wraps the AI SDK with `wrapAISDK` for model/tool spans. |
| `src/tail.ts` | Tail Worker consuming `diagnosticsChannelEvents`. Deployed separately. |
| `wrangler.jsonc` | Main Worker. Traces, logs, AI binding, DO binding, tail consumer. |
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
