// Current schedule: the gtfs_* tables (db/gtfs_schema.sql), replaced on every import.
// Loaded into a staging schema, then swapped into public in one transaction.

import fsp from 'node:fs/promises';
import { copyRows } from './db.js';
import { DAYS, log } from './feed.js';

const STAGING = 'gtfs_staging';
const VIEWS = ['gtfs_trip_stop_times'];

// Table definitions in load order (FK parents first): columns + rows from the feed model
const TABLES = [
  ['gtfs_agency', ['agency_id', 'agency_name', 'agency_url', 'agency_phone'],
    (m) => [...m.agency.values()].map((a) => [a.agency_id, a.agency_name, a.agency_url, a.agency_phone])],
  ['gtfs_stops', ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'location_type', 'parent_station', 'zone_id'],
    (m) => [...m.stops.values()].map((s) => [s.stop_id, s.stop_code, s.stop_name, s.stop_desc, s.stop_lat, s.stop_lon, s.location_type, s.parent_station, s.zone_id])],
  ['gtfs_routes', ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_color'],
    (m) => [...m.routes.values()].map((r) => [r.route_id, r.agency_id, r.route_short_name, r.route_long_name, r.route_desc, r.route_type, r.route_color])],
  ['gtfs_calendar', ['service_id', ...DAYS, 'start_date', 'end_date'],
    (m) => m.calendar.map((c) => [c.service_id, ...DAYS.map((d) => c[d]), c.start_date, c.end_date])],
  ['gtfs_patterns', ['pattern_id', 'route_id', 'num_stops'],
    (m) => [...m.patterns.values()].map((p) => [p.id, p.routeId, p.stops.length])],
  ['gtfs_pattern_stops', ['pattern_id', 'stop_sequence', 'stop_id', 'pickup_type', 'drop_off_type'],
    (m) => [...m.patterns.values()].flatMap((p) => p.stops.map(([stop, pu, dof], i) => [p.id, i + 1, stop, pu, dof]))],
  ['gtfs_timing_profiles', ['profile_id', 'pattern_id', 'num_trips'],
    (m) => [...m.profiles.values()].map((pr) => [pr.id, pr.patternId, pr.trips])],
  ['gtfs_profile_offsets', ['profile_id', 'stop_sequence', 'offset_sec'],
    (m) => [...m.profiles.values()].flatMap((pr) => pr.offsets.map((o, i) => [pr.id, i + 1, o]))],
  ['gtfs_trips', ['trip_id', 'route_id', 'service_id', 'profile_id', 'origin_departure_sec', 'trip_headsign', 'direction_id', 'wheelchair_accessible'],
    (m) => m.trips.map((t) => [t.trip_id, t.route_id, t.service_id, t.profile_id, t.origin_departure_sec, t.trip_headsign, t.direction_id, t.wheelchair_accessible])],
];
const TABLE_NAMES = TABLES.map(([name]) => name);

async function loadStaging(client, model, schemaSqlPath) {
  await client.query(`DROP SCHEMA IF EXISTS ${STAGING} CASCADE`);
  await client.query(`CREATE SCHEMA ${STAGING}`);
  await client.query(`SET search_path TO ${STAGING}`);
  await client.query(await fsp.readFile(schemaSqlPath, 'utf8'));
  await client.query('SET search_path TO public');
  const expected = {};
  for (const [name, columns, rowsOf] of TABLES) {
    const rows = rowsOf(model);
    expected[name] = rows.length;
    log(`COPY ${name}: ${rows.length} rows`);
    await copyRows(client, `${STAGING}.${name}`, columns, rows);
  }
  return expected;
}

async function swapIntoPublic(client) {
  const { rows } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'service_role'`);
  const grantee = rows.length ? 'service_role' : null;

  await client.query('BEGIN');
  try {
    for (const v of VIEWS) await client.query(`DROP VIEW IF EXISTS public.${v}`);
    await client.query(`DROP TABLE IF EXISTS ${TABLE_NAMES.map((t) => `public.${t}`).join(', ')} CASCADE`);
    for (const t of TABLE_NAMES) await client.query(`ALTER TABLE ${STAGING}.${t} SET SCHEMA public`);
    for (const v of VIEWS) await client.query(`ALTER VIEW ${STAGING}.${v} SET SCHEMA public`);
    await client.query(`DROP SCHEMA ${STAGING}`);
    // Tables created outside public miss Supabase's default grants; give the server key read access
    if (grantee) {
      const all = [...TABLE_NAMES, ...VIEWS].map((t) => `public.${t}`).join(', ');
      await client.query(`GRANT SELECT ON ${all} TO ${grantee}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  // Let Supabase's REST API (PostgREST) see the new tables
  await client.query(`NOTIFY pgrst, 'reload schema'`);
}

/**
 * Replaces the gtfs_* tables with the feed in `model`. Returns rows per table.
 * On failure the previous tables stay untouched.
 */
export async function replaceCurrent(client, model, schemaSqlPath) {
  try {
    const expected = await loadStaging(client, model, schemaSqlPath);
    log('Swapping staging tables into public');
    await swapIntoPublic(client);
    const counts = {};
    for (const t of TABLE_NAMES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${t}`);
      counts[t] = rows[0].n;
      if (counts[t] !== expected[t]) throw new Error(`${t}: loaded ${counts[t]} rows, expected ${expected[t]}`);
    }
    return counts;
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${STAGING} CASCADE`).catch(() => {});
  }
}
