import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Single shared Supabase client (ES modules are cached, so this runs once)
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
  auth: {
    // Server-side usage: no session persistence or token refresh needed
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
