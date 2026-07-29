import { createClient } from "supabase";

import {
  createSupabaseMaintenanceOperations,
  handleMaintenanceRequest,
} from "./maintenance.ts";

Deno.serve((request) =>
  handleMaintenanceRequest(request, {
    createOperations: () => {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error("Missing Supabase service environment variables.");
      }

      return createSupabaseMaintenanceOperations(
        createClient(supabaseUrl, serviceRoleKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
        }),
      );
    },
    getEnvironmentValue: (name) => Deno.env.get(name),
  })
);
