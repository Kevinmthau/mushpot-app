import { createClient, type SupabaseClient } from "supabase";

import {
  analyzeDocumentMedia,
  type MediaCopy,
  type MediaReference,
} from "./document-media-backfill.ts";

type DocumentRow = {
  content: string;
  id: string;
  owner: string;
  updated_at: string;
};

type RolloutPhase = "backfill" | "enforced" | "frozen";

type CliOptions = {
  apply: boolean;
  confirmOrigin?: string;
  finalize: boolean;
  pageSize: number;
  setPhase?: RolloutPhase;
};

type DocumentPlan = {
  blockers: string[];
  copies: MediaCopy[];
  document: DocumentRow;
  references: MediaReference[];
  rewrittenContent: string;
};

type PassSummary = {
  blockers: string[];
  copiedObjects: number;
  documentsChanged: number;
  documentsScanned: number;
};

const DEFAULT_PAGE_SIZE = 100;

function usage() {
  return [
    "Usage:",
    "  deno run --allow-env --allow-net supabase/admin/backfill-document-media.ts [options]",
    "",
    "Options:",
    "  --apply                         Write snapshots, copy media, and update documents.",
    "  --confirm-origin=<origin>       Required with --apply; must equal SUPABASE_URL origin.",
    "  --finalize                      Freeze writes, apply, audit, then enable enforcement.",
    "  --set-phase=backfill|frozen     Explicitly pause/resume client writes.",
    "  --page-size=<1-1000>            Document page size (default 100).",
    "",
    "Without --apply this tool performs a read-only audit.",
  ].join("\n");
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    finalize: false,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  for (const argument of args) {
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--finalize") {
      options.finalize = true;
    } else if (argument.startsWith("--confirm-origin=")) {
      options.confirmOrigin = argument.slice("--confirm-origin=".length);
    } else if (argument.startsWith("--page-size=")) {
      options.pageSize = Number(argument.slice("--page-size=".length));
    } else if (argument.startsWith("--set-phase=")) {
      const phase = argument.slice("--set-phase=".length);
      if (phase !== "backfill" && phase !== "frozen") {
        throw new Error(
          "Use --finalize to enter enforced mode; --set-phase accepts backfill or frozen.",
        );
      }
      options.setPhase = phase;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      Deno.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (
    !Number.isInteger(options.pageSize) || options.pageSize < 1 ||
    options.pageSize > 1_000
  ) {
    throw new Error("--page-size must be an integer from 1 through 1000.");
  }
  if ((options.finalize || options.setPhase) && !options.apply) {
    throw new Error("--finalize and --set-phase require --apply.");
  }
  if (options.finalize && options.setPhase) {
    throw new Error("--finalize cannot be combined with --set-phase.");
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

async function setRolloutState(
  client: SupabaseClient,
  phase: RolloutPhase,
  supabaseOrigin: string,
) {
  const { data, error } = await client.rpc(
    "set_document_media_rollout_state",
    {
      p_phase: phase,
      p_supabase_origin: supabaseOrigin,
    },
  );
  if (error) {
    throw new Error(`Unable to set rollout phase: ${error.message}`);
  }
  const state = Array.isArray(data) ? data[0] : data;
  console.log(
    `Rollout phase: ${state?.phase ?? phase}; origin: ` +
      `${state?.supabase_origin ?? supabaseOrigin}`,
  );
}

async function getRolloutState(client: SupabaseClient) {
  const { data, error } = await client.rpc(
    "get_document_media_rollout_state",
  );
  if (error) {
    throw new Error(`Unable to read rollout phase: ${error.message}`);
  }
  const state = Array.isArray(data) ? data[0] : data;
  if (!state) {
    throw new Error("Document media rollout state is missing.");
  }
  return state as {
    phase: RolloutPhase;
    supabase_origin: string | null;
  };
}

async function inspectObject(
  client: SupabaseClient,
  reference: MediaReference,
) {
  const { data, error } = await client.storage
    .from(reference.bucket)
    .info(reference.path);
  if (error || !data) {
    return {
      blocker:
        `Missing or inaccessible object ${reference.bucket}/${reference.path}: ` +
        `${error?.message ?? "not found"}`,
    };
  }
  return { info: data };
}

async function buildDocumentPlan(
  client: SupabaseClient,
  document: DocumentRow,
  supabaseOrigin: string,
): Promise<DocumentPlan> {
  const analysis = analyzeDocumentMedia({
    content: document.content,
    documentId: document.id,
    ownerId: document.owner,
    supabaseUrl: supabaseOrigin,
  });
  const blockers = [...analysis.blockers];
  const sourceInfo = new Map<
    string,
    Awaited<ReturnType<typeof inspectObject>>
  >();

  for (const reference of analysis.references) {
    const key = `${reference.bucket}\0${reference.path}`;
    const inspected = await inspectObject(client, reference);
    sourceInfo.set(key, inspected);
    if (inspected.blocker) {
      blockers.push(inspected.blocker);
    }
  }

  for (const copy of analysis.copies) {
    const source = sourceInfo.get(`${copy.bucket}\0${copy.sourcePath}`);
    if (!source?.info) {
      continue;
    }

    const { data: destinationExists } = await client.storage
      .from(copy.bucket)
      .exists(copy.destinationPath);
    if (!destinationExists) {
      continue;
    }

    const { data: destinationInfo, error: destinationError } = await client
      .storage.from(copy.bucket).info(copy.destinationPath);
    if (destinationError || !destinationInfo) {
      blockers.push(
        `Unable to inspect existing destination ` +
          `${copy.bucket}/${copy.destinationPath}: ` +
          `${destinationError?.message ?? "unknown error"}`,
      );
      continue;
    }

    if (
      source.info.etag !== destinationInfo.etag ||
      source.info.size !== destinationInfo.size
    ) {
      blockers.push(
        `Destination already exists with different content: ` +
          `${copy.bucket}/${copy.destinationPath}`,
      );
    }
  }

  return {
    blockers,
    copies: analysis.copies,
    document,
    references: analysis.references,
    rewrittenContent: analysis.rewrittenContent,
  };
}

async function snapshotPlan(client: SupabaseClient, plan: DocumentPlan) {
  const { error } = await client
    .from("document_media_backfill_snapshots")
    .upsert(
      {
        copied_paths: plan.copies.map((copy) => ({
          bucket: copy.bucket,
          path: copy.destinationPath,
        })),
        document_id: plan.document.id,
        original_content: plan.document.content,
        original_updated_at: plan.document.updated_at,
        owner: plan.document.owner,
      },
      {
        ignoreDuplicates: true,
        onConflict: "document_id,original_updated_at",
      },
    );
  if (error) {
    throw new Error(`Unable to snapshot document: ${error.message}`);
  }
}

async function applyPlan(client: SupabaseClient, plan: DocumentPlan) {
  await snapshotPlan(client, plan);
  let copiedObjects = 0;

  for (const copy of plan.copies) {
    const { data: destinationExists } = await client.storage
      .from(copy.bucket)
      .exists(copy.destinationPath);
    if (destinationExists) {
      continue;
    }

    const { error } = await client.storage
      .from(copy.bucket)
      .copy(copy.sourcePath, copy.destinationPath);
    if (error) {
      throw new Error(
        `Unable to copy ${copy.bucket}/${copy.sourcePath} to ` +
          `${copy.destinationPath}: ${error.message}`,
      );
    }
    copiedObjects += 1;
  }

  if (plan.rewrittenContent === plan.document.content) {
    return { copiedObjects, documentChanged: false };
  }

  const { data, error } = await client
    .from("documents")
    .update({ content: plan.rewrittenContent })
    .eq("id", plan.document.id)
    .eq("updated_at", plan.document.updated_at)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Unable to update document: ${error.message}`);
  }
  if (!data) {
    throw new Error("Document changed during backfill; retry the pass.");
  }

  return { copiedObjects, documentChanged: true };
}

async function runPass(
  client: SupabaseClient,
  supabaseOrigin: string,
  pageSize: number,
  apply: boolean,
): Promise<PassSummary> {
  const summary: PassSummary = {
    blockers: [],
    copiedObjects: 0,
    documentsChanged: 0,
    documentsScanned: 0,
  };
  let lastId: string | null = null;

  for (;;) {
    let query = client
      .from("documents")
      .select("id, owner, content, updated_at")
      .order("id", { ascending: true })
      .limit(pageSize);
    if (lastId) {
      query = query.gt("id", lastId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Unable to load documents: ${error.message}`);
    }
    const documents = (data ?? []) as DocumentRow[];
    if (documents.length === 0) {
      break;
    }

    for (const document of documents) {
      summary.documentsScanned += 1;
      const plan = await buildDocumentPlan(
        client,
        document,
        supabaseOrigin,
      );

      if (plan.blockers.length > 0) {
        summary.blockers.push(
          ...plan.blockers.map((blocker) => `${document.id}: ${blocker}`),
        );
        continue;
      }

      const needsChange = plan.copies.length > 0 ||
        plan.rewrittenContent !== document.content;
      if (!needsChange) {
        continue;
      }

      if (!apply) {
        summary.copiedObjects += plan.copies.length;
        summary.documentsChanged += 1;
        continue;
      }

      try {
        const result = await applyPlan(client, plan);
        summary.copiedObjects += result.copiedObjects;
        if (result.documentChanged) {
          summary.documentsChanged += 1;
        }
      } catch (applyError) {
        const message = applyError instanceof Error
          ? applyError.message
          : "Unknown apply error.";
        summary.blockers.push(`${document.id}: ${message}`);
      }
    }

    lastId = documents.at(-1)?.id ?? null;
    if (documents.length < pageSize) {
      break;
    }
  }

  return summary;
}

