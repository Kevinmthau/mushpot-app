import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import {
  DOCUMENT_CONTENT_FORMATS_CAPABILITY,
  DOCUMENT_CONTENT_FORMATS_HEADER,
} from "@/lib/page-document";
import type { Database } from "@/lib/supabase/types";

export async function createSupabaseServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        [DOCUMENT_CONTENT_FORMATS_HEADER]: DOCUMENT_CONTENT_FORMATS_CAPABILITY,
      },
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot always set cookies.
        }
      },
    },
  });
}
