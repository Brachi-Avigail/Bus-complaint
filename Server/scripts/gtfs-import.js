// GTFS import for the Israel Ministry of Transport feed.
//
// 1. Downloads israel-public-transportation.zip (3 attempts).
// 2. Reads it locally. stop_times.txt (~10M rows) is too large for the
//    database, so it is compressed here into stop patterns + timing profiles.
// 3. Loads everything into a staging schema with COPY (FK-checked).
// 4. Swaps the staging tables into public in one transaction. If anything
//    fails, the previous data stays untouched.
// 5. Records the run in public.gtfs_feeds.
//
// Usage (from Server/):
//   npm run gtfs:import                       download + import
//   npm run gtfs:import -- --skip-download    reuse data/gtfs/israel-public-transportation.zip
//
// Requires DATABASE_URL in .env (Postgres connection string, Supabase Session pooler).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';
import yauzl from 'yauzl';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const FEED_URL =
  process.env.GTFS_URL || 'https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip';
const DATA_DIR = path.join(ROOT, 'data', 'gtfs');
const ZIP_PATH = path.join(DATA_DIR, 'israel-public-transportation.zip');
const SCHEMA_SQL = path.join(ROOT, 'db', 'gtfs_schema.sql');
const FEEDS_SQL = path.join(ROOT, 'db', 'gtfs_feeds.sql');
const STAGING = 'gtfs_staging';

// Relations created by gtfs_schema.sql. Tables are listed in load order (FK parents first).
const TABLES = [
  'gtfs_agency',
  'gtfs_stops',
  'gtfs_routes',
  'gtfs_calendar',
  'gtfs_patterns',
  'gtfs_pattern_stops',
  'gtfs_timing_profiles',
  'gtfs_profile_offsets',
  'gtfs_trips',
];
const VIEWS = ['gtfs_trip_stop_times'];

// A feed below these counts is treated as truncated and is not loaded
const MIN_ROWS = { agency: 10, stops: 10000, routes: 2000, calendar: 1000, trips: 50000, stop_times: 1000000 };

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- value parsing ----------

function parseCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const txt = (v) => (v === undefined || v === '' ? null : v);
const num = (v) => (v === undefined || v === '' ? null : Number(v));
const bool = (v) => v === '1';

function int(v, field) {
  if (v === undefined || v === '') return null;
  if (!/^-?\d+$/.test(v)) throw new Error(`${field}: not an integer: "${v}"`);
  return Number(v);
}

