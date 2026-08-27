# Execution Plan: One-Way Periodic Postgres To D1 Sync

Date: 2026-08-27

## Status

Completed

## Outcome

A registry-driven incremental replication pipeline. Any Postgres table with a
single-column primary key and a monotonic `updated_at` is registered as a
`TableSpec` and replicated into a Cloudflare D1 edge replica on a cron tick,
resuming from a per-table watermark held in `_sync_state` inside D1 itself.

Postgres remains the system of record. D1 is a read-optimized replica so the
Worker can read at the edge instead of opening a Postgres connection per
request.

## Context

- Repository had no data layer before this work: no D1, no Postgres, no ORM, no
  migrations directory, no `.sql` files. The only persistence was the Agents SDK
  Durable Object state in `src/server.ts`.
- Naming trap worth stating once: the `migrations` key in `wrangler.jsonc` is a
  **Durable Object class migration**. D1 schema migrations are a separate tree,
  which is why `migrations_dir` here is `migrations/d1` rather than the default
  `migrations/`.
- `docs/WORKFLOW.md` requires a durable plan for work that spans sessions and has
  ordering dependencies, and requires executable or observable evidence before
  claiming completion.
- Lasting choices are promoted to
  `docs/decisions/0001-postgres-to-d1-one-way-sync.md`.

## Scope

In scope:

- D1 and Hyperdrive bindings, cron triggers, and sync vars in `wrangler.jsonc`.
- D1 schema migrations for `_sync_state` and a demo replica table.
- `src/sync/` module: types, registry, Postgres pull, D1 apply, orchestration,
  guarded HTTP routes.
- `scheduled()` handler and `/__sync/*` routes wired into `src/server.ts`.
- A `vitest` suite over the pure units and the D1 statement builders.
- A Postgres-side fixture under `sql/postgres/` applied by hand.

Out of scope:

- Deploying. No `wrangler deploy`, no `d1 create`, no `hyperdrive create`, no
  `secret put`, no `--remote` migration.
- Bidirectional sync and conflict resolution.
- Any real business schema. `demo_items` exists only to exercise every branch of
  the type mapper and is deletable.
- End-to-end validation against a live Postgres (see Validation).

## Approach

Three properties carry the correctness of the whole design.

**1. The cursor is a row-value on `(cursorColumn, primaryKey)`, not a bare
timestamp.** `WHERE updated_at > $1` skips every row sharing the boundary
timestamp, and shared timestamps are the normal case: a bulk `UPDATE` using
`now()` stamps transaction time, identical across every row it touches. `>=`
instead re-reads the boundary forever and livelocks when more rows share one
timestamp than fit in a page. The fix is a row-value comparison, which Postgres
evaluates lexicographically and can satisfy as a single index seek on the
composite btree `(updated_at, id)`:

```sql
WHERE ("updated_at", "id") > ($1::timestamptz, $2::uuid)
  AND "updated_at" <= now() - make_interval(secs => $3::double precision)
ORDER BY "updated_at" ASC, "id" ASC
LIMIT $4
```

The `$2::uuid` cast is why `TableSpec.primaryKeyPgType` exists: the cursor is
stored as TEXT in D1 and must be cast back to the source type to keep the seek
well-typed. The cursor-NULL case emits a separate statement rather than
`$1 IS NULL OR (...)`, because the OR form defeats the index seek and that
branch is the entire initial backfill.

**2. The cursor UPDATE is always the last statement of the same `db.batch()` as
the rows it accounts for.** `batch()` is a SQL transaction, so the watermark
cannot advance past uncommitted data and cannot lag behind committed data. Every
resume and recovery property follows from this one fact. The page is the atomic
unit.

**3. The upsert is last-writer-wins by source timestamp.**

```sql
ON CONFLICT("id") DO UPDATE SET ...
WHERE excluded."updated_at" >= "demo_items"."updated_at";
```

