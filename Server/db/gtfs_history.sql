-- Planned-schedule history (rolling window, 35 days by default).
-- Written by scripts/gtfs-import.js (nightly) and scripts/gtfs-backfill.js.
-- Unlike gtfs_*, these tables are never dropped. Safe to run repeatedly.
--
-- Storage idea: descriptive rows are content-addressed. Each *_key is an md5 of
-- the row's content (as uuid), so an unchanged stop / route / pattern / timing /
-- trip / service group is stored once, however many days use it. A new row
-- appears only when something actually changed. Per day only hist_service_days
-- grows: which service groups ran on that date.
--
-- Stable identifiers (stop_code, route_short_name, agency, route_desc) are stored
-- alongside the GTFS ids, because GTFS ids can change between feeds.

CREATE TABLE IF NOT EXISTS public.hist_stops (
  stop_key        uuid PRIMARY KEY,
  stop_id         integer NOT NULL,
  stop_code       integer,
  stop_name       text    NOT NULL,
  stop_desc       text,
  stop_lat        double precision,
  stop_lon        double precision,
  location_type   smallint,
  parent_station  integer,
  zone_id         text
);
CREATE INDEX IF NOT EXISTS hist_stops_stop_code_idx ON public.hist_stops (stop_code);

CREATE TABLE IF NOT EXISTS public.hist_routes (
  route_key         uuid PRIMARY KEY,
  route_id          integer  NOT NULL,
  agency_id         integer  NOT NULL,
  agency_name       text,
  route_short_name  text,
  route_long_name   text,
  route_desc        text,
  route_type        smallint
);
CREATE INDEX IF NOT EXISTS hist_routes_short_name_idx ON public.hist_routes (route_short_name);

-- Ordered stop list of a route
CREATE TABLE IF NOT EXISTS public.hist_patterns (
  pattern_key  uuid     PRIMARY KEY,
  route_key    uuid     NOT NULL REFERENCES public.hist_routes (route_key),
  num_stops    smallint NOT NULL
);
CREATE INDEX IF NOT EXISTS hist_patterns_route_idx ON public.hist_patterns (route_key);

CREATE TABLE IF NOT EXISTS public.hist_pattern_stops (
  pattern_key    uuid     NOT NULL REFERENCES public.hist_patterns (pattern_key) ON DELETE CASCADE,
  stop_sequence  smallint NOT NULL,
  stop_key       uuid     NOT NULL REFERENCES public.hist_stops (stop_key),
  pickup_type    smallint,
  drop_off_type  smallint,
  PRIMARY KEY (pattern_key, stop_sequence)
);
CREATE INDEX IF NOT EXISTS hist_pattern_stops_stop_idx ON public.hist_pattern_stops (stop_key);

-- Timing of a pattern: seconds after origin departure at each stop
CREATE TABLE IF NOT EXISTS public.hist_profiles (
  profile_key  uuid PRIMARY KEY,
  pattern_key  uuid NOT NULL REFERENCES public.hist_patterns (pattern_key)
);
CREATE INDEX IF NOT EXISTS hist_profiles_pattern_idx ON public.hist_profiles (pattern_key);

CREATE TABLE IF NOT EXISTS public.hist_profile_offsets (
  profile_key    uuid     NOT NULL REFERENCES public.hist_profiles (profile_key) ON DELETE CASCADE,
  stop_sequence  smallint NOT NULL,
  offset_sec     integer  NOT NULL,
  PRIMARY KEY (profile_key, stop_sequence)
);

-- A trip without its feed-specific trip_id (which changes daily)
CREATE TABLE IF NOT EXISTS public.hist_trips (
  trip_key               uuid    PRIMARY KEY,
  profile_key            uuid    NOT NULL REFERENCES public.hist_profiles (profile_key),
  origin_departure_sec   integer NOT NULL,
  trip_headsign          text,
  direction_id           smallint,
  wheelchair_accessible  smallint
);
CREATE INDEX IF NOT EXISTS hist_trips_profile_idx ON public.hist_trips (profile_key);

