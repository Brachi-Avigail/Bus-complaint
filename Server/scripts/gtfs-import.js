// Nightly GTFS import for the Israel Ministry of Transport feed.
//
// 1. Downloads israel-public-transportation.zip (3 attempts).
// 2. Reads it locally. stop_times.txt (~10M rows) is too large for the
//    database, so it is compressed here into stop patterns + timing profiles.
// 3. Replaces the current-schedule tables gtfs_* (staging schema + one-transaction
//    swap; on failure the previous data stays).
// 4. Saves today's planned schedule into the hist_* tables (only new content is
//    inserted) and deletes history older than GTFS_HISTORY_DAYS (default 35).
// 5. Records the run in public.gtfs_feeds.
//
// Usage (from Server/):
//   npm run gtfs:import                       download + import
//   npm run gtfs:import -- --skip-download    reuse data/gtfs/israel-public-transportation.zip
//
// Requires DATABASE_URL (in .env locally, or as an environment variable in CI).
// Exit code 1 on failure.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readFeed, validateCounts, downloadFile, log } from './gtfs/feed.js';
import { connect, israelToday, addDays } from './gtfs/db.js';
import { replaceCurrent } from './gtfs/current.js';
import { ensureHistorySchema, snapshotDay, pruneHistory } from './gtfs/history.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const FEED_URL =
  process.env.GTFS_URL || 'https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip';
const ARCHIVE_BASE =
  process.env.GTFS_ARCHIVE_URL || 'https://openbus-stride-public.s3.eu-west-1.amazonaws.com/gtfs_archive';
const HISTORY_DAYS = Number(process.env.GTFS_HISTORY_DAYS || 35);
const DATA_DIR = path.join(ROOT, 'data', 'gtfs');
const ZIP_PATH = path.join(DATA_DIR, 'israel-public-transportation.zip');
const SCHEMA_SQL = path.join(ROOT, 'db', 'gtfs_schema.sql');
const FEEDS_SQL = path.join(ROOT, 'db', 'gtfs_feeds.sql');
const HISTORY_SQL = path.join(ROOT, 'db', 'gtfs_history.sql');

async function useExistingFile() {
  const st = await fsp.stat(ZIP_PATH).catch(() => null);
  if (!st) throw new Error(`--skip-download given but ${ZIP_PATH} does not exist`);
  log(`Using existing ${ZIP_PATH}`);
  return { lastModified: st.mtime, size: st.size };
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
      entry.file?.url ?? FEED_URL,
      entry.file?.lastModified ?? null,
      entry.file?.size ?? null,
      entry.rowCounts ? JSON.stringify(entry.rowCounts) : null,
      entry.warnings?.length ? JSON.stringify(entry.warnings) : null,
      entry.error ?? null,
    ],
  );
}

async function main() {
  const startedAt = new Date();
  const skipDownload = process.argv.includes('--skip-download');
  const today = israelToday();
  let file = null;
  let warnings = [];
  let client = null;

  try {
    if (skipDownload) {
      file = await useExistingFile();
    } else {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      try {
        file = await downloadFile(FEED_URL, ZIP_PATH);
      } catch (e) {
        // gtfs.mot.gov.il may refuse some networks (e.g. CI runners abroad).
        // Fall back to today's copy in the hasadna archive (taken ~02:00 Israel time).
        const fallback = `${ARCHIVE_BASE}/${today.replace(/-/g, '/')}/israel-public-transportation.zip`;
        warnings.push(`MOT download failed (${e.message}); used archive ${fallback}`);
        log(`MOT download failed, falling back to ${fallback}`);
        file = await downloadFile(fallback, ZIP_PATH);
        file.url = fallback;
      }
    }

    log('Reading feed');
    const data = await readFeed(ZIP_PATH);
    warnings = data.warnings;
    validateCounts(data.counts);
    log(`Feed rows: ${JSON.stringify(data.counts)}`);
    for (const w of warnings) log(`WARNING: ${w}`);

    client = connect();
    await client.connect();
    await client.query('SET statement_timeout = 0');

    const current = await replaceCurrent(client, data.model, SCHEMA_SQL);
    log(`Current tables: ${JSON.stringify(current)}`);

    await ensureHistorySchema(client, HISTORY_SQL);
    const history = await snapshotDay(client, data.model, today, {
      source: file.url ? 'archive' : 'mot',
      sourceUrl: file.url ?? FEED_URL,
      lastModified: file.lastModified,
    });
    const pruned = await pruneHistory(client, addDays(today, -HISTORY_DAYS));

    await recordFeed(client, {
      startedAt, status: 'success', file, warnings,
      rowCounts: { current, history, pruned },
    });
    log('Done');
  } catch (e) {
    log(`FAILED: ${e.message}`);
    try {
      if (!client) { client = connect(); await client.connect(); }
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
