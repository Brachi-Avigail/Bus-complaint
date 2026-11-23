// One-time (or catch-up) fill of the hist_* tables for past dates, from the daily
// GTFS archive kept by the Public Knowledge Workshop (hasadna / Open Bus Stride).
// The archive file of day D is downloaded at ~02:00 Israel time on D, so it holds
// the plan for D. Does not touch the current gtfs_* tables.
//
// Usage (from Server/):
//   npm run gtfs:backfill                  last 35 days missing from hist_days
//   npm run gtfs:backfill -- --days 10     last 10 days
//   npm run gtfs:backfill -- --date 2026-11-10 [--force]   one date (--force reloads it)
//
// Requires DATABASE_URL. Each archive file is ~140-200MB and is deleted after use.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readFeed, validateCounts, downloadFile, log } from './gtfs/feed.js';
import { connect, israelToday, addDays } from './gtfs/db.js';
import { ensureHistorySchema, snapshotDay, pruneHistory } from './gtfs/history.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ARCHIVE_BASE =
  process.env.GTFS_ARCHIVE_URL || 'https://openbus-stride-public.s3.eu-west-1.amazonaws.com/gtfs_archive';
const HISTORY_DAYS = Number(process.env.GTFS_HISTORY_DAYS || 35);
const DATA_DIR = path.join(ROOT, 'data', 'gtfs');
const HISTORY_SQL = path.join(ROOT, 'db', 'gtfs_history.sql');

const archiveUrl = (dateStr) => `${ARCHIVE_BASE}/${dateStr.replace(/-/g, '/')}/israel-public-transportation.zip`;

function parseArgs(argv) {
  const args = { days: HISTORY_DAYS, date: null, force: argv.includes('--force') };
  const i = argv.indexOf('--days');
  if (i !== -1) args.days = Number(argv[i + 1]);
  const j = argv.indexOf('--date');
  if (j !== -1) args.date = argv[j + 1];
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('--date must be YYYY-MM-DD');
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 60) throw new Error('--days must be 1-60');
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const today = israelToday();
  const client = connect();
  await client.connect();
  await client.query('SET statement_timeout = 0');
  let failures = 0;

  try {
    await ensureHistorySchema(client, HISTORY_SQL);

    let dates;
    if (args.date) {
      dates = [args.date];
    } else {
      dates = [];
      for (let n = args.days; n >= 1; n--) dates.push(addDays(today, -n));
    }
    if (!args.force) {
      const { rows } = await client.query(
        'SELECT service_date::text AS d FROM public.hist_days WHERE service_date = ANY($1::date[])', [dates]);
      const have = new Set(rows.map((r) => r.d));
      dates = dates.filter((d) => !have.has(d));
    }
    log(`Dates to load: ${dates.length ? dates.join(', ') : 'none'}`);

    await fsp.mkdir(DATA_DIR, { recursive: true });
    for (const d of dates) {
      const url = archiveUrl(d);
      const zipPath = path.join(DATA_DIR, `archive-${d}.zip`);
      try {
        const file = await downloadFile(url, zipPath);
        const data = await readFeed(zipPath);
        validateCounts(data.counts);
        await snapshotDay(client, data.model, d, { source: 'archive', sourceUrl: url, lastModified: file.lastModified });
      } catch (e) {
        failures++;
        log(`FAILED ${d}: ${e.message}`);
      } finally {
        await fsp.rm(zipPath, { force: true });
      }
    }

    await pruneHistory(client, addDays(today, -HISTORY_DAYS));
  } finally {
    await client.end().catch(() => {});
  }
  if (failures) {
    log(`${failures} date(s) failed`);
    process.exitCode = 1;
  } else log('Done');
}

main().catch((e) => {
  log(`FAILED: ${e.message}`);
  process.exitCode = 1;
});
