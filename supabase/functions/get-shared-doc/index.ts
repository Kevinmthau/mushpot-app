import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";

type SharedDocPayload = {
  docId: string;
  token: string;
};

type DocumentRow = {
  title: string;
  content: string;
  updated_at: string;
  share_enabled: boolean;
  share_token: string | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase environment variables." }, 500);
  }

  let payload: SharedDocPayload;

  try {
    payload = (await request.json()) as SharedDocPayload;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const docId = typeof payload.docId === "string" ? payload.docId : "";
  const token = typeof payload.token === "string" ? payload.token : "";

  if (!docId || !token) {
    return jsonResponse({ error: "docId and token are required." }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await adminClient
    .from("documents")
    .select("title, content, updated_at, share_enabled, share_token")
    .eq("id", docId)
    .maybeSingle<DocumentRow>();

  if (error || !data) {
    return jsonResponse({ error: "Document not found." }, 404);
  }

  if (!data.share_enabled || !data.share_token || data.share_token !== token) {
    return jsonResponse({ error: "Invalid or expired share link." }, 404);
  }

  return jsonResponse({
    title: data.title,
    content: data.content,
    updated_at: data.updated_at,
  });
});
