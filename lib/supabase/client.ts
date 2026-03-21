import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/types";

export type SupabaseBrowserClient = ReturnType<typeof createBrowserClient<Database>>;

let browserClient: SupabaseBrowserClient | null = null;
let browserClientPromise: Promise<SupabaseBrowserClient> | null = null;

export function createSupabaseBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  if (!browserClient) {
    browserClient = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey, {
      auth: {
        detectSessionInUrl: true,
      },
    });
  }

  return browserClient;
}

export async function getSupabaseBrowserClient() {
  if (!browserClientPromise) {
    browserClientPromise = Promise.resolve(createSupabaseBrowserClient());
  }

  return browserClientPromise;
}
