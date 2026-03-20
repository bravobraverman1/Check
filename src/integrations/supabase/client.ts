import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/config/publicEnv";

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

declare global {
  interface Window {
    __lightingstyleSupabaseClient__?: SupabaseClient<Database>;
  }
}

function canUseBrowserStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function createSupabaseBrowserClient(): SupabaseClient<Database> {
  const hasBrowserStorage = canUseBrowserStorage();
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: hasBrowserStorage ? window.localStorage : undefined,
      persistSession: hasBrowserStorage,
      autoRefreshToken: hasBrowserStorage,
      detectSessionInUrl: hasBrowserStorage,
    },
  });
}

const globalBrowserScope = typeof window !== "undefined" ? window : undefined;

export const supabase =
  globalBrowserScope?.__lightingstyleSupabaseClient__ ??
  createSupabaseBrowserClient();

if (globalBrowserScope) {
  globalBrowserScope.__lightingstyleSupabaseClient__ = supabase;
}
