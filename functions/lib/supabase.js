const { createClient } = require("@supabase/supabase-js");
const credentials = require("../credentials");

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || credentials.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || credentials.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Configure NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variaveis de ambiente"
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = { getSupabase };
