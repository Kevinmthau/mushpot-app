# Document media rollout

These tools deliberately separate the additive database migration from the final
Storage privacy cutover. Use a disposable hosted Supabase project before running
the production sequence.

## Required configuration

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in the operator shell.
Never add the service-role key to the Next.js environment or commit it.

Generate one high-entropy maintenance secret and configure the same value as:

- Edge Function secret `MUSHPOT_MAINTENANCE_SECRET`
- Vault secret `mushpot_maintenance_secret`

Also create Vault secrets named `mushpot_project_url` and
`mushpot_publishable_key`. Deploy both functions, then run
`schedule-document-media-maintenance.sql`. The cron request intentionally uses
only `apikey` plus the maintenance secret.

Deleted-document cleanup jobs remain as tombstones for 24 hours and rescan both
buckets every five minutes. This catches objects completed by resumable upload
sessions that were created before the document was deleted.

## Backfill

Every write command requires the exact project origin as a second confirmation.
Start with the read-only audit:

```sh
deno run --allow-env --allow-net \
  supabase/admin/backfill-document-media.ts
```

Apply safe batches while the rollout remains in `backfill`:

```sh
deno run --allow-env --allow-net \
  supabase/admin/backfill-document-media.ts \
  --apply --confirm-origin=https://PROJECT_REF.supabase.co
```

The apply pass snapshots original content for seven days, copies same-owner
cross-document objects to deterministic document-owned paths, and updates a
document only when its original `updated_at` still matches. Missing objects,
malformed paths, cross-owner references, destination mismatches, and concurrent
updates are blockers.

For the final pass, freeze client document writes, apply once more, audit again,
and enable enforcement:

```sh
deno run --allow-env --allow-net \
  supabase/admin/backfill-document-media.ts \
  --apply --finalize --confirm-origin=https://PROJECT_REF.supabase.co
```

If finalization reports a blocker, writes stay frozen. Correct the blocker and
rerun finalization, or deliberately return to backfill:

```sh
deno run --allow-env --allow-net \
  supabase/admin/backfill-document-media.ts \
  --apply --set-phase=backfill \
  --confirm-origin=https://PROJECT_REF.supabase.co
```

## Bucket privacy cutover

The privacy tool reads and preserves each bucket's MIME and size settings. It is
a dry run unless `--apply` is present, verifies both updates, and rolls the
first bucket back if the second update fails.

```sh
deno run --allow-env --allow-net \
  supabase/admin/set-document-media-bucket-privacy.ts

deno run --allow-env --allow-net \
  supabase/admin/set-document-media-bucket-privacy.ts \
  --apply --confirm-origin=https://PROJECT_REF.supabase.co
```

Emergency public rollback is explicit:

```sh
deno run --allow-env --allow-net \
  supabase/admin/set-document-media-bucket-privacy.ts \
  --apply --public --confirm-origin=https://PROJECT_REF.supabase.co
```

After the private cutover, verify owner media, shared media, share revocation,
raw public URL failure, and expiry of previously issued five-minute signed URLs.