That trailing `WHERE` turns at-least-once delivery into a safe property:
replaying an older page is a no-op instead of a regression.

Around those: a per-run budget of wall clock and D1 statements, so a tick that
runs out ends `partial` with its cursor committed and the next tick continues. A
long backfill is just a sequence of partial runs through the same code path as
an incremental tick.

## Risks And Recovery

1. **Hyperdrive query caching silently skips rows.** Caching is on by default
   (`max_age` 60s, `stale_while_revalidate` 15s) and is never invalidated by
   writes. A replication read is an eligible non-mutating read, so a retry within
   the window is served a stale snapshot and the watermark advances past rows
   that were never seen. Mitigation: create the Hyperdrive config with
   `--caching-disabled`. Local dev cannot reproduce this because `wrangler dev`
   connects straight to Postgres with Hyperdrive out of the path. Recovery:
   `POST /__sync/reset` with `truncate`, then re-backfill. Detection: row-count
   parity drifts while `lagSeconds` still looks healthy.
2. **A long write transaction defeats the safety lag.** A transaction stamping
   `updated_at = now()` at start and committing 30s later is missed permanently
   by a 5s lag. Mitigation: `safetyLagSeconds` must exceed the longest write
   transaction, and must exceed replica lag if Hyperdrive points at a replica.
   Recovery: reset and re-backfill.
3. **`updated_at` not maintained on every write path** makes a row invisible
   forever. Mitigation: the `BEFORE UPDATE` trigger in `sql/postgres/` is
   mandatory, not decorative; `preflight()` asserts the column exists and is
   `NOT NULL`.
4. **Hard deletes are invisible until the next reconcile.** Structural, not a
   bug: a `DELETE` removes the row and its timestamp together, leaving nothing
   for a watermark query to return. Mitigation: soft deletes are the documented
   convention; the full-key reconcile is the opt-in fallback.
5. **A reconcile with mismatched key ordering deletes live rows.** Range
   reconcile is only correct when both sides order the primary key identically.
   `uuid` and INTEGER-stored integers agree; a bigint stored as TEXT does not
   (`"10" < "9"`); `text` under a Postgres collation like `en_US.UTF-8` does not
   match D1's BINARY. Mitigation: `validateSpec` rejects the unsafe
   combinations and forces `COLLATE "C"` for text keys. Recovery: the rows are
   still in Postgres; reset and re-backfill.
6. **The 100-bound-parameter limit is tighter than it looks.** A 30-column table
   gets 3 rows per statement, a 60-column table gets 1, and the
   1000-statements-per-invocation ceiling arrives proportionally sooner.
   Mitigation: `rowsPerStatement` computes it; the statement budget is enforced.
7. **Cron CPU is 30s, not 15 minutes, for intervals under an hour.** Mitigation:
   `SYNC_BUDGET_MS` defaults to 20000 and `partial` is a normal outcome. A large
   backfill can be driven through the HTTP trigger in a loop instead.
8. **Bumping `compatibility_date` to satisfy the driver** would opt into every
   runtime behavior change between the two dates, in a repository whose only
   automated gate is `tsc`. Mitigation: keep `2025-01-01`; `nodejs_compat` at
   that date already provides Node.js compatibility v2, which is what `pg`
   needs. If a bump becomes necessary, it is its own change with its own
   decision record and re-exercises the agent routes, not just the sync routes.
9. **A stale `worker-configuration.d.ts`** after adding three bindings produces
   errors that read like source bugs. Mitigation: `npm run cf-typegen` runs
   before any sync code is written and after every `wrangler.jsonc` edit.
10. **Local dev bypasses Hyperdrive entirely**, so green local output proves the
    SQL and the batching and proves nothing about the Hyperdrive wire path.
    Disclosed in Result rather than left implicit.

## Progress

