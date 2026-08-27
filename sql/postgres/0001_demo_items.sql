-- Source-side fixture for the demo_items registration in src/sync/registry.ts.
--
-- Deliberately NOT under migrations/: wrangler owns that tree and Postgres is
-- not wrangler's to migrate. Apply this by hand:
--   psql "$DATABASE_URL" -f sql/postgres/0001_demo_items.sql

CREATE TABLE IF NOT EXISTS public.demo_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  qty         integer NOT NULL DEFAULT 0,
  price_cents bigint NOT NULL DEFAULT 0,
  metadata    jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- REQUIRED by the sync, not an optimization. The pull query orders by
-- (updated_at, id) and seeks with a row-value comparison; without this
-- composite index every tick is a full table scan plus a sort.
CREATE INDEX IF NOT EXISTS demo_items_sync_idx
  ON public.demo_items (updated_at, id);

-- REQUIRED by the sync. A watermark only works if every write moves it. An
-- UPDATE that does not touch updated_at is invisible to replication forever,
-- so the column is maintained by a trigger rather than by callers remembering.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS demo_items_set_updated_at ON public.demo_items;
CREATE TRIGGER demo_items_set_updated_at
  BEFORE UPDATE ON public.demo_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