function gtfsDate(v, field) {
  if (!/^\d{8}$/.test(v)) throw new Error(`${field}: not a YYYYMMDD date: "${v}"`);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`;
}

function timeToSec(v, field) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(v);
  if (!m) throw new Error(`${field}: not a HH:MM:SS time: "${v}"`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ---------- zip reading ----------

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', (e) => { entries.set(e.fileName, e); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const openEntryStream = (zip, entry) =>
  new Promise((resolve, reject) => zip.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s))));

// Calls fn(row, col) for every data row; col maps column name -> index.
// Absent optional columns resolve to undefined, which the parsers turn into NULL.
async function forEachRow(z, name, required, fn) {
  const entry = z.entries.get(name);
  if (!entry) throw new Error(`Feed is missing ${name}`);
  const rl = readline.createInterface({ input: await openEntryStream(z.zip, entry), crlfDelay: Infinity });
  let col = null;
  let n = 0;
  for await (const line of rl) {
    if (col === null) {
      const header = parseCsvLine(line.replace(/^﻿/, '')).map((h) => h.trim());
      const missing = required.filter((r) => !header.includes(r));
      if (missing.length) throw new Error(`${name}: missing columns ${missing.join(', ')}`);
      col = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    if (line === '') continue;
    fn(parseCsvLine(line), col);
    n++;
  }
  return n;
}

// ---------- build dataset ----------

async function buildDataset(z) {
  const counts = {};
  const warnings = [];

  const agency = [];
  counts.agency = await forEachRow(z, 'agency.txt', ['agency_id', 'agency_name'], (r, c) => {
    agency.push([int(r[c.agency_id], 'agency_id'), txt(r[c.agency_name]), txt(r[c.agency_url]), txt(r[c.agency_phone])]);
  });

  const stops = [];
  counts.stops = await forEachRow(z, 'stops.txt', ['stop_id', 'stop_code', 'stop_name'], (r, c) => {
    stops.push([
      int(r[c.stop_id], 'stop_id'),
      int(r[c.stop_code], 'stop_code'),
      txt(r[c.stop_name]),
      txt(r[c.stop_desc]),
      num(r[c.stop_lat]),
      num(r[c.stop_lon]),
      int(r[c.location_type], 'location_type'),
      int(r[c.parent_station], 'parent_station'),
      txt(r[c.zone_id]),
    ]);
  });

  const routes = [];
  counts.routes = await forEachRow(z, 'routes.txt', ['route_id', 'agency_id', 'route_short_name', 'route_type'], (r, c) => {
    routes.push([
      int(r[c.route_id], 'route_id'),
      int(r[c.agency_id], 'agency_id'),
      txt(r[c.route_short_name]),
      txt(r[c.route_long_name]),
      txt(r[c.route_desc]),
      int(r[c.route_type], 'route_type'),
      txt(r[c.route_color]),
    ]);
  });

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const calendar = [];
  counts.calendar = await forEachRow(z, 'calendar.txt', ['service_id', ...days, 'start_date', 'end_date'], (r, c) => {
    calendar.push([
      int(r[c.service_id], 'service_id'),
      ...days.map((d) => bool(r[c[d]])),
      gtfsDate(r[c.start_date], 'start_date'),
      gtfsDate(r[c.end_date], 'end_date'),
    ]);
  });

  const trips = new Map();
  counts.trips = await forEachRow(z, 'trips.txt', ['route_id', 'service_id', 'trip_id'], (r, c) => {
    trips.set(r[c.trip_id], {
      route_id: int(r[c.route_id], 'route_id'),
      service_id: int(r[c.service_id], 'service_id'),
      headsign: txt(r[c.trip_headsign]),
      direction_id: int(r[c.direction_id], 'direction_id'),
      wheelchair: int(r[c.wheelchair_accessible], 'wheelchair_accessible'),
      profile_id: null,
      origin_departure_sec: null,
    });
  });

  // stop_times -> patterns + timing profiles
  const patterns = new Map(); // key -> { id, routeId, stops: [[stop_id, pickup, dropoff]] }
  const profiles = new Map(); // key -> { id, patternId, offsets: [], trips }
  const seenTrips = new Set();
  let curTrip = null;
  let buf = [];
  let arrivalDiffers = 0;

  const finishTrip = () => {
    if (curTrip === null) return;
    const t = trips.get(curTrip);
    if (!t) throw new Error(`stop_times references unknown trip_id ${curTrip}`);
    buf.sort((a, b) => a.seq - b.seq);
    const stopsKey = buf.map((s) => `${s.stop}:${s.pu}:${s.dof}`).join(',');
    const pKey = `${t.route_id}|${stopsKey}`;
    let p = patterns.get(pKey);
    if (!p) {
      p = { id: patterns.size + 1, routeId: t.route_id, stops: buf.map((s) => [s.stop, s.pu, s.dof]) };
      patterns.set(pKey, p);
    }
    const t0 = buf[0].dep;
    const offsets = buf.map((s) => s.dep - t0);
    const prKey = `${p.id}|${offsets.join(',')}`;
    let pr = profiles.get(prKey);
    if (!pr) {
      pr = { id: profiles.size + 1, patternId: p.id, offsets, trips: 0 };
      profiles.set(prKey, pr);
    }
    pr.trips++;
    t.profile_id = pr.id;
    t.origin_departure_sec = t0;
  };

  counts.stop_times = await forEachRow(
    z,
    'stop_times.txt',
    ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
    (r, c) => {
      const tripId = r[c.trip_id];
      if (tripId !== curTrip) {
        finishTrip();
        if (seenTrips.has(tripId)) throw new Error(`stop_times.txt is not grouped by trip_id (${tripId})`);
        seenTrips.add(tripId);
        curTrip = tripId;
        buf = [];
      }
      const dep = timeToSec(r[c.departure_time], 'departure_time');
      if (r[c.arrival_time] !== r[c.departure_time]) arrivalDiffers++;
      buf.push({
        stop: int(r[c.stop_id], 'stop_id'),
        seq: int(r[c.stop_sequence], 'stop_sequence'),
        pu: int(r[c.pickup_type], 'pickup_type') ?? 0,
        dof: int(r[c.drop_off_type], 'drop_off_type') ?? 0,
        dep,
      });
    },
  );
  finishTrip();

  // Offsets are taken from departure_time. Report if arrival ever differs.
  if (arrivalDiffers) warnings.push(`${arrivalDiffers} stop_times rows have arrival_time != departure_time; departure_time was used`);

  const tripRows = [];
  let tripsWithoutStops = 0;
  for (const [id, t] of trips) {
    if (t.profile_id === null) { tripsWithoutStops++; continue; }
    tripRows.push([id, t.route_id, t.service_id, t.profile_id, t.origin_departure_sec, t.headsign, t.direction_id, t.wheelchair]);
  }
  if (tripsWithoutStops) warnings.push(`${tripsWithoutStops} trips have no stop_times and were skipped`);

  const patternList = [...patterns.values()];
  const profileList = [...profiles.values()];

  return {
    counts,
    warnings,
    tables: {
      gtfs_agency: {
        columns: ['agency_id', 'agency_name', 'agency_url', 'agency_phone'],
        rows: agency,
      },
      gtfs_stops: {
        columns: ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'location_type', 'parent_station', 'zone_id'],
        rows: stops,
      },
      gtfs_routes: {
        columns: ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_color'],
        rows: routes,
      },
      gtfs_calendar: {
        columns: ['service_id', ...days, 'start_date', 'end_date'],
        rows: calendar,
      },
      gtfs_patterns: {
        columns: ['pattern_id', 'route_id', 'num_stops'],
        rows: patternList.map((p) => [p.id, p.routeId, p.stops.length]),
      },
      gtfs_pattern_stops: {
        columns: ['pattern_id', 'stop_sequence', 'stop_id', 'pickup_type', 'drop_off_type'],
        rows: patternList.flatMap((p) => p.stops.map(([stop, pu, dof], i) => [p.id, i + 1, stop, pu, dof])),
      },
      gtfs_timing_profiles: {
        columns: ['profile_id', 'pattern_id', 'num_trips'],
        rows: profileList.map((pr) => [pr.id, pr.patternId, pr.trips]),
      },
      gtfs_profile_offsets: {
        columns: ['profile_id', 'stop_sequence', 'offset_sec'],
        rows: profileList.flatMap((pr) => pr.offsets.map((o, i) => [pr.id, i + 1, o])),
      },
      gtfs_trips: {
        columns: ['trip_id', 'route_id', 'service_id', 'profile_id', 'origin_departure_sec', 'trip_headsign', 'direction_id', 'wheelchair_accessible'],
        rows: tripRows,
      },
    },
  };
}

function validateCounts(counts) {
  for (const [file, min] of Object.entries(MIN_ROWS)) {
    if ((counts[file] ?? 0) < min) {
      throw new Error(`${file}.txt has ${counts[file] ?? 0} rows, expected at least ${min}. Feed looks truncated; not loading.`);
    }
  }
}

// ---------- download ----------

async function download() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${ZIP_PATH}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`Downloading ${FEED_URL} (attempt ${attempt})`);
      const res = await fetch(FEED_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const expected = Number(res.headers.get('content-length'));
      const { size } = await fsp.stat(tmp);
      if (expected && size !== expected) throw new Error(`incomplete download: ${size} of ${expected} bytes`);
      await fsp.rename(tmp, ZIP_PATH);
      const lm = res.headers.get('last-modified');
      return { lastModified: lm ? new Date(lm) : null, size };
    } catch (e) {
      log(`Download failed: ${e.message}`);
      await fsp.rm(tmp, { force: true });
      if (attempt === 3) throw e;
      await sleep(attempt * 30_000);
    }
  }
}

async function useExistingFile() {
  const st = await fsp.stat(ZIP_PATH).catch(() => null);
  if (!st) throw new Error(`--skip-download given but ${ZIP_PATH} does not exist`);
  log(`Using existing ${ZIP_PATH}`);
  return { lastModified: st.mtime, size: st.size };
}

// ---------- database ----------

const csvValue = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || s === '' ? `"${s.replace(/"/g, '""')}"` : s;
};