- [x] Plan created.
- [x] `pg` and `@types/pg` added.
- [x] `wrangler.jsonc`: `d1_databases`, `hyperdrive`, `triggers`, `vars`.
- [x] `migrations/d1/0001_sync_state.sql`, `migrations/d1/0002_demo_items.sql`.
- [x] `sql/postgres/0001_demo_items.sql` source fixture.
- [x] `src/sync/{types,registry,sql,apply,pull,run,auth,http}.ts`.
- [x] `scheduled()` and `/__sync/*` wired into `src/server.ts`.
- [x] `vitest` suite and `vitest.config.ts`.
- [x] `npm run cf-typegen`, `npm run typecheck`, `npm test`, local D1 migrations.
- [x] Decision record.
- [x] End-to-end proof against a live Postgres.
- [x] Move to `docs/plans/completed/`.

## Decisions

- 2026-08-27: Driver is `pg` (node-postgres) at `>=8.16.3`. It is Cloudflare's
  documented recommendation for Hyperdrive, `8.16.3` is the stated minimum
  because that is where `pg-cloudflare` swaps `node:net` for
  `cloudflare:sockets`, and `$1` placeholders suit a registry-driven query
  builder better than postgres.js tagged templates, which would have to go
  through `sql.unsafe`. `@neondatabase/serverless` was rejected outright: it
  speaks HTTP/WebSocket to Neon's own proxy, bypassing the Hyperdrive binding
  the design is built on, and it couples the repository to one provider.
- 2026-08-27: `compatibility_date` stays at `2025-01-01`. See Risk 8.
- 2026-08-27: `migrations_dir` is `migrations/d1`, not the wrangler default, to
  keep D1 schema migrations visibly distinct from the Durable Object class
  migrations already in `wrangler.jsonc`.
- 2026-08-27: The cursor lives in D1 rather than Postgres, so it can be written
  in the same transaction as the rows it accounts for.
- 2026-08-27: `SYNC_ENABLED` ships as `"false"`. The bindings carry placeholder
  ids until a real D1 database and Hyperdrive config exist, and an accidental
  deploy should not run a broken sync every five minutes. Commenting out the
  `crons` key would not disable it; only `crons: []` or a runtime guard does.
- 2026-08-27: `vitest` with `@cloudflare/vitest-pool-workers` was added with
  explicit approval. The repository skill requires proposing rather than adding
  it silently. It earns its place here: the 100-parameter chunking arithmetic,
  the nine-way value encoder, and `validateSpec` as the injection boundary are
  all invisible to `tsc` and punished at runtime.
- 2026-08-27: Pure query builders live in `src/sync/sql.ts` and the bearer guard
  in `src/sync/auth.ts`, separate from the modules that hold I/O. The immediate
  cause was mechanical -- a test that transitively imports `pg` cannot load in
  the workers test pool -- but the split is right on its own terms: the query
  shapes are the part that quietly loses rows, and they should be assertable
  without a driver or a database.
- 2026-08-27: No custom spans. Every span in this repository comes from
  `wrapAISDK`, a purpose-built GenAI integration rather than a general span API
  this code could reuse. The operation is flat, and `runId` on each log line
  already provides the correlation a trace would.

## Validation

- Focused proof: `npm test` -- 89 tests, all passing. `buildPullSql` across both
  cursor branches and every primary-key cast; `buildKeyPageSql` across the
  collation branch; `encodeValue` across nine types and its throw conditions;
  `rowsPerStatement` and the chunking arithmetic around the 100-parameter limit;
  `validateSpec` rejection paths including the reconcile ordering traps;
  `quoteIdent`; `constantTimeEqual`.
- Integration or end-to-end proof: the statement builders run against a real D1
  in-process via `@cloudflare/vitest-pool-workers`, asserting batch atomicity,
  the last-writer-wins clause, cursor advance, soft-delete purge, and reset.
  Local D1 migrations applied with `npm run db:migrate:local` (both applied
  clean) and verified against `sqlite_master`: `_sync_state`, `demo_items`,
  `d1_migrations`, plus both demo indexes.
