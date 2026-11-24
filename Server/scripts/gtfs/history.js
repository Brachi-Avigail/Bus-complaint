// Planned-schedule history (db/gtfs_history.sql).
// snapshotDay stores what a feed planned for one date; only rows whose content
// is new get inserted. pruneHistory keeps a rolling window.
//
// Every descriptive row has a content_hash (md5 of its content, formatted as uuid)
// used only to find an existing identical row, and a short integer *_key that
// other rows reference.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { copyRows } from './db.js';
import { activeServiceIds, log } from './feed.js';

const contentHash = (...parts) => {
  const h = crypto
    .createHash('md5')
    .update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\u001f'))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export async function ensureHistorySchema(client, historySqlPath) {
  await client.query(await fsp.readFile(historySqlPath, 'utf8'));
}

/**
 * Maps each hash to its integer key: existing rows are looked up, new hashes get
 * keys reserved from the table's identity sequence.
 * @returns {Promise<{ids: Map<string, number>, fresh: string[]}>}
 */
async function resolveKeys(client, table, keyCol, hashes) {
  const ids = new Map();
  if (!hashes.length) return { ids, fresh: [] };
  const { rows } = await client.query(
    `SELECT content_hash::text AS h, ${keyCol} AS id FROM public.${table} WHERE content_hash = ANY($1::uuid[])`,
    [hashes],
  );
  for (const r of rows) ids.set(r.h, r.id);
  const fresh = hashes.filter((h) => !ids.has(h));
  if (fresh.length) {
    const { rows: seq } = await client.query(
      `SELECT nextval(pg_get_serial_sequence('public.${table}', '${keyCol}'))::int AS id FROM generate_series(1, $1)`,
      [fresh.length],
    );
    fresh.forEach((h, i) => ids.set(h, seq[i].id));
  }
  return { ids, fresh };
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

  // ---- content hashes (memoised). Parents are referenced by hash until keys are resolved ----
  const stops = new Map(); // hash -> fields
  const stopHashById = new Map();
  const stopHash = (id) => {
    if (stopHashById.has(id)) return stopHashById.get(id);
    const s = model.stops.get(id);
    if (!s) throw new Error(`Unknown stop_id ${id}`);
    const fields = [s.stop_id, s.stop_code, s.stop_name, s.stop_desc, s.stop_lat, s.stop_lon,
      s.location_type, s.parent_station, s.zone_id];
    const h = contentHash('stop', ...fields);
    stopHashById.set(id, h);
    stops.set(h, fields);
    return h;
  };

  const routes = new Map(); // hash -> fields
  const routeHashById = new Map();
  const routeHash = (id) => {
    if (routeHashById.has(id)) return routeHashById.get(id);
    const r = model.routes.get(id);
    if (!r) throw new Error(`Unknown route_id ${id}`);
    const agencyName = model.agency.get(r.agency_id)?.agency_name ?? null;
    const fields = [r.route_id, r.agency_id, agencyName, r.route_short_name, r.route_long_name, r.route_desc, r.route_type];
    const h = contentHash('route', ...fields);
    routeHashById.set(id, h);
    routes.set(h, fields);
    return h;
  };

  const patterns = new Map(); // hash -> { route, stops: [[seq, stopHash, pu, dof]] }
  const patternHashById = new Map();
  const patternHash = (id) => {
    if (patternHashById.has(id)) return patternHashById.get(id);
    const p = model.patterns.get(id);
    const route = routeHash(p.routeId);
    const list = p.stops.map(([sid, pu, dof], i) => [i + 1, stopHash(sid), pu, dof]);
    const h = contentHash('pattern', route, ...list.map(([, sh, pu, dof]) => `${sh}:${pu}:${dof}`));
    patternHashById.set(id, h);
    if (!patterns.has(h)) patterns.set(h, { route, stops: list });
    return h;
  };

  const profiles = new Map(); // hash -> { pattern, offsets }
  const profileHashById = new Map();
  const profileHash = (id) => {
    if (profileHashById.has(id)) return profileHashById.get(id);
    const pr = model.profiles.get(id);
    const pattern = patternHash(pr.patternId);
    const h = contentHash('profile', pattern, pr.offsets.join(','));
    profileHashById.set(id, h);
    if (!profiles.has(h)) profiles.set(h, { pattern, offsets: pr.offsets });
    return h;
  };

  const trips = new Map(); // hash -> { profile, fields }
  const byService = new Map(); // service_id -> Map(tripHash -> count)
  for (const t of dayTrips) {
    const profile = profileHash(t.profile_id);
    const fields = [t.origin_departure_sec, t.trip_headsign, t.direction_id, t.wheelchair_accessible];
    const h = contentHash('trip', profile, ...fields);
    if (!trips.has(h)) trips.set(h, { profile, fields });
    if (!byService.has(t.service_id)) byService.set(t.service_id, new Map());
    const m = byService.get(t.service_id);
    m.set(h, (m.get(h) ?? 0) + 1);
  }

  const serviceGroups = new Map(); // hash -> { total, trips: [[tripHash, count]] }
  const dayServices = new Map(); // service hash -> count
  for (const tripsOfService of byService.values()) {
    const entries = [...tripsOfService.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const h = contentHash('service', ...entries.map(([th, n]) => `${th}:${n}`));
    if (!serviceGroups.has(h)) serviceGroups.set(h, { total: entries.reduce((s, [, n]) => s + n, 0), trips: entries });
    dayServices.set(h, (dayServices.get(h) ?? 0) + 1);
  }

  // ---- write only what is new, parents first ----
  const written = {};
  const insert = async (table, columns, rows) => {
    written[table] = rows.length;
    if (rows.length) await copyRows(client, `public.${table}`, columns, rows);
  };

  await client.query('BEGIN');
  try {
    const stopK = await resolveKeys(client, 'hist_stops', 'stop_key', [...stops.keys()]);
    await insert('hist_stops',
      ['stop_key', 'content_hash', 'stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon',
        'location_type', 'parent_station', 'zone_id'],
      stopK.fresh.map((h) => [stopK.ids.get(h), h, ...stops.get(h)]));

    const routeK = await resolveKeys(client, 'hist_routes', 'route_key', [...routes.keys()]);
    await insert('hist_routes',
      ['route_key', 'content_hash', 'route_id', 'agency_id', 'agency_name', 'route_short_name', 'route_long_name',
        'route_desc', 'route_type'],
      routeK.fresh.map((h) => [routeK.ids.get(h), h, ...routes.get(h)]));

    const patternK = await resolveKeys(client, 'hist_patterns', 'pattern_key', [...patterns.keys()]);
    await insert('hist_patterns', ['pattern_key', 'content_hash', 'route_key', 'num_stops'],
      patternK.fresh.map((h) => {
        const p = patterns.get(h);
        return [patternK.ids.get(h), h, routeK.ids.get(p.route), p.stops.length];
      }));
    await insert('hist_pattern_stops', ['pattern_key', 'stop_sequence', 'stop_key', 'pickup_type', 'drop_off_type'],
      patternK.fresh.flatMap((h) => patterns.get(h).stops.map(([seq, sh, pu, dof]) =>
        [patternK.ids.get(h), seq, stopK.ids.get(sh), pu, dof])));

    const profileK = await resolveKeys(client, 'hist_profiles', 'profile_key', [...profiles.keys()]);
    await insert('hist_profiles', ['profile_key', 'content_hash', 'pattern_key'],
      profileK.fresh.map((h) => [profileK.ids.get(h), h, patternK.ids.get(profiles.get(h).pattern)]));
    await insert('hist_profile_offsets', ['profile_key', 'stop_sequence', 'offset_sec'],
      profileK.fresh.flatMap((h) => profiles.get(h).offsets.map((o, i) => [profileK.ids.get(h), i + 1, o])));

    const tripK = await resolveKeys(client, 'hist_trips', 'trip_key', [...trips.keys()]);
    await insert('hist_trips',
      ['trip_key', 'content_hash', 'profile_key', 'origin_departure_sec', 'trip_headsign', 'direction_id',
        'wheelchair_accessible'],
      tripK.fresh.map((h) => {
        const t = trips.get(h);
        return [tripK.ids.get(h), h, profileK.ids.get(t.profile), ...t.fields];
      }));

    const serviceK = await resolveKeys(client, 'hist_services', 'service_key', [...serviceGroups.keys()]);
    await insert('hist_services', ['service_key', 'content_hash', 'num_trips'],
      serviceK.fresh.map((h) => [serviceK.ids.get(h), h, serviceGroups.get(h).total]));
    await insert('hist_service_trips', ['service_key', 'trip_key', 'trip_count'],
      serviceK.fresh.flatMap((h) => serviceGroups.get(h).trips.map(([th, n]) =>
        [serviceK.ids.get(h), tripK.ids.get(th), n])));

    await client.query('DELETE FROM public.hist_service_days WHERE service_date = $1', [dateStr]);
    await insert('hist_service_days', ['service_date', 'service_key', 'service_count'],
      [...dayServices.entries()].map(([h, n]) => [dateStr, serviceK.ids.get(h), n]));

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