function printSummary(label: string, summary: PassSummary) {
  console.log(`\n${label}`);
  console.log(`Documents scanned: ${summary.documentsScanned}`);
  console.log(`Documents changed/planned: ${summary.documentsChanged}`);
  console.log(`Objects copied/planned: ${summary.copiedObjects}`);
  console.log(`Blockers: ${summary.blockers.length}`);
  for (const blocker of summary.blockers) {
    console.error(`- ${blocker}`);
  }
}

async function main() {
  const options = parseOptions(Deno.args);
  const supabaseUrl = requireEnvironment("SUPABASE_URL");
  const serviceRoleKey = requireEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseOrigin = normalizeOrigin(supabaseUrl);

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
  const state = await getRolloutState(client);
  console.log(
    `Current rollout phase: ${state.phase}; configured origin: ` +
      `${state.supabase_origin ?? "not set"}`,
  );

  if (options.setPhase) {
    await setRolloutState(client, options.setPhase, supabaseOrigin);
    return;
  }

  if (options.apply) {
    const { error } = await client
      .from("document_media_backfill_snapshots")
      .delete()
      .lt("expires_at", new Date().toISOString());
    if (error) {
      throw new Error(`Unable to expire old snapshots: ${error.message}`);
    }
  }

  if (options.finalize) {
    if (state.phase !== "backfill" && state.phase !== "frozen") {
      throw new Error("Finalization requires backfill or frozen phase.");
    }
    if (state.phase === "backfill") {
      await setRolloutState(client, "frozen", supabaseOrigin);
    }

    const applied = await runPass(
      client,
      supabaseOrigin,
      options.pageSize,
      true,
    );
    printSummary("Final apply pass", applied);
    if (applied.blockers.length > 0) {
      throw new Error(
        "Finalization is blocked; writes remain frozen until corrected.",
      );
    }

    const audit = await runPass(
      client,
      supabaseOrigin,
      options.pageSize,
      false,
    );
    printSummary("Post-apply audit", audit);
    if (
      audit.blockers.length > 0 ||
      audit.documentsChanged > 0 ||
      audit.copiedObjects > 0
    ) {
      throw new Error(
        "Final audit is not clean; writes remain frozen until corrected.",
      );
    }

    await setRolloutState(client, "enforced", supabaseOrigin);
    return;
  }

  if (options.apply && state.phase === "enforced") {
    throw new Error("Backfill cannot run after enforcement is enabled.");
  }
  if (options.apply) {
    await setRolloutState(client, state.phase, supabaseOrigin);
  }

  const summary = await runPass(
    client,
    supabaseOrigin,
    options.pageSize,
    options.apply,
  );
  printSummary(options.apply ? "Apply pass" : "Dry-run audit", summary);
  if (summary.blockers.length > 0) {
    Deno.exitCode = 1;
  }
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
