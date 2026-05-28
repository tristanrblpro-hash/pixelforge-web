// Server-only Supabase client that uses the service_role key to bypass RLS.
// Use it from Route Handlers when the operation should not be limited by row-level
// policies (writing batches, persisting KIE outputs, etc.). NEVER import this from
// client components — the service_role key must stay on the server.

import { createClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
