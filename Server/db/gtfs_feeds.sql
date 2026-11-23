-- Import log for the GTFS loader (scripts/gtfs-import.js).
-- Lives in public permanently; it is NOT swapped with the GTFS data tables.
CREATE TABLE IF NOT EXISTS public.gtfs_feeds (
  feed_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL DEFAULT now(),
  status             text        NOT NULL CHECK (status IN ('success', 'failed')),
  source_url         text        NOT NULL,
  feed_last_modified timestamptz,          -- Last-Modified of the downloaded zip
  file_size_bytes    bigint,
  row_counts         jsonb,                -- rows loaded per table
  warnings           jsonb,
  error              text
);

-- No policies: only service_role / direct DB connections can read it
ALTER TABLE public.gtfs_feeds ENABLE ROW LEVEL SECURITY;

-- Supabase's default grants give the API roles TRUNCATE etc., which RLS does
-- not block. Remove them and give the server key read access only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.gtfs_feeds FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON public.gtfs_feeds FROM service_role;
    GRANT SELECT ON public.gtfs_feeds TO service_role;
  END IF;
END $$;
