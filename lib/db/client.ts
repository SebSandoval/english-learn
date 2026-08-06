import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import type { Database } from "@/lib/db/types";

let client: SupabaseClient<Database> | null = null;

/**
 * Server-side client using the secret key: it bypasses RLS.
 *
 * It must NEVER reach the client bundle — hence the `server-only` import, which
 * breaks the build if a client component ever imports it by mistake.
 */
export function db(): SupabaseClient<Database> {
  if (!client) {
    client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
