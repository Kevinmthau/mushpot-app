import { createClient } from "supabase";

import {
  handleSharedDocumentRequest,
  type SharedDocumentOperations,
  type SharedDocumentRow,
} from "./handler.ts";

Deno.serve((request) =>
  handleSharedDocumentRequest(request, {
    createOperations: (supabaseUrl, serviceRoleKey) => {
      const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });

      return {
        createSignedUrl: (bucket, path, expiresIn) =>
          adminClient.storage.from(bucket).createSignedUrl(path, expiresIn),
        getSharedDocument: async (docId, token) => {
          const { data, error } = await adminClient
            .from("documents")
            .select("owner, title, content, updated_at")
            .eq("id", docId)
            .eq("share_enabled", true)
            .eq("share_token", token)
            .maybeSingle();

          return {
            data: data as SharedDocumentRow | null,
            error,
          };
        },
      } satisfies SharedDocumentOperations;
    },
    getEnvironmentValue: (name) => Deno.env.get(name),
  })
);
