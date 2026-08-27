-- Migration number: 0002 	 2026-08-27T00:00:01.000Z
--
-- Demo replica table: the smallest thing that exercises every branch of the
-- type mapper (uuid PK, int, bigint, jsonb, bool, nullable timestamp). Drop
-- this file and its registry entry in src/sync/registry.ts once real tables are
-- registered; nothing in src/sync/ depends on it.
--
-- Column types follow the PG -> SQLite mapping documented in src/sync/types.ts.
-- The two that matter: int8 and numeric land in TEXT, not INTEGER/REAL, because
-- a JS number loses them silently and the loss only surfaces when someone sums
-- the column.

CREATE TABLE IF NOT EXISTS demo_items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 0,
  price_cents TEXT    NOT NULL DEFAULT '0',
  metadata    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- The replica exists to be read at the edge, so index the read shapes, not the
-- write shapes. updated_at is indexed because /__sync/status compares D1's high
-- water mark against the source's.
CREATE INDEX IF NOT EXISTS demo_items_updated_at_idx ON demo_items (updated_at);
CREATE INDEX IF NOT EXISTS demo_items_active_idx
  ON demo_items (is_active) WHERE deleted_at IS NULL;
