update storage.buckets
set public = false
where id in ('document-images', 'document-videos');

alter table public.documents
  add column if not exists clone_status text;

alter table public.documents
  drop constraint if exists documents_clone_status_check;

alter table public.documents
  add constraint documents_clone_status_check
  check (clone_status is null or clone_status in ('pending', 'recovering'));

create index if not exists documents_pending_clone_recovery_idx
  on public.documents (owner, updated_at)
  where clone_status in ('pending', 'recovering');

create table if not exists public.document_media_cleanup_jobs (
  document_id uuid not null,
  owner uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner, document_id)
);

create index if not exists document_media_cleanup_jobs_owner_created_at_idx
  on public.document_media_cleanup_jobs (owner, created_at);

alter table public.document_media_cleanup_jobs enable row level security;

drop policy if exists "Owners can read own media cleanup jobs"
  on public.document_media_cleanup_jobs;
drop policy if exists "Owners can complete own media cleanup jobs"
  on public.document_media_cleanup_jobs;

create policy "Owners can read own media cleanup jobs"
  on public.document_media_cleanup_jobs
  for select
  to authenticated
  using ((select auth.uid()) = owner);

create policy "Owners can complete own media cleanup jobs"
  on public.document_media_cleanup_jobs
  for delete
  to authenticated
  using ((select auth.uid()) = owner);

revoke all on table public.document_media_cleanup_jobs from anon, authenticated;
grant select, delete on table public.document_media_cleanup_jobs to authenticated;

create or replace function public.delete_document_with_media_cleanup_job(
  p_document_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  owned_document_id uuid;
begin
  if caller_id is null then
    raise insufficient_privilege using message = 'Authentication required.';
  end if;

  select documents.id
  into owned_document_id
  from public.documents
  where documents.id = p_document_id
    and documents.owner = caller_id
  for update;

  if owned_document_id is null then
    return null;
  end if;

  insert into public.document_media_cleanup_jobs (document_id, owner)
  values (owned_document_id, caller_id)
  on conflict (owner, document_id) do nothing;

  delete from public.documents
  where documents.id = owned_document_id
    and documents.owner = caller_id;

  return owned_document_id;
end;
$$;

revoke all on function public.delete_document_with_media_cleanup_job(uuid)
  from public, anon;
grant execute on function public.delete_document_with_media_cleanup_job(uuid)
  to authenticated;

drop policy if exists "Users can read own document images" on storage.objects;
drop policy if exists "Users can upload own document images" on storage.objects;
drop policy if exists "Users can update own document images" on storage.objects;
drop policy if exists "Users can delete own document images" on storage.objects;
drop policy if exists "Users can read own document videos" on storage.objects;
drop policy if exists "Users can upload own document videos" on storage.objects;
drop policy if exists "Users can update own document videos" on storage.objects;
drop policy if exists "Users can delete own document videos" on storage.objects;

create policy "Users can read own document images"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'document-images'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can upload own document images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'document-images'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can update own document images"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'document-images'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  )
  with check (
    bucket_id = 'document-images'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can delete own document images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'document-images'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can read own document videos"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'document-videos'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can upload own document videos"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'document-videos'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can update own document videos"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'document-videos'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  )
  with check (
    bucket_id = 'document-videos'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can delete own document videos"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'document-videos'
    and owner_id = (select auth.uid())::text
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
