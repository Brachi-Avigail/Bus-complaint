# Bus Complaint Server

REST API built with Node.js (18+), Express and Supabase.

## Architecture

```
route -> (validate middleware) -> controller -> service -> Supabase
```

- **routes/** – URL + HTTP method mapping, attaches validation.
- **controllers/** – reads `req`, writes `res`. No business logic.
- **services/** – all Supabase access. No Express dependency.
- **schemas/** – zod schemas for input validation.
- **middlewares/** – generic validation, 404, central error handler.
- **utils/** – `AppError` (error with `statusCode`) and `asyncHandler`.

## Setup

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# edit .env and fill SUPABASE_URL and SUPABASE_KEY
npm run dev               # development (nodemon)
npm start                 # production
```

The server refuses to start if a required environment variable is missing.

## Environment variables

| Name           | Required | Description                                         |
| -------------- | -------- | --------------------------------------------------- |
| `PORT`         | no       | Default `3000`                                      |
| `NODE_ENV`     | no       | `development` / `production` / `test`               |
| `SUPABASE_URL` | yes      | Project URL                                         |
| `SUPABASE_KEY` | yes      | `service_role` key. **Server only. Never commit.**  |
| `CORS_ORIGIN`  | no       | `*` or comma-separated list of origins              |

### Where to find the URL and key in Supabase

1. Open https://supabase.com/dashboard and select the project.
2. **Project URL**: Project Settings > Data API (or the "Connect" button) > `https://<ref>.supabase.co`.
3. **service_role key**: Project Settings > API Keys > `service_role` (secret) > Reveal.
   In projects using the new key format, use a **Secret key** (`sb_secret_...`) instead.

## Table

```sql
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  tz          text not null unique,
  phone       text,
  first_name  text,
  last_name   text
);
```

A unique constraint (for example on `tz`) makes duplicates return **409**.
To add columns, update `COLUMNS` in `src/services/users.service.js` and the zod schema in `src/schemas/user.schema.js`.

## Endpoints

| Method | Path             | Success | Errors        |
| ------ | ---------------- | ------- | ------------- |
| GET    | `/health`        | 200     |               |
| GET    | `/api/users`     | 200     | 500           |
| GET    | `/api/users/:id` | 200     | 400, 404      |
| POST   | `/api/users`     | 201     | 400, 409      |
| PUT    | `/api/users/:id` | 200     | 400, 404, 409 |
| DELETE | `/api/users/:id` | 204     | 400, 404      |
| GET    | `/api/stops/:code` | 200   | 400, 404      |

`GET /api/stops/:code` returns the stop name for the number on the stop sign (GTFS `stop_code`,
1-5 digits): `{ "success": true, "data": { "stop_code": 638, "stop_name": "מחלף חמד" } }`.
In code: `getStopNameByCode(638)` from `src/services/stops.service.js`.

Response format:

```json
{ "success": true, "data": { } }
{ "success": false, "message": "Validation failed", "errors": [{ "field": "tz", "message": "..." }] }
```

## curl examples

```bash
curl http://localhost:3000/health

curl http://localhost:3000/api/users

curl http://localhost:3000/api/users/<id>

curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"tz":"123456789","phone":"050-1234567","first_name":"Dana","last_name":"Cohen"}'

curl -X PUT http://localhost:3000/api/users/<id> \
  -H "Content-Type: application/json" \
  -d '{"phone":"052-7654321"}'

curl -X DELETE http://localhost:3000/api/users/<id> -i
```

## Row Level Security (RLS)

- The `service_role` key **bypasses RLS**. With it, the server works even when RLS is enabled and no policies exist.
- Keep RLS **enabled** on the table. Without policies, the public `anon` key cannot read or write anything. That is the safe default.
- If you use the `anon` / publishable key instead, every request is subject to RLS. Without matching policies, selects return empty arrays and writes fail (`42501`, mapped to 403). You then need explicit policies, for example:

```sql
alter table public.users enable row level security;

create policy "server read"   on public.users for select using (true);
create policy "server insert" on public.users for insert with check (true);
create policy "server update" on public.users for update using (true) with check (true);
create policy "server delete" on public.users for delete using (true);
```

These example policies open the table to anyone holding the anon key. Restrict them (for example `to authenticated` with `auth.uid()` checks) before using them in production.

**Never** expose the `service_role` key to a browser or mobile app.

## IVR: Yemot HaMashiach (`/api/ivr`)

Callers dial the system number, hear a welcome prompt and key in their ID (teudat zehut).
The server validates the ID and, at this stage, only logs it. Nothing is stored yet.

```
Yemot (type=api) -> /api/ivr -> rate limit -> ivrAuth -> ivr.controller -> ivr.service -> (future: Supabase)
```

| File | Role |
| ---- | ---- |
| `routes/ivr.routes.js` | Route, rate limit, auth, error handler that always returns a valid Yemot answer |
| `controllers/ivr.controller.js` | Reads `Api*` params (GET query or POST form) and sends the text answer |
| `services/ivr.service.js` | Call flow (state machine) and logging. Place for future Supabase calls |
| `services/idValidator.js` | Israeli ID validation (padding + check digit), `maskId` |
| `services/callStateStore.js` | Failed attempts per `ApiCallId`, in memory, auto-cleanup after 10 minutes |
| `utils/yemotResponse.js` | Builds Yemot commands (`read`, message + hang up). All syntax in one file |
| `middlewares/ivrAuth.js` | Shared secret token and/or IP allow list |
| `config/ivrMessages.js` | All Hebrew prompts |

### Call flow

1. New call -> `read` with the welcome prompt ("... and press # to finish"), variable `ID`, at least 5 digits, no max (input ends with `#`), `*` blocked.
2. Valid `ID` -> play the keyed ID back digit by digit, `read` variable `CONFIRM` (1 digit, only `1` or `2`).
   - `CONFIRM=1` -> log the ID, play a thank-you message, hang up.
   - `CONFIRM=2` -> "key the ID again and press #", back to the `ID` step.
   The current stage is kept per call on the server, because Yemot resends every value collected
   so far (an old `CONFIRM=2` arrives together with the newly keyed `ID`).
3. Invalid `ID` -> "invalid, try again" and `read` again.
   No limit by default. With `IVR_MAX_ATTEMPTS` > 0: after that many wrong attempts in the same call -> goodbye and hang up.
4. `hangup=yes` (sent by Yemot when the caller hangs up) -> empty answer, attempt counter cleared.
5. Any unexpected error -> Hebrew error message and hang up (never a raw 500). Only the error message is logged.

Example answers:

```
read=t-שלום וברוכים הבאים למערכת תלונות אוטובוסים.t-נא הקש מספר תעודת זהות ולסיום הקש סולמית=ID,no,,5,10,No,yes,no
read=t-מספר תעודת הזהות שהוקש הינו.d-123456782.t-לאישור הקש אחת.t-לשינוי הקש שתיים=CONFIRM,no,1,1,7,No,yes,yes,,1.2
id_list_message=t-תודה.t-מספר תעודת הזהות שלך התקבל&go_to_folder=hangup
```

`read` options in order: variable name, reuse existing value (`no` = always ask), max digits, min digits,
timeout seconds, playback type (`No` = no read-back), block `*`, block `0`, replace char, allowed values.
`d-<digits>` plays a number digit by digit.
Source: the official "מודול API" docs, https://f2.freeivr.co.il/topic/56.

The attempt counter lives in process memory. With more than one server instance, move it to shared
storage (Redis or a Supabase table). See `services/callStateStore.js`.

### Environment variables

| Name | Default | Description |
| ---- | ------- | ----------- |
| `IVR_SECRET` | - | Shared secret, at least 16 characters. Yemot must send it as `token` |
| `IVR_ALLOWED_IPS` | - | Optional comma-separated IP allow list (exact match) |
| `LOG_FULL_ID` | `false` | `true` logs the full ID (development only). `false` logs `******782` |
| `IVR_MAX_ATTEMPTS` | `0` | Wrong attempts per call before hanging up. `0` = no limit |
| `TRUST_PROXY` | - | Express `trust proxy` value behind ngrok / a load balancer (for example `1`). Needed for `IVR_ALLOWED_IPS` |

Auth rules: if both `IVR_SECRET` and `IVR_ALLOWED_IPS` are set, both must pass.
If neither is set, `/api/ivr` is open in development and **rejects every request in production**.

### Yemot extension setup (`ext.ini`)

Create a folder (for example `/1`) in the Yemot system and set:

```ini
type=api
api_link=https://your-domain.example/api/ivr
api_add_0=token=<IVR_SECRET value>
; optional: send as POST form instead of GET
; api_url_post=yes
```

- Hangup notifications are sent by default (`hangup=yes`). Do not set `api_hangup_send=no`,
  or the attempt counter is cleared only by the 10-minute timeout.
- To make this the entry point of the system, route the main folder to this folder.

### Run locally with a public tunnel

```bash
npm run dev                               # server on http://localhost:3000
ngrok http 3000                           # or: cloudflared tunnel --url http://localhost:3000
```

Use the HTTPS URL the tunnel prints in `api_link` (for example `https://abcd-1234.ngrok-free.app/api/ivr`).
Set `TRUST_PROXY=1` in `.env` if you use `IVR_ALLOWED_IPS`. Quick tunnel URLs change on every run,
so update `api_link` each time.

### curl examples (simulate Yemot)

```bash
TOKEN=<IVR_SECRET value>

# 1. call starts
curl "http://localhost:3000/api/ivr?token=$TOKEN&ApiCallId=abc123&ApiPhone=0501234567&ApiDID=0771234567&ApiExtension=1&ApiTime=1763460000"

# 2. valid ID -> asks to confirm (1) or change (2)
curl "http://localhost:3000/api/ivr?token=$TOKEN&ApiCallId=abc123&ApiPhone=0501234567&ID=123456782"

# 2b. confirm
curl "http://localhost:3000/api/ivr?token=$TOKEN&ApiCallId=abc123&ApiPhone=0501234567&ID=123456782&CONFIRM=1"

# 3. invalid ID (asks again; hangs up only when IVR_MAX_ATTEMPTS > 0 is reached)
curl "http://localhost:3000/api/ivr?token=$TOKEN&ApiCallId=abc123&ApiPhone=0501234567&ID=123456789"

# 4. caller hung up
curl "http://localhost:3000/api/ivr?token=$TOKEN&ApiCallId=abc123&ApiPhone=0501234567&hangup=yes"

# POST form (api_url_post=yes)
curl -X POST http://localhost:3000/api/ivr \
  -d "token=$TOKEN" -d "ApiCallId=abc123" -d "ApiPhone=0501234567" -d "ID=123456782"
```

### Tests

```bash
npm test     # node:test + supertest: ID validator, response builders, /api/ivr flow
```

### Privacy

An ID number is sensitive personal data. Before storing IDs (or call records linked to them):

- Comply with the Israeli Protection of Privacy Law, 5741-1981, and the Privacy Protection
  (Data Security) Regulations, 2017. This includes a database registration check, a defined purpose,
  access control and retention limits.
- Keep RLS enabled on every table that holds IDs. Consider encrypting the column (for example with
  `pgsodium` / Supabase Vault) or storing a keyed hash (HMAC) for lookups.
- Keep `LOG_FULL_ID=false` in production. Error logs never contain the keyed ID.

> The older `/yemot/incoming` route (welcome message only) still exists and is unchanged.

## GTFS data (Ministry of Transport timetables)

`npm run gtfs:import` downloads the official feed
(`https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip`, ~140MB) and loads it
into Postgres. Requires `DATABASE_URL` in `.env` (see `.env.example`). Takes about 2 minutes.

```bash
npm run gtfs:import                      # download + import
npm run gtfs:import -- --skip-download   # reuse data/gtfs/israel-public-transportation.zip
```

How it works (`scripts/gtfs-import.js`):

1. Downloads to `data/gtfs/` (git-ignored), 3 attempts, checks the size.
2. Reads the zip locally. Refuses to load a feed with suspiciously few rows.
3. `stop_times.txt` (~10M rows, too big for the Supabase free tier) is **not stored**. It is
   compressed into stop patterns and timing profiles. Times are reconstructed exactly.
4. Loads everything into the `gtfs_staging` schema with `COPY` (all foreign keys checked).
5. Swaps the staging tables into `public` in one transaction. On failure the previous data stays.
6. Logs the run in `gtfs_feeds`.

Schema: `db/gtfs_schema.sql` (data tables, replaced on every import) and `db/gtfs_feeds.sql`
(import log, kept).

| Table                  | Content                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `gtfs_agency`          | Operators                                                      |
| `gtfs_stops`           | Stops; `stop_code` is the number on the stop sign              |
| `gtfs_routes`          | Lines (one row per line + direction + alternative)             |
| `gtfs_calendar`        | Days and date range of each `service_id`                       |
| `gtfs_patterns`        | Distinct ordered stop lists of a route                         |
| `gtfs_pattern_stops`   | Stops of a pattern in order (`stop_sequence` 1..n)             |
| `gtfs_timing_profiles` | Distinct timings of a pattern                                  |
| `gtfs_profile_offsets` | Seconds after the origin departure at each stop               |
| `gtfs_trips`           | Trips; `origin_departure_sec` = departure from the first stop  |
| `gtfs_feeds`           | Import log                                                     |

View `gtfs_trip_stop_times` gives the planned time of every trip at every stop.
All times are **seconds after midnight** of the service day and can exceed 24h (after-midnight trips).

```sql
-- Lines that stop at stop sign 638, with planned times
select r.route_short_name, a.agency_name,
       to_char(make_interval(secs => v.departure_sec), 'HH24:MI') as planned
from gtfs_trip_stop_times v
join gtfs_stops  s using (stop_id)
join gtfs_routes r using (route_id)
join gtfs_agency a using (agency_id)
where s.stop_code = 638
order by v.departure_sec;
```

Notes:

- Every import **drops and recreates** the `gtfs_*` data tables (`DROP ... CASCADE`). Do not add
  foreign keys from other tables (for example complaints) to them. Copy the values instead.
- `route_id` / `trip_id` / `stop_id` can change between feeds. Store `stop_code`, line number and
  operator in complaints.
- RLS is enabled with no policies; only the server key (`service_role`) can read the tables.
- The DB connection uses TLS without CA verification (`rejectUnauthorized: false`), because
  Supabase uses its own CA.

### History (planned schedule of the last 35 days)

The `gtfs_*` tables only hold the current feed, which covers today and the coming weeks.
For past dates, every import also saves **today's** plan into the `hist_*` tables
(`db/gtfs_history.sql`, never dropped), and deletes days older than `GTFS_HISTORY_DAYS` (default 35).

Rows are content-addressed (`content_hash` = md5 of the content, as uuid; rows reference each other
by short integer `*_key`s). An unchanged stop, route, stop
list, timing, trip or service group is stored once, however many days use it. Each day only adds
`hist_service_days` rows (~10k): which service groups ran on that date. `hist_days` lists the
covered dates and the file each came from.

```sql
-- Planned departures of line 480 from stop sign 4170 on 2026-11-10 (local time)
select planned_at, agency_name, route_long_name
from gtfs_planned_departures('2026-11-10', 4170, '480');

-- Is the date covered at all? (no rows above + not covered = unknown, not "no trip")
select * from hist_days where service_date = '2026-11-10';
```

From Node: `supabase.rpc('gtfs_planned_departures', { p_date, p_stop_code, p_line })`.
`p_line` = `null` returns all lines at the stop. Trips after midnight that belong to the previous
service day (GTFS times >= 24:00) are included under the calendar date they actually run.

Past days come from the daily GTFS archive of the Public Knowledge Workshop (Open Bus Stride):
`https://openbus-stride-public.s3.eu-west-1.amazonaws.com/gtfs_archive/YYYY/MM/DD/israel-public-transportation.zip`.

```bash
npm run gtfs:backfill                          # load missing days of the last 35
npm run gtfs:backfill -- --days 10             # only the last 10 days
npm run gtfs:backfill -- --date 2026-11-10 --force   # reload one date
```

### Nightly run (GitHub Actions)

`.github/workflows/gtfs-nightly.yml` (repository root) runs every night at 01:00 UTC
(03:00 Israel winter time, 04:00 summer): `npm run gtfs:import`. Past days are not filled
automatically; a night that failed can be filled by hand with `npm run gtfs:backfill -- --date YYYY-MM-DD`.

- Needs the repository secret `DATABASE_URL` (Settings > Secrets and variables > Actions).
- Scheduled workflows run only from the default branch (`main`).
- Manual run: Actions > GTFS nightly import > Run workflow.
- A failed run makes GitHub email the repository owner; every run is also logged in `gtfs_feeds`.
- If `gtfs.mot.gov.il` refuses the download (it may block servers abroad), the import uses
  today's copy from the archive above.