- Repository-required checks: `npm run cf-typegen` then `npm run typecheck`, which
  now covers the test project as well as `src/`. Both clean.

**End-to-end proof, PostgreSQL 16.13, 2026-08-27.** Local Postgres seeded with
1000 rows, `wrangler dev` on a config derived from `wrangler.jsonc` with `ai`
and `tail_consumers` stripped, Hyperdrive pointed at the local database via
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PG`.

| Check | Result |
| --- | --- |
| Agent routes and 404 fallback | Unchanged; `/__sync/*` is matched ahead of `routeAgentRequest` without shadowing it |
| Auth guard | 403 with no token and with a wrong token; 200 with the right one |
| `preflight` against the real schema | `ok: true` -- found the composite index and the `BEFORE UPDATE` trigger |
| Initial backfill | 1000 rows in 2 pages, `status: ok` |
| Parity | 1000/1000 rows, high-water mark identical to the microsecond |
| Idempotency | Re-run with no source change: 0 rows, 0 pages |
| Safety lag | An update inside the 5s window is correctly withheld, then picked up after it |
| Single-row incremental | Exactly 1 row |
| **Boundary timestamp (tie-break)** | 600 rows sharing one `updated_at`, spanning the 500-row page boundary: all 600 replicated, `sum(qty)` identical on both sides |
| Soft delete | Tombstone mirrored into the replica |
| Hard delete | Invisible to the watermark, as documented -- replica still held the row |
| Reconcile | 999 keys scanned, the 1 orphan deleted, parity restored |
| Cron `*/5` and `17 4` | Dispatch correctly on `controller.cron`; structured logs correlate by `runId` |
| Kill switch | `SYNC_ENABLED="false"` emits `sync.skipped` and replicates nothing |

**The run found one real bug, and it was the kind only this proof could find.**
The first backfill reported 8500 rows upserted from a 1000-row source across 17
identical pages, exhausting the statement budget without the watermark moving.
Cause: `pg` parses `timestamptz` (OID 1184) into a JS `Date`, which carries
milliseconds, so Postgres's microseconds were gone before `encodeValue` saw the
value; `.746Z` stored as a cursor is strictly earlier than the row's actual
`.746275`, so every already-synced row matched the cursor again. Verified
directly against the source: the truncated cursor still matched all 1000 rows
where the exact one matched 500. Fixed by pinning OID 1184 to raw wire text
alongside 1082 and 1114, and normalising timestamps to six fractional digits.
Regression test in `test/sync/apply.test.ts`; recorded as load-bearing property
4 in the decision record.

The unit suite did not catch this: it asserted the *shape* of the SQL, not the
round-trip fidelity of the value the cursor carries.

**Still not proven.** `pg` reaching Postgres through Hyperdrive's wire proxy in
the deployed runtime. `wrangler dev` connects directly, so Hyperdrive is never
in the path locally, and no local run can exercise it. Related and equally
unexercised: that `--caching-disabled` takes effect on the real config, and that
cron fires on Cloudflare's schedule rather than through
`/cdn-cgi/handler/scheduled`.

**Operational note worth keeping.** `wrangler` resolves `.dev.vars` relative to
the *config file's* directory, not the working directory. Running against a
config outside the repo means `SYNC_TRIGGER_TOKEN` is not loaded and every
`/__sync/*` request returns 403 -- which looks exactly like a broken guard.

## Result

Complete. The pipeline replicates correctly against a real PostgreSQL 16,
including the boundary-timestamp case the design exists to handle. One
cursor-precision bug was found and fixed under proof rather than in production,
where it would have presented as a sync that burns its whole budget every tick
and never advances.

Limitation carried forward, not resolved: the Hyperdrive wire path is
unexercised, because local development bypasses it entirely. The first deploy
should watch `lagSeconds` and row-count parity before the replica is trusted for
reads.
