// Reading a GTFS feed zip: download, parse, and compress stop_times into
// stop patterns + timing profiles. No database access here.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// A feed below these counts is treated as truncated and is not loaded
const MIN_ROWS = { agency: 10, stops: 10000, routes: 2000, calendar: 1000, trips: 50000, stop_times: 1000000 };

export const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
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

// ---------- download ----------

/**
 * Downloads url to dest (via dest.part, renamed on success). 3 attempts.
 * @returns {Promise<{lastModified: Date|null, size: number}>}
 */
export async function downloadFile(url, dest) {
  const tmp = `${dest}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`Downloading ${url} (attempt ${attempt})`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const expected = Number(res.headers.get('content-length'));
      const { size } = await fsp.stat(tmp);
      if (expected && size !== expected) throw new Error(`incomplete download: ${size} of ${expected} bytes`);
      await fsp.rename(tmp, dest);
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

  const agency = new Map();
  counts.agency = await forEachRow(z, 'agency.txt', ['agency_id', 'agency_name'], (r, c) => {
    const a = {
      agency_id: int(r[c.agency_id], 'agency_id'),
      agency_name: txt(r[c.agency_name]),
      agency_url: txt(r[c.agency_url]),
      agency_phone: txt(r[c.agency_phone]),
    };
    agency.set(a.agency_id, a);
  });

  const stops = new Map();
  counts.stops = await forEachRow(z, 'stops.txt', ['stop_id', 'stop_code', 'stop_name'], (r, c) => {
    const s = {
      stop_id: int(r[c.stop_id], 'stop_id'),
      stop_code: int(r[c.stop_code], 'stop_code'),
      stop_name: txt(r[c.stop_name]),
      stop_desc: txt(r[c.stop_desc]),
      stop_lat: num(r[c.stop_lat]),
      stop_lon: num(r[c.stop_lon]),
      location_type: int(r[c.location_type], 'location_type'),
      parent_station: int(r[c.parent_station], 'parent_station'),
      zone_id: txt(r[c.zone_id]),
    };
    stops.set(s.stop_id, s);
  });

  const routes = new Map();
  counts.routes = await forEachRow(z, 'routes.txt', ['route_id', 'agency_id', 'route_short_name', 'route_type'], (r, c) => {
    const rt = {
      route_id: int(r[c.route_id], 'route_id'),
      agency_id: int(r[c.agency_id], 'agency_id'),
      route_short_name: txt(r[c.route_short_name]),
      route_long_name: txt(r[c.route_long_name]),
      route_desc: txt(r[c.route_desc]),
      route_type: int(r[c.route_type], 'route_type'),
      route_color: txt(r[c.route_color]),
    };
    routes.set(rt.route_id, rt);
  });

  const calendar = [];
  counts.calendar = await forEachRow(z, 'calendar.txt', ['service_id', ...DAYS, 'start_date', 'end_date'], (r, c) => {
    const cal = { service_id: int(r[c.service_id], 'service_id') };
    for (const d of DAYS) cal[d] = bool(r[c[d]]);
    cal.start_date = gtfsDate(r[c.start_date], 'start_date');
    cal.end_date = gtfsDate(r[c.end_date], 'end_date');
    calendar.push(cal);
  });

  const trips = new Map();
  counts.trips = await forEachRow(z, 'trips.txt', ['route_id', 'service_id', 'trip_id'], (r, c) => {
    trips.set(r[c.trip_id], {
      trip_id: r[c.trip_id],
      route_id: int(r[c.route_id], 'route_id'),
      service_id: int(r[c.service_id], 'service_id'),
      trip_headsign: txt(r[c.trip_headsign]),
      direction_id: int(r[c.direction_id], 'direction_id'),
      wheelchair_accessible: int(r[c.wheelchair_accessible], 'wheelchair_accessible'),
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

  const tripList = [];
  let tripsWithoutStops = 0;
  for (const t of trips.values()) {
    if (t.profile_id === null) tripsWithoutStops++;
    else tripList.push(t);
  }
  if (tripsWithoutStops) warnings.push(`${tripsWithoutStops} trips have no stop_times and were skipped`);

  return {
    counts,
    warnings,
    model: {
      agency,
      stops,
      routes,
      calendar,
      patterns: new Map([...patterns.values()].map((p) => [p.id, p])),
      profiles: new Map([...profiles.values()].map((p) => [p.id, p])),
      trips: tripList,
    },
  };
}

/** Opens a feed zip and builds the in-memory model. */
export async function readFeed(zipPath) {
  const z = await openZip(zipPath);
  try {
    return await buildDataset(z);
  } finally {
    z.zip.close();
  }
}

export function validateCounts(counts) {
  for (const [file, min] of Object.entries(MIN_ROWS)) {
    if ((counts[file] ?? 0) < min) {
      throw new Error(`${file}.txt has ${counts[file] ?? 0} rows, expected at least ${min}. Feed looks truncated; not loading.`);
    }
  }
}

/** service_ids that run on dateStr (YYYY-MM-DD) according to calendar.txt */
export function activeServiceIds(calendar, dateStr) {
  const day = DAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
  const out = new Set();
  for (const c of calendar) {
    if (c.start_date <= dateStr && dateStr <= c.end_date && c[day]) out.add(c.service_id);
  }
  return out;
}