async function copyRows(client, table, columns, rows) {
  const sql = `COPY ${table} (${columns.join(', ')}) FROM STDIN WITH (FORMAT csv)`;
  function* chunks() {
    let batch = [];
    for (const r of rows) {
      batch.push(r.map(csvValue).join(','));
      if (batch.length === 5000) { yield `${batch.join('\n')}\n`; batch = []; }
    }
    if (batch.length) yield `${batch.join('\n')}\n`;
  }
  await pipeline(Readable.from(chunks()), client.query(copyStreams.from(sql)));
}

async function loadStaging(client, tables) {
  await client.query(`DROP SCHEMA IF EXISTS ${STAGING} CASCADE`);
  await client.query(`CREATE SCHEMA ${STAGING}`);
  await client.query(`SET search_path TO ${STAGING}`);
  await client.query(await fsp.readFile(SCHEMA_SQL, 'utf8'));
  await client.query('SET search_path TO public');
  for (const name of TABLES) {
    const { columns, rows } = tables[name];
    log(`COPY ${name}: ${rows.length} rows`);
    await copyRows(client, `${STAGING}.${name}`, columns, rows);
  }
}

async function swapIntoPublic(client) {
  const { rows } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'service_role'`);
  const grantee = rows.length ? 'service_role' : null;

  await client.query('BEGIN');
  try {
    for (const v of VIEWS) await client.query(`DROP VIEW IF EXISTS public.${v}`);
    await client.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `public.${t}`).join(', ')} CASCADE`);
    for (const t of TABLES) await client.query(`ALTER TABLE ${STAGING}.${t} SET SCHEMA public`);
    for (const v of VIEWS) await client.query(`ALTER VIEW ${STAGING}.${v} SET SCHEMA public`);
    await client.query(`DROP SCHEMA ${STAGING}`);
    // Tables created outside public miss Supabase's default grants; give the server key read access
    if (grantee) {
      const all = [...TABLES, ...VIEWS].map((t) => `public.${t}`).join(', ');
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

async function countRows(client) {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${t}`);
    out[t] = rows[0].n;
  }
  return out;
}

function connect() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set in .env');
  // Supabase uses its own CA; the connection is still TLS-encrypted
  return new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function recordFeed(client, entry) {
  await client.query(await fsp.readFile(FEEDS_SQL, 'utf8'));
  await client.query(
    `INSERT INTO public.gtfs_feeds
       (started_at, status, source_url, feed_last_modified, file_size_bytes, row_counts, warnings, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.startedAt,
      entry.status,
      FEED_URL,
      entry.file?.lastModified ?? null,
      entry.file?.size ?? null,
      entry.rowCounts ? JSON.stringify(entry.rowCounts) : null,
      entry.warnings?.length ? JSON.stringify(entry.warnings) : null,
      entry.error ?? null,
    ],
  );
}

