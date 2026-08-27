-- Migration number: 0001 	 2026-08-27T00:00:00.000Z
--
-- Cursor store for the one-way Postgres -> D1 replica. One row per registered
-- TableSpec.key.
--
-- This table lives in D1 rather than Postgres on purpose: the cursor UPDATE is
-- appended to the same db.batch() as the rows it accounts for, and batch() is a
-- SQL transaction. That single fact is what makes the pipeline safe to
-- interrupt -- the watermark physically cannot outrun committed rows, and
-- cannot lag behind them either.

CREATE TABLE IF NOT EXISTS _sync_state (
  table_key            TEXT PRIMARY KEY,

  -- ISO-8601 UTC. NULL means "never synced": the next run does the initial
  -- backfill, which is the same code path as an incremental tick.
  cursor_updated_at    TEXT,
  -- Primary key of the last row seen at cursor_updated_at, stored as TEXT.
  -- It is only ever a tie-break, and pull.ts casts it back to the source PK
  -- type in the query, so storing it lexically here is safe.
  cursor_pk            TEXT,

  last_run_started_at  TEXT,
  last_run_finished_at TEXT,
  -- idle | running | ok | partial | error
  last_run_status      TEXT NOT NULL DEFAULT 'idle',
  last_error           TEXT,

  rows_synced_total    INTEGER NOT NULL DEFAULT 0,
  rows_synced_last_run INTEGER NOT NULL DEFAULT 0,
  runs_total           INTEGER NOT NULL DEFAULT 0,

  -- Bumped by POST /__sync/reset. Lets a deliberate full re-sync be told apart
  -- from an ordinary resume in the logs without destroying the counters.
  full_sync_epoch      INTEGER NOT NULL DEFAULT 0,

  -- Independent, slower cursor for the delete-reconcile key walk, so a
  -- reconcile can be interrupted and resumed without disturbing the main sync.
  reconcile_cursor_pk  TEXT,
  reconciled_at        TEXT
);
