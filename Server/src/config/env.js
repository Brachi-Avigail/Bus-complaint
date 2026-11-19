import 'dotenv/config';
import { z } from 'zod';

// Treat empty values ("VAR=" in .env) as not set
const emptyToUndefined = (v) => (v === '' ? undefined : v);

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

// Schema for all environment variables the app depends on
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_KEY: z.string().min(1, 'SUPABASE_KEY is required'),
  CORS_ORIGIN: z.string().default('*'),

  // Yemot HaMashiach IVR
  YEMOT_WELCOME_TEXT: z.string().min(1).default('שלום ברכי ממן היקרה ברוכה הבאה למערכת תלונות אוטובוסים'),
  YEMOT_ERROR_TEXT: z.string().min(1).default('אירעה שגיאה אנא נסו שוב מאוחר יותר'),
  // Optional: if set, every Yemot request must include ?key=<value> (api_add_0=key=<value>)
  YEMOT_API_SECRET: z.string().optional(),

  // IVR (/api/ivr)
  // Shared secret sent by Yemot as ?token=<value> (ext.ini: api_add_0=token=<value>)
  IVR_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(16, 'IVR_SECRET must be at least 16 characters').optional()
  ),
  // Optional comma-separated list of allowed caller IPs (exact match)
  IVR_ALLOWED_IPS: z.preprocess(
    (v) => emptyToUndefined(v) ?? '',
    z.string().transform((v) => v.split(',').map((ip) => ip.trim()).filter(Boolean))
  ),
  // true = log full ID (development only), false = masked (******123)
  LOG_FULL_ID: z.preprocess(emptyToUndefined, booleanString),
  // Wrong ID attempts per call before hanging up. 0 = no limit (default)
  IVR_MAX_ATTEMPTS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(10).default(0)),
  // Express "trust proxy" (needed behind ngrok / a load balancer for correct req.ip). e.g. 1, true
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().optional()),
});

const parsed = envSchema.safeParse(process.env);

// Fail fast: refuse to start if a variable is missing or invalid
if (!parsed.success) {
  console.error('Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

// IVR auth fails closed in production when nothing is configured (users API keeps working)
if (env.NODE_ENV === 'production' && !env.IVR_SECRET && env.IVR_ALLOWED_IPS.length === 0) {
  console.warn('IVR_SECRET / IVR_ALLOWED_IPS not set: /api/ivr will reject all requests');
}
if (env.NODE_ENV === 'production' && env.LOG_FULL_ID) {
  console.warn('LOG_FULL_ID=true in production: full ID numbers will be written to logs');
}