// ---------- main ----------

async function main() {
  const startedAt = new Date();
  const skipDownload = process.argv.includes('--skip-download');
  let file = null;
  let warnings = [];
  let client = null;

  try {
    file = skipDownload ? await useExistingFile() : await download();

    log('Reading feed');
    const z = await openZip(ZIP_PATH);
    let data;
    try {
      data = await buildDataset(z);
    } finally {
      z.zip.close();
    }
    warnings = data.warnings;
    validateCounts(data.counts);
    log(`Feed rows: ${JSON.stringify(data.counts)}`);
    for (const w of warnings) log(`WARNING: ${w}`);

    client = connect();
    await client.connect();
    await client.query('SET statement_timeout = 0');

    await loadStaging(client, data.tables);
    log('Swapping staging tables into public');
    await swapIntoPublic(client);

    const rowCounts = await countRows(client);
    for (const t of TABLES) {
      if (rowCounts[t] !== data.tables[t].rows.length) {
        throw new Error(`${t}: loaded ${rowCounts[t]} rows, expected ${data.tables[t].rows.length}`);
      }
    }
    await recordFeed(client, { startedAt, status: 'success', file, rowCounts, warnings });
    log(`Done: ${JSON.stringify(rowCounts)}`);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    try {
      if (!client) { client = connect(); await client.connect(); }
      await client.query(`DROP SCHEMA IF EXISTS ${STAGING} CASCADE`);
      await recordFeed(client, { startedAt, status: 'failed', file, warnings, error: e.message });
    } catch (logErr) {
      log(`Could not record failure in gtfs_feeds: ${logErr.message}`);
    }
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

main();
