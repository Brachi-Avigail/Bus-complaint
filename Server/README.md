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