-- A group of trips that run together (content of one GTFS service_id)
CREATE TABLE IF NOT EXISTS public.hist_services (
  service_key  uuid    PRIMARY KEY,
  num_trips    integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.hist_service_trips (
  service_key  uuid     NOT NULL REFERENCES public.hist_services (service_key) ON DELETE CASCADE,
  trip_key     uuid     NOT NULL REFERENCES public.hist_trips (trip_key),
  trip_count   smallint NOT NULL DEFAULT 1,   -- identical trips in the group
  PRIMARY KEY (service_key, trip_key)
);
CREATE INDEX IF NOT EXISTS hist_service_trips_trip_idx ON public.hist_service_trips (trip_key);

-- The only table that grows every day: which service groups ran on a date
CREATE TABLE IF NOT EXISTS public.hist_service_days (
  service_date   date     NOT NULL,
  service_key    uuid     NOT NULL REFERENCES public.hist_services (service_key),
  service_count  smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (service_date, service_key)
);
CREATE INDEX IF NOT EXISTS hist_service_days_service_idx ON public.hist_service_days (service_key);

-- Which dates are covered, and from which file
CREATE TABLE IF NOT EXISTS public.hist_days (
  service_date        date        PRIMARY KEY,
  source              text        NOT NULL CHECK (source IN ('mot', 'archive')),
  source_url          text        NOT NULL,
  feed_last_modified  timestamptz,
  num_services        integer     NOT NULL,
  num_trips           integer     NOT NULL,
  loaded_at           timestamptz NOT NULL DEFAULT now()
);

-- Planned departures of a line (or of all lines when p_line is NULL) from a stop
-- on a calendar date. Covers trips of the previous service day that run after
-- midnight (GTFS times >= 24:00). planned_at is local Israel time.
-- Returns no rows when the date is not in hist_days; check coverage there.
CREATE OR REPLACE FUNCTION public.gtfs_planned_departures(
  p_date      date,
  p_stop_code integer,
  p_line      text DEFAULT NULL
)
RETURNS TABLE (
  planned_at        timestamp,
  service_date      date,
  departure_sec     integer,
  agency_name       text,
  route_short_name  text,
  route_desc        text,
  route_long_name   text,
  trip_headsign     text,
  stop_id           integer,
  stop_name         text,
  stop_sequence     smallint,
  pickup_type       smallint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- DISTINCT inside a subquery: when the planner inlines this function into a
  -- caller's query, a top-level DISTINCT + ORDER BY can fail
  SELECT d.* FROM (
  SELECT DISTINCT
         sd.service_date + make_interval(secs => tr.origin_departure_sec + po.offset_sec) AS planned_at,
         sd.service_date,
         tr.origin_departure_sec + po.offset_sec AS departure_sec,
         r.agency_name,
         r.route_short_name,
         r.route_desc,
         r.route_long_name,
         tr.trip_headsign,
         s.stop_id,
         s.stop_name,
         ps.stop_sequence,
         ps.pickup_type
  FROM hist_stops s
  JOIN hist_pattern_stops   ps ON ps.stop_key = s.stop_key
  JOIN hist_patterns        pa ON pa.pattern_key = ps.pattern_key
  JOIN hist_routes          r  ON r.route_key = pa.route_key
  JOIN hist_profiles        pf ON pf.pattern_key = pa.pattern_key
  JOIN hist_profile_offsets po ON po.profile_key = pf.profile_key AND po.stop_sequence = ps.stop_sequence
  JOIN hist_trips           tr ON tr.profile_key = pf.profile_key
  JOIN hist_service_trips   st ON st.trip_key = tr.trip_key
  JOIN hist_service_days    sd ON sd.service_key = st.service_key
                              AND sd.service_date IN (p_date - 1, p_date)
  WHERE s.stop_code = p_stop_code
    AND (p_line IS NULL OR r.route_short_name = p_line)
    AND (sd.service_date + make_interval(secs => tr.origin_departure_sec + po.offset_sec))::date = p_date
  ) d
  ORDER BY d.planned_at, d.route_short_name;
$$;

-- Access: RLS on, no policies. Only the server key (service_role) may read / execute.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['hist_stops', 'hist_routes', 'hist_patterns', 'hist_pattern_stops', 'hist_profiles',
                         'hist_profile_offsets', 'hist_trips', 'hist_services', 'hist_service_trips',
                         'hist_service_days', 'hist_days'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
      EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
    END IF;
  END LOOP;

  REVOKE ALL ON FUNCTION public.gtfs_planned_departures(date, integer, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.gtfs_planned_departures(date, integer, text) FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gtfs_planned_departures(date, integer, text) TO service_role;
  END IF;
END $$;
