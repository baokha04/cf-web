# 0001 One-Way Periodic Postgres To D1 Replication

Date: 2026-08-27

## Status

Accepted

## Context

The Worker needed durable relational data. Opening a Postgres connection per
request from the edge is slow and burns connections; keeping the data only in
Durable Object storage gives no cross-instance query surface, because each
`/agents/traced-agent/{instance}` is its own isolated SQLite.

This is a data-ownership choice future work inherits, so it is recorded here
rather than left in the plan.

## Decision

Postgres is the system of record. D1 is a read-optimized replica, fed by
one-way incremental replication on a cron tick, reached from the Worker through
a Hyperdrive binding using `pg` (node-postgres) at `>=8.16.3`.

The pipeline is registry-driven: a table with a single-column primary key and a
monotonic timestamp column is registered as a `TableSpec` in
`src/sync/registry.ts` and needs no new code.

Three properties are load-bearing and must survive any refactor:

1. **The cursor is a row-value on `(cursorColumn, primaryKey)`.** A bare
   `WHERE updated_at > $1` skips every row sharing the boundary timestamp, and
   shared timestamps are the normal case: a bulk `UPDATE` using `now()` stamps
   transaction time identically across every row it touches. `>=` instead
   re-reads the boundary forever. The row-value form is still a single index
   seek on the composite btree.
2. **The cursor UPDATE rides in the same `db.batch()` as the rows it accounts
   for.** A batch is a SQL transaction, so the watermark can neither outrun
   uncommitted rows nor lag behind committed ones. This is why the cursor lives
   in D1 rather than Postgres, and it is the entire recovery story.
3. **The upsert is last-writer-wins by source timestamp**
   (`WHERE excluded.updated_at >= target.updated_at` on `DO UPDATE`). This makes
   at-least-once delivery safe: replaying an older page is a no-op.

4. **The cursor must round-trip at Postgres's own precision.** Postgres
   timestamps carry microseconds; a JS `Date` carries milliseconds. Normalising
   the cursor through `Date.toISOString()` truncates it, and a truncated cursor
   is strictly *earlier* than the row it came from, so
   `(cursorColumn, primaryKey) > (cursor)` matches rows that were already
   synced. The run then replays the same page until its budget runs out and the
   watermark never advances. This was observed end to end -- a 1000-row table
   reported 8500 rows upserted across 17 identical pages -- and is why
   `pg`'s type parser is pinned to raw wire text for OIDs 1082, 1114 **and
   1184**, and why `encodeValue` normalises timestamps to six fractional
   digits rather than to `Date`'s three.

Deletes: soft deletes (`deleted_at`) are the convention. A watermark cannot
observe a hard delete, because the row and its timestamp disappear together, so
an opt-in nightly full-key reconcile is the fallback for tables that hard-delete
anyway.

## Alternatives Considered

1. **`@neondatabase/serverless`.** Rejected: it speaks HTTP/WebSocket to Neon's
   own proxy, which bypasses the Hyperdrive binding entirely, and it couples the
   repository to one provider.
2. **`postgres` (postgres.js).** Supported by Hyperdrive and a reasonable
   choice, but tagged-template-first. A registry-driven query builder would have
   to route generic SQL through `sql.unsafe`, discarding the ergonomics that
   make the library attractive.
3. **Logical replication / CDC.** The correct answer for low-latency
   replication, but it needs a long-lived replication slot consumer, which a
   Worker is not.
4. **Bidirectional sync.** Out of scope. It requires a conflict policy that
   nothing in the product yet justifies.
5. **Bumping `compatibility_date` past 2026-08-04** so `nodejs_compat` is
   implied. Rejected: `nodejs_compat` is already set, and at the current date it
   already selects Node.js compatibility v2 -- what `pg` needs. A bump opts into
   every unrelated runtime change between the two dates, in a repository whose
   only automated gate is `tsc`.

## Consequences

Positive:

- Reads at the edge are D1 reads. Postgres sees one pooled connection per tick,
  not one per request.
- The initial backfill and every incremental tick share one code path. There is
  no separate bulk-load mode to write, test, or get wrong.
- A run is interruptible at page granularity. Budget exhaustion is a normal
  outcome (`partial`), not an error.
- Registering a table is configuration plus a D1 migration.

Tradeoffs:

- The replica is eventually consistent, bounded by the cron interval plus
  `safetyLagSeconds`.
- Hard deletes are invisible until the next reconcile completes. Tables that
  cannot tolerate that must use soft deletes.
- Hyperdrive caching must be disabled on the config used for sync
  (`wrangler hyperdrive create --caching-disabled`). Caching is on by default,
  is never invalidated by writes, and a cached page would advance the watermark
  past rows that were never read. Local development cannot reproduce this,
  because `wrangler dev` connects straight to Postgres with Hyperdrive out of
  the path.
- Replicated timestamps are stored at six fractional digits, so the replica's
  text form differs from a `Date`-derived one. Any code that reads the replica
  and re-normalises through `Date` will drop precision again.
- D1's 100-bound-parameter limit means a wide table packs few rows per
  statement, so statement counts -- and the 1000-per-invocation ceiling -- scale
  with column count. The replicated column list is a projection; keep it narrow.
- D1 tops out at 10 GB on the Paid plan, and the Free plan's
  50-queries-per-invocation limit does not fit this design at all.

## Follow-Up

- Proven end to end against PostgreSQL 16 on 2026-08-27, including the
  boundary-timestamp case that motivates property 1 and the truncation bug
  described in property 4. Evidence in
  `docs/plans/completed/postgres-d1-sync.md`.
- Create the real D1 database and Hyperdrive config (with
  `--caching-disabled`), then flip `SYNC_ENABLED` to `"true"`. Still
  outstanding: the Hyperdrive wire path is the one thing local development
  cannot exercise, because `wrangler dev` connects to Postgres directly.
- Revisit `head_sampling_rate` and the cron interval once real volume exists.
