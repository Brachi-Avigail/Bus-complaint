// Planned-schedule history (db/gtfs_history.sql).
// snapshotDay stores what a feed planned for one date; only rows whose content
// is new get inserted. pruneHistory keeps a rolling window.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { copyRows } from './db.js';
import { activeServiceIds, log } from './feed.js';

// md5 of the parts, formatted as uuid
const contentKey = (...parts) => {
  const h = crypto
    .createHash('md5')
    .update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\u001f'))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export async function ensureHistorySchema(client, historySqlPath) {
  await client.query(await fsp.readFile(historySqlPath, 'utf8'));
}

// Returns the subset of keys that already exist in table.keyCol
async function existingKeys(client, table, keyCol, keys) {
  if (!keys.length) return new Set();
  const { rows } = await client.query(`SELECT ${keyCol} AS k FROM public.${table} WHERE ${keyCol} = ANY($1::uuid[])`, [keys]);
  return new Set(rows.map((r) => r.k));
}

/**
 * Stores the schedule that `model` (one feed) planned for dateStr.
 * Re-running for the same date replaces that date. One transaction.
 * @param {{source: 'mot'|'archive', sourceUrl: string, lastModified: Date|null}} meta
 * @returns {Promise<object>} counts of rows written
 */
export async function snapshotDay(client, model, dateStr, meta) {
  const services = activeServiceIds(model.calendar, dateStr);
  const dayTrips = model.trips.filter((t) => services.has(t.service_id));
  if (!dayTrips.length) throw new Error(`Feed has no trips planned for ${dateStr}`);

  // ---- content keys (memoised) ----
  const stopRows = new Map();
  const stopKey = (id) => {
    const s = model.stops.get(id);
    if (!s) throw new Error(`Unknown stop_id ${id}`);
    const k = contentKey('stop', s.stop_id, s.stop_code, s.stop_name, s.stop_desc, s.stop_lat, s.stop_lon,
      s.location_type, s.parent_station, s.zone_id);
    if (!stopRows.has(k)) {
      stopRows.set(k, [k, s.stop_id, s.stop_code, s.stop_name, s.stop_desc, s.stop_lat, s.stop_lon,
        s.location_type, s.parent_station, s.zone_id]);
    }
    return k;
  };

  const routeKeys = new Map();
  const routeRows = new Map();
  const routeKey = (id) => {
    if (routeKeys.has(id)) return routeKeys.get(id);
    const r = model.routes.get(id);
    if (!r) throw new Error(`Unknown route_id ${id}`);
    const agencyName = model.agency.get(r.agency_id)?.agency_name ?? null;
    const k = contentKey('route', r.route_id, r.agency_id, agencyName, r.route_short_name, r.route_long_name,
      r.route_desc, r.route_type);
    routeKeys.set(id, k);
    routeRows.set(k, [k, r.route_id, r.agency_id, agencyName, r.route_short_name, r.route_long_name, r.route_desc, r.route_type]);
    return k;
  };

  const patternKeys = new Map();
  const patternRows = new Map(); // key -> { row, stops: [[seq, stopKey, pu, dof]] }
  const patternKey = (id) => {
    if (patternKeys.has(id)) return patternKeys.get(id);
    const p = model.patterns.get(id);
    const rk = routeKey(p.routeId);
    const stops = p.stops.map(([sid, pu, dof], i) => [i + 1, stopKey(sid), pu, dof]);
    const k = contentKey('pattern', rk, ...stops.map(([, sk, pu, dof]) => `${sk}:${pu}:${dof}`));
    patternKeys.set(id, k);
    if (!patternRows.has(k)) patternRows.set(k, { row: [k, rk, stops.length], stops });
    return k;
  };

  const profileKeys = new Map();
  const profileRows = new Map(); // key -> { row, offsets }
  const profileKey = (id) => {
    if (profileKeys.has(id)) return profileKeys.get(id);
    const pr = model.profiles.get(id);
    const pk = patternKey(pr.patternId);
    const k = contentKey('profile', pk, pr.offsets.join(','));
    profileKeys.set(id, k);
    if (!profileRows.has(k)) profileRows.set(k, { row: [k, pk], offsets: pr.offsets });
    return k;
  };

  // trips grouped by service_id: Map(service_id -> Map(trip_key -> count))
  const tripRows = new Map();
  const byService = new Map();
  for (const t of dayTrips) {
    const prk = profileKey(t.profile_id);
    const k = contentKey('trip', prk, t.origin_departure_sec, t.trip_headsign, t.direction_id, t.wheelchair_accessible);
    if (!tripRows.has(k)) tripRows.set(k, [k, prk, t.origin_departure_sec, t.trip_headsign, t.direction_id, t.wheelchair_accessible]);
    if (!byService.has(t.service_id)) byService.set(t.service_id, new Map());
    const m = byService.get(t.service_id);
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  const serviceRows = new Map(); // key -> { row, trips: [[tripKey, count]] }
  const dayServices = new Map(); // service_key -> count
  for (const tripsOfService of byService.values()) {
    const entries = [...tripsOfService.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const k = contentKey('service', ...entries.map(([tk, n]) => `${tk}:${n}`));
    if (!serviceRows.has(k)) {
      const total = entries.reduce((s, [, n]) => s + n, 0);
      serviceRows.set(k, { row: [k, total], trips: entries });
    }
    dayServices.set(k, (dayServices.get(k) ?? 0) + 1);
  }

  // ---- write only what is new ----
  const written = {};
  await client.query('BEGIN');
  try {
    const newOf = async (table, keyCol, map) => {
      const have = await existingKeys(client, table, keyCol, [...map.keys()]);
      return [...map.entries()].filter(([k]) => !have.has(k)).map(([, v]) => v);
    };
    const insert = async (table, columns, rows) => {
      written[table] = rows.length;
      if (rows.length) await copyRows(client, `public.${table}`, columns, rows);
    };

    await insert('hist_stops',
      ['stop_key', 'stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'location_type', 'parent_station', 'zone_id'],
      await newOf('hist_stops', 'stop_key', stopRows));
    await insert('hist_routes',
      ['route_key', 'route_id', 'agency_id', 'agency_name', 'route_short_name', 'route_long_name', 'route_desc', 'route_type'],
      await newOf('hist_routes', 'route_key', routeRows));

    const newPatterns = await newOf('hist_patterns', 'pattern_key', patternRows);
    await insert('hist_patterns', ['pattern_key', 'route_key', 'num_stops'], newPatterns.map((p) => p.row));
    await insert('hist_pattern_stops', ['pattern_key', 'stop_sequence', 'stop_key', 'pickup_type', 'drop_off_type'],
      newPatterns.flatMap((p) => p.stops.map(([seq, sk, pu, dof]) => [p.row[0], seq, sk, pu, dof])));

    const newProfiles = await newOf('hist_profiles', 'profile_key', profileRows);
    await insert('hist_profiles', ['profile_key', 'pattern_key'], newProfiles.map((p) => p.row));
    await insert('hist_profile_offsets', ['profile_key', 'stop_sequence', 'offset_sec'],
      newProfiles.flatMap((p) => p.offsets.map((o, i) => [p.row[0], i + 1, o])));

    await insert('hist_trips',
      ['trip_key', 'profile_key', 'origin_departure_sec', 'trip_headsign', 'direction_id', 'wheelchair_accessible'],
      await newOf('hist_trips', 'trip_key', tripRows));

    const newServices = await newOf('hist_services', 'service_key', serviceRows);
    await insert('hist_services', ['service_key', 'num_trips'], newServices.map((s) => s.row));
    await insert('hist_service_trips', ['service_key', 'trip_key', 'trip_count'],
      newServices.flatMap((s) => s.trips.map(([tk, n]) => [s.row[0], tk, n])));

    await client.query('DELETE FROM public.hist_service_days WHERE service_date = $1', [dateStr]);
    await insert('hist_service_days', ['service_date', 'service_key', 'service_count'],
      [...dayServices.entries()].map(([k, n]) => [dateStr, k, n]));

    await client.query(
      `INSERT INTO public.hist_days (service_date, source, source_url, feed_last_modified, num_services, num_trips)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (service_date) DO UPDATE SET
         source = EXCLUDED.source, source_url = EXCLUDED.source_url,
         feed_last_modified = EXCLUDED.feed_last_modified, num_services = EXCLUDED.num_services,
         num_trips = EXCLUDED.num_trips, loaded_at = now()`,
      [dateStr, meta.source, meta.sourceUrl, meta.lastModified, services.size, dayTrips.length],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  log(`History ${dateStr}: ${dayTrips.length} trips, ${services.size} services; new rows ${JSON.stringify(written)}`);
  return { date: dateStr, trips: dayTrips.length, services: services.size, newRows: written };
}

/**
 * Deletes days before cutoffDate (YYYY-MM-DD), then every descriptive row no
 * remaining day refers to. One transaction.
 */
export async function pruneHistory(client, cutoffDate) {
  const steps = [
    ['hist_service_days', 'DELETE FROM public.hist_service_days WHERE service_date < $1', [cutoffDate]],
    ['hist_days', 'DELETE FROM public.hist_days WHERE service_date < $1', [cutoffDate]],
    ['hist_services', `DELETE FROM public.hist_services s WHERE NOT EXISTS
      (SELECT 1 FROM public.hist_service_days d WHERE d.service_key = s.service_key)`],
    ['hist_trips', `DELETE FROM public.hist_trips t WHERE NOT EXISTS
      (SELECT 1 FROM public.hist_service_trips st WHERE st.trip_key = t.trip_key)`],
    ['hist_profiles', `DELETE FROM public.hist_profiles p WHERE NOT EXISTS
      (SELECT 1 FROM public.hist_trips t WHERE t.profile_key = p.profile_key)`],
    ['hist_patterns', `DELETE FROM public.hist_patterns p WHERE NOT EXISTS
      (SELECT 1 FROM public.hist_profiles f WHERE f.pattern_key = p.pattern_key)`],
    ['hist_routes', `DELETE FROM public.hist_routes r WHERE NOT EXISTS
      (SELECT 1 FROM public.hist_patterns p WHERE p.route_key = r.route_key)`],
    ['hist_stops', `DELETE FROM public.hist_stops s WHERE NOT EXISTS
      (SELECT 1 FROM public.hist_pattern_stops ps WHERE ps.stop_key = s.stop_key)`],
  ];
  const deleted = {};
  await client.query('BEGIN');
  try {
    for (const [name, sql, params] of steps) {
      const res = await client.query(sql, params);
      deleted[name] = res.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  log(`Pruned history before ${cutoffDate}: ${JSON.stringify(deleted)}`);
  return deleted;
}
