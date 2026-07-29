import { createClient, type SupabaseClient } from "supabase";

const DOCUMENT_MEDIA_BUCKETS = [
  "document-images",
  "document-videos",
] as const;

type BucketState = {
  allowedMimeTypes: string[] | null;
  fileSizeLimit: number | null;
  id: string;
  public: boolean;
};

type CliOptions = {
  apply: boolean;
  confirmOrigin?: string;
  makePublic: boolean;
};

function usage() {
  return [
    "Usage:",
    "  deno run --allow-env --allow-net " +
    "supabase/admin/set-document-media-bucket-privacy.ts [options]",
    "",
    "Options:",
    "  --apply                     Apply the requested visibility.",
    "  --confirm-origin=<origin>   Required with --apply; must match SUPABASE_URL.",
    "  --public                    Emergency rollback: make both buckets public.",
    "",
    "Without --apply this tool only reports the planned changes.",
  ].join("\n");
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    makePublic: false,
  };

  for (const argument of args) {
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--public") {
      options.makePublic = true;
    } else if (argument.startsWith("--confirm-origin=")) {
      options.confirmOrigin = argument.slice("--confirm-origin=".length);
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      Deno.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function requireEnvironment(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function normalizeOrigin(value: string) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Supabase URL must contain only scheme, host, and port.");
  }
  return url.origin;
}

async function getBucketStates(client: SupabaseClient) {
  const states: BucketState[] = [];

  for (const bucketId of DOCUMENT_MEDIA_BUCKETS) {
    const { data, error } = await client.storage.getBucket(bucketId);
    if (error || !data) {
      throw new Error(
        `Unable to read ${bucketId}: ${error?.message ?? "not found"}`,
      );
    }
    states.push({
      allowedMimeTypes: data.allowed_mime_types ?? null,
      fileSizeLimit: data.file_size_limit ?? null,
      id: bucketId,
      public: data.public,
    });
  }

  return states;
}

async function updateBucket(
  client: SupabaseClient,
  state: BucketState,
  isPublic: boolean,
) {
  const { error } = await client.storage.updateBucket(state.id, {
    allowedMimeTypes: state.allowedMimeTypes,
    fileSizeLimit: state.fileSizeLimit,
    public: isPublic,
  });
  if (error) {
    throw new Error(`Unable to update ${state.id}: ${error.message}`);
  }
}

async function main() {
  const options = parseOptions(Deno.args);
  const supabaseUrl = requireEnvironment("SUPABASE_URL");
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseOrigin = normalizeOrigin(supabaseUrl);
  const targetPublic = options.makePublic;

  if (options.apply) {
    if (!options.confirmOrigin) {
      throw new Error("--confirm-origin is required with --apply.");
    }
    if (normalizeOrigin(options.confirmOrigin) !== supabaseOrigin) {
      throw new Error("--confirm-origin does not match SUPABASE_URL.");
    }
  }

  const client = createClient(supabaseOrigin, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  if (!targetPublic) {
    const { data: rolloutData, error: rolloutError } = await client.rpc(
      "get_document_media_rollout_state",
    );
    if (rolloutError) {
      throw new Error(
        `Unable to verify rollout phase: ${rolloutError.message}`,
      );
    }
    const rolloutState = Array.isArray(rolloutData)
      ? rolloutData[0]
      : rolloutData;
    if (rolloutState?.phase !== "enforced") {
      throw new Error(
        "Buckets cannot become private until media rollout is enforced.",
      );
    }
  }

  const originalStates = await getBucketStates(client);

  console.log(`Project: ${supabaseOrigin}`);
  for (const state of originalStates) {
    console.log(
      `${state.id}: public=${state.public} -> public=${targetPublic}; ` +
        `file_size_limit=${state.fileSizeLimit}; ` +
        `allowed_mime_types=${JSON.stringify(state.allowedMimeTypes)}`,
    );
  }

  if (!options.apply) {
    console.log("Dry run only; no bucket settings were changed.");
    return;
  }

  const changed: BucketState[] = [];
  try {
    for (const state of originalStates) {
      if (state.public === targetPublic) {
        continue;
      }
      await updateBucket(client, state, targetPublic);
      changed.push(state);
    }
  } catch (updateError) {
    const rollbackErrors: string[] = [];
    for (const state of changed.reverse()) {
      try {
        await updateBucket(client, state, state.public);
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      }
    }
    const updateMessage = updateError instanceof Error
      ? updateError.message
      : String(updateError);
    throw new Error(
      rollbackErrors.length === 0
        ? `${updateMessage}. Earlier bucket changes were rolled back.`
        : `${updateMessage}. Rollback also failed: ${
          rollbackErrors.join("; ")
        }`,
    );
  }

  const verifiedStates = await getBucketStates(client);
  const mismatches = verifiedStates.filter((state) =>
    state.public !== targetPublic
  );
  if (mismatches.length > 0) {
    const rollbackErrors: string[] = [];
    for (const state of changed.reverse()) {
      try {
        await updateBucket(client, state, state.public);
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      }
    }
    throw new Error(
      `Visibility verification failed for: ` +
        `${mismatches.map((state) => state.id).join(", ")}.` +
        (rollbackErrors.length === 0
          ? " Changes were rolled back."
          : ` Rollback also failed: ${rollbackErrors.join("; ")}`),
    );
  }

  console.log(
    `Both document media buckets are now ` +
      `${targetPublic ? "public" : "private"}.`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error("\n" + usage());
    Deno.exitCode = 1;
  }
}
