-- GTFS data tables (Israel Ministry of Transport feed).
--
-- Names are deliberately NOT schema-qualified: scripts/gtfs-import.js runs this
-- file with search_path set to a staging schema, loads the data there, and then
-- moves every relation into public in one transaction.
--
-- stop_times.txt (~10M rows) is not stored. The loader compresses it into:
--   gtfs_patterns / gtfs_pattern_stops       ordered stop list of each route variant
--   gtfs_timing_profiles / gtfs_profile_offsets  seconds after origin departure per stop
-- A trip's planned time at any stop = origin_departure_sec + offset_sec
-- (see the gtfs_trip_stop_times view).
--
-- All times are seconds after midnight of the service day; GTFS allows values
-- past 24:00:00 for trips that run after midnight.

-- Operators
CREATE TABLE gtfs_agency (
  agency_id     integer PRIMARY KEY,
  agency_name   text    NOT NULL,
  agency_url    text,
  agency_phone  text
);

-- Stops and stations
CREATE TABLE gtfs_stops (
  stop_id         integer PRIMARY KEY,
  stop_code       integer,                  -- number shown on the stop sign
  stop_name       text    NOT NULL,
  stop_desc       text,
  stop_lat        double precision,
  stop_lon        double precision,
  location_type   smallint,                 -- 0 stop, 1 station
  parent_station  integer REFERENCES gtfs_stops (stop_id),
  zone_id         text
);
CREATE INDEX gtfs_stops_stop_code_idx ON gtfs_stops (stop_code);

-- Lines. One route_id per line + direction + alternative (see route_desc)
CREATE TABLE gtfs_routes (
  route_id          integer  PRIMARY KEY,
  agency_id         integer  NOT NULL REFERENCES gtfs_agency (agency_id),
  route_short_name  text,                   -- line number as shown to riders, e.g. '480'
  route_long_name   text,
  route_desc        text,                   -- MOT line id: 'license-direction-alternative'
  route_type        smallint NOT NULL,      -- 3 bus, 2 rail, ...
  route_color       text
);
CREATE INDEX gtfs_routes_short_name_idx ON gtfs_routes (route_short_name, agency_id);

-- Which days each service_id runs
CREATE TABLE gtfs_calendar (
  service_id  integer PRIMARY KEY,
  sunday      boolean NOT NULL,
  monday      boolean NOT NULL,
  tuesday     boolean NOT NULL,
  wednesday   boolean NOT NULL,
  thursday    boolean NOT NULL,
  friday      boolean NOT NULL,
  saturday    boolean NOT NULL,
  start_date  date    NOT NULL,
  end_date    date    NOT NULL
);

-- Distinct ordered stop lists of a route (usually one per route)
CREATE TABLE gtfs_patterns (
  pattern_id  integer  PRIMARY KEY,
  route_id    integer  NOT NULL REFERENCES gtfs_routes (route_id),
  num_stops   smallint NOT NULL
);
CREATE INDEX gtfs_patterns_route_idx ON gtfs_patterns (route_id);

-- Stops of a pattern in travel order. stop_sequence is renumbered 1..n
CREATE TABLE gtfs_pattern_stops (
  pattern_id     integer  NOT NULL REFERENCES gtfs_patterns (pattern_id),
  stop_sequence  smallint NOT NULL,
  stop_id        integer  NOT NULL REFERENCES gtfs_stops (stop_id),
  pickup_type    smallint,                  -- 0 regular, 1 no boarding
  drop_off_type  smallint,                  -- 0 regular, 1 no alighting
  PRIMARY KEY (pattern_id, stop_sequence)
);
CREATE INDEX gtfs_pattern_stops_stop_idx ON gtfs_pattern_stops (stop_id);

-- Distinct timing of a pattern (trips with identical stop offsets share one)
CREATE TABLE gtfs_timing_profiles (
  profile_id  integer PRIMARY KEY,
  pattern_id  integer NOT NULL REFERENCES gtfs_patterns (pattern_id),
  num_trips   integer NOT NULL
);
CREATE INDEX gtfs_timing_profiles_pattern_idx ON gtfs_timing_profiles (pattern_id);

-- Seconds after the trip's origin departure at each stop of the pattern
CREATE TABLE gtfs_profile_offsets (
  profile_id     integer  NOT NULL REFERENCES gtfs_timing_profiles (profile_id),
  stop_sequence  smallint NOT NULL,
  offset_sec     integer  NOT NULL,
  PRIMARY KEY (profile_id, stop_sequence)
);

-- Trips. Only the departure from the first stop is stored
CREATE TABLE gtfs_trips (
  trip_id                text     PRIMARY KEY,
  route_id               integer  NOT NULL REFERENCES gtfs_routes (route_id),
  service_id             integer  NOT NULL REFERENCES gtfs_calendar (service_id),
  profile_id             integer  NOT NULL REFERENCES gtfs_timing_profiles (profile_id),
  origin_departure_sec   integer  NOT NULL CHECK (origin_departure_sec >= 0),
  trip_headsign          text,
  direction_id           smallint,
  wheelchair_accessible  smallint
);
CREATE INDEX gtfs_trips_route_departure_idx ON gtfs_trips (route_id, origin_departure_sec);
CREATE INDEX gtfs_trips_service_idx ON gtfs_trips (service_id);
CREATE INDEX gtfs_trips_profile_idx ON gtfs_trips (profile_id);

-- Planned time of every trip at every stop, rebuilt from the compressed tables
CREATE VIEW gtfs_trip_stop_times WITH (security_invoker = true) AS
SELECT t.trip_id,
       t.route_id,
       t.service_id,
       ps.stop_sequence,
       ps.stop_id,
       t.origin_departure_sec + po.offset_sec AS departure_sec,
       ps.pickup_type,
       ps.drop_off_type
FROM gtfs_trips t
JOIN gtfs_timing_profiles tp ON tp.profile_id = t.profile_id
JOIN gtfs_profile_offsets po ON po.profile_id = tp.profile_id
JOIN gtfs_pattern_stops   ps ON ps.pattern_id = tp.pattern_id
                            AND ps.stop_sequence = po.stop_sequence;

-- Row Level Security with no policies: the anon / authenticated API roles get
-- nothing. service_role and direct DB connections bypass RLS.
ALTER TABLE gtfs_agency          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_stops           ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_routes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_calendar        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_patterns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_pattern_stops   ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_timing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_profile_offsets ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtfs_trips           ENABLE ROW LEVEL SECURITY;
