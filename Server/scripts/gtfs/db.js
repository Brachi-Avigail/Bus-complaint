// Shared database helpers for the GTFS scripts

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';

export function connect() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (in .env or the environment)');
  // Supabase uses its own CA; the connection is still TLS-encrypted
  return new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

const csvValue = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || s === '' ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Bulk-loads rows (arrays, in `columns` order) into table with COPY */
export async function copyRows(client, table, columns, rows) {
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

/** Today's date in Israel as YYYY-MM-DD */
export function israelToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

/** dateStr (YYYY-MM-DD) plus n days */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
