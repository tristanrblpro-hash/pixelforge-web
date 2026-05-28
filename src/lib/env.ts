// Server-side env access with validation. Throws clearly when something is missing
// so route handlers fail loudly during dev instead of silently 500-ing.

function readRequired(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function readOptional(name: string): string | null {
  return process.env[name] || null;
}

export const env = {
  // Public (frontend-safe) — also available to client code through process.env
  supabaseUrl: readRequired("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: readRequired("NEXT_PUBLIC_SUPABASE_ANON_KEY"),

  // Server-only secrets
  kieApiKey: readOptional("KIE_API_KEY"),
  anthropicApiKey: readOptional("ANTHROPIC_API_KEY"),
  supabaseServiceRoleKey: readOptional("SUPABASE_SERVICE_ROLE_KEY"),
};

// Helper for /api/health — never throws, just reports presence.
export function readKeyStatus() {
  return {
    kie: Boolean(process.env.KIE_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    supabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnon: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
