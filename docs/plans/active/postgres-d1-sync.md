# Execution Plan: One-Way Periodic Postgres To D1 Sync

Date: 2026-08-27

## Status

Active

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
- [ ] End-to-end proof against a live Postgres.
- [ ] Move to `docs/plans/completed/`.

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

**Not proven, and not to be implied by a green typecheck:**

1. That `pg` reaches Postgres through Hyperdrive's wire proxy in the deployed
   runtime. Local dev connects directly, so Hyperdrive is never in the path.
   This is the largest locally-unverifiable risk in the design.
2. That the row-value seek executes and uses the composite index on a real
   Postgres.
3. The tie-break assertion itself: bulk-update more rows than `pageSize` so they
   share one `updated_at`, sync, and assert no row is lost. This is the most
   important single piece of evidence for the design and it is deferred.
4. The `set_updated_at` trigger and `preflight()` against a real schema.
5. That cron fires on schedule and that `--caching-disabled` takes effect.

The minimum sequence to close that gap once a Postgres is available: apply
`sql/postgres/0001_demo_items.sql`, seed 1000 rows, `POST /__sync/run`, compare
`count(*)` and `max(updated_at)` on both sides, change one row and assert
`rowsUpserted === 1`, re-run and assert `0`, bulk-update 600 rows for the
tie-break, soft delete, hard delete (D1 correctly still holds the row), then
reconcile and watch it disappear.

## Result

Pending. Complete once the end-to-end sequence above passes against a live
Postgres. Until then this plan stays `Active` and does not move to
`docs/plans/completed/`.
