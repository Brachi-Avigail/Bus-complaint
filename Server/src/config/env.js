import 'dotenv/config';
import { z } from 'zod';

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
