create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.document_media_rollout_state (
  singleton boolean primary key default true check (singleton),
  phase text not null default 'backfill'
    check (phase in ('backfill', 'frozen', 'enforced')),
  supabase_origin text
    check (
      supabase_origin is null
      or supabase_origin ~ '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'
    ),
  updated_at timestamptz not null default now()
);

alter table private.document_media_rollout_state enable row level security;

revoke all on table private.document_media_rollout_state
  from public, anon, authenticated;
grant select, update on table private.document_media_rollout_state
  to service_role;

insert into private.document_media_rollout_state (
  singleton,
  phase,
  supabase_origin
)
values (
  true,
  'backfill',
  nullif(
    regexp_replace(
      current_setting('app.settings.api_url', true),
      '/+$',
      ''
    ),
    ''
  )
);

alter table public.documents
  add column if not exists clone_status text,
  add column if not exists clone_lease_token uuid,
  add column if not exists clone_lease_expires_at timestamptz;

alter table public.documents
  drop constraint if exists documents_clone_status_check;

alter table public.documents
  add constraint documents_clone_status_check
  check (
    (
      clone_status is null
      and clone_lease_token is null
      and clone_lease_expires_at is null
    )
    or (
      clone_status in ('pending', 'recovering')
      and clone_lease_token is not null
      and clone_lease_expires_at is not null
    )
  );

create index if not exists documents_clone_lease_recovery_idx
  on public.documents (clone_status, clone_lease_expires_at)
  where clone_status in ('pending', 'recovering');

create table public.document_media_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  owner uuid not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_media_cleanup_jobs_owner_document_key
    unique (owner, document_id),
  constraint document_media_cleanup_jobs_lease_check
    check (
      (lease_token is null and lease_expires_at is null)
      or (lease_token is not null and lease_expires_at is not null)
    )
);

create index document_media_cleanup_jobs_due_idx
  on public.document_media_cleanup_jobs (
    next_attempt_at,
    lease_expires_at,
    created_at
  );

alter table public.document_media_cleanup_jobs enable row level security;

revoke all on table public.document_media_cleanup_jobs
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.document_media_cleanup_jobs
  to service_role;

create table public.document_media_backfill_snapshots (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  owner uuid not null,
  original_content text not null,
  original_updated_at timestamptz not null,
  copied_paths jsonb not null default '[]'::jsonb
    check (jsonb_typeof(copied_paths) = 'array'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint document_media_backfill_snapshot_version_key
    unique (document_id, original_updated_at)
);

create index document_media_backfill_snapshots_expiry_idx
  on public.document_media_backfill_snapshots (expires_at);

alter table public.document_media_backfill_snapshots enable row level security;

revoke all on table public.document_media_backfill_snapshots
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.document_media_backfill_snapshots
  to service_role;

create or replace function private.document_media_relative_path_is_safe(
  p_path text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  path_segment text;
  percent_decoded_dots text;
begin
  if p_path is null or p_path = '' or p_path ~ '[?#\\]' then
    return false;
  end if;

  foreach path_segment in array string_to_array(p_path, '/')
  loop
    if path_segment in ('', '.', '..')
      or path_segment ~* '%(2f|5c|00)'
      or position(
        '%' in regexp_replace(
          path_segment,
          '%[0-9a-f]{2}',
          '',
          'gi'
        )
      ) > 0
    then
      return false;
    end if;

    percent_decoded_dots := replace(lower(path_segment), '%2e', '.');
    if percent_decoded_dots in ('.', '..') then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function private.document_content_has_valid_media_paths(
  p_content text,
  p_owner uuid,
  p_document_id uuid,
  p_supabase_origin text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  configured_origin text := lower(rtrim(p_supabase_origin, '/'));
  configured_storage_origin text;
  legacy_match text[];
  local_candidate text;
  origin_match text[];
  path_match text[];
  uuid_pattern constant text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
begin
  if configured_origin is null or configured_origin = '' then
    return false;
  end if;

  origin_match := regexp_match(
    configured_origin,
    '^(https://)([a-z0-9-]+)\.supabase\.co$',
    'i'
  );
  if origin_match is not null then
    configured_storage_origin :=
      lower(origin_match[1] || origin_match[2] || '.storage.supabase.co');
  end if;

  for local_candidate in
    select matches[2]
    from regexp_matches(
      coalesce(p_content, ''),
      '(^|[^[:alnum:]_:/.-])(/m/(document-images|document-videos)/[^[:space:]"''<>()]*)',
      'gi'
    ) as matches
  loop
    path_match := regexp_match(
      local_candidate,
      '^/m/(document-images|document-videos)/(' ||
        uuid_pattern || ')/(' || uuid_pattern || ')/(.+)$',
      'i'
    );

    if path_match is null
      or lower(path_match[2]) <> lower(p_owner::text)
      or lower(path_match[3]) <> lower(p_document_id::text)
      or not private.document_media_relative_path_is_safe(path_match[4])
    then
      return false;
    end if;
  end loop;

  for legacy_match in
    select matches
    from regexp_matches(
      coalesce(p_content, ''),
      '(https?://[^/[:space:]"''<>()]+)(/storage/v1/(object|render/image)/public/(document-images|document-videos)/([^[:space:]"''<>()]*))',
      'gi'
    ) as matches
  loop
    if lower(legacy_match[1]) not in (
      configured_origin,
      coalesce(configured_storage_origin, configured_origin)
    ) then
      continue;
    end if;

    path_match := regexp_match(
      legacy_match[5],
      '^(' || uuid_pattern || ')/(' || uuid_pattern || ')/(.+)$',
      'i'
    );

    if path_match is null
      or lower(path_match[1]) <> lower(p_owner::text)
      or lower(path_match[2]) <> lower(p_document_id::text)
      or not private.document_media_relative_path_is_safe(path_match[3])
    then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function private.guard_document_media_rollout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_phase text;
  rollout_supabase_origin text;
  request_role text;
  is_client_request boolean;
begin
  select state.phase, state.supabase_origin
  into rollout_phase, rollout_supabase_origin
  from private.document_media_rollout_state as state
  where state.singleton;

  request_role := coalesce(
    auth.jwt() ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    current_user
  );
  is_client_request := request_role in ('anon', 'authenticated');

  if not is_client_request then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if rollout_phase is null then
    raise exception using
      errcode = '55000',
      message = 'Document media rollout state is missing.';
  end if;

  if tg_op = 'INSERT'
    and exists (
      select 1
      from public.document_media_cleanup_jobs as cleanup_jobs
      where cleanup_jobs.owner = new.owner
        and cleanup_jobs.document_id = new.id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Document ID is still reserved for media cleanup.';
  end if;

  if rollout_phase = 'frozen' then
    raise exception using
      errcode = '55000',
      message = 'Document writes are temporarily frozen for media migration.';
  end if;

  if rollout_phase = 'backfill' and tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Document deletion is temporarily unavailable during media migration.';
  end if;

  if rollout_phase = 'enforced'
    and tg_op in ('INSERT', 'UPDATE')
    and not private.document_content_has_valid_media_paths(
      new.content,
      new.owner,
      new.id,
      rollout_supabase_origin
    )
  then
    raise exception using
      errcode = '23514',
      message = 'Document media must be stored under the document owner and ID.';
  end if;

  if tg_op in ('INSERT', 'UPDATE')
    and new.clone_status = 'pending'
    and new.clone_lease_token is not null
  then
    new.clone_lease_expires_at := now() + interval '10 minutes';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.queue_document_media_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_media_cleanup_jobs (
    document_id,
    owner,
    next_attempt_at
  )
  values (
    old.id,
    old.owner,
    now()
  )
  on conflict (owner, document_id)
  do update set
    next_attempt_at = least(
      public.document_media_cleanup_jobs.next_attempt_at,
      excluded.next_attempt_at
    ),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now();

  return old;
end;
$$;

revoke all on function private.document_content_has_valid_media_paths(
  text,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
revoke all on function private.document_media_relative_path_is_safe(text)
  from public, anon, authenticated;
revoke all on function private.guard_document_media_rollout()
  from public, anon, authenticated;
revoke all on function private.queue_document_media_cleanup()
  from public, anon, authenticated;

drop trigger if exists documents_media_rollout_guard on public.documents;
create trigger documents_media_rollout_guard
before insert or update or delete on public.documents
for each row
execute function private.guard_document_media_rollout();

drop trigger if exists documents_queue_media_cleanup on public.documents;
create trigger documents_queue_media_cleanup
after delete on public.documents
for each row
execute function private.queue_document_media_cleanup();

drop function if exists public.delete_document_with_media_cleanup_job(uuid);

create or replace function public.get_document_media_rollout_state()
returns table (
  phase text,
  supabase_origin text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select state.phase, state.supabase_origin
  from private.document_media_rollout_state as state
  where state.singleton;
$$;

create or replace function public.set_document_media_rollout_state(
  p_phase text,
  p_supabase_origin text default null
)
returns table (
  phase text,
  supabase_origin text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_phase text;
  current_origin text;
  requested_origin text;
begin
  if p_phase not in ('backfill', 'frozen', 'enforced') then
    raise exception using
      errcode = '22023',
      message = 'Invalid document media rollout phase.';
  end if;

  requested_origin := nullif(
    regexp_replace(coalesce(p_supabase_origin, ''), '/+$', ''),
    ''
  );

  if requested_origin is not null
    and requested_origin !~ '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'
  then
    raise exception using
      errcode = '22023',
      message = 'Supabase origin must contain only scheme, host, and optional port.';
  end if;

  select state.phase, state.supabase_origin
  into current_phase, current_origin
  from private.document_media_rollout_state as state
  where state.singleton
  for update;

  if not (
    p_phase = current_phase
    or (current_phase = 'backfill' and p_phase = 'frozen')
    or (current_phase = 'frozen' and p_phase in ('backfill', 'enforced'))
    or (current_phase = 'enforced' and p_phase = 'frozen')
  ) then
    raise exception using
      errcode = '22023',
      message = format(
        'Invalid document media rollout transition from %s to %s.',
        current_phase,
        p_phase
      );
  end if;

  current_origin := coalesce(requested_origin, current_origin);

  if p_phase = 'enforced' and current_origin is null then
    raise exception using
      errcode = '23514',
      message = 'Configure the Supabase origin before enabling enforcement.';
  end if;

  update private.document_media_rollout_state as state
  set
    phase = p_phase,
    supabase_origin = current_origin,
    updated_at = now()
  where state.singleton;

  return query
  select state.phase, state.supabase_origin
  from private.document_media_rollout_state as state
  where state.singleton;
end;
$$;

create or replace function public.claim_document_media_cleanup_jobs(
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns table (
  job_id uuid,
  document_id uuid,
  owner uuid,
  attempt_count integer,
  lease_token uuid,
  created_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  with candidates as materialized (
    select jobs.id
    from public.document_media_cleanup_jobs as jobs
    where jobs.next_attempt_at <= now()
      and (
        jobs.lease_expires_at is null
        or jobs.lease_expires_at <= now()
      )
    order by jobs.next_attempt_at, jobs.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  ),
  claimed as (
    update public.document_media_cleanup_jobs as jobs
    set
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(
        secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)
      ),
      updated_at = now()
    from candidates
    where jobs.id = candidates.id
    returning
      jobs.id,
      jobs.document_id,
      jobs.owner,
      jobs.attempt_count,
      jobs.lease_token,
      jobs.created_at
  )
  select
    claimed.id,
    claimed.document_id,
    claimed.owner,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.created_at
  from claimed;
$$;

create or replace function public.claim_expired_document_clones(
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns table (
  document_id uuid,
  owner uuid,
  lease_token uuid
)
language sql
security invoker
set search_path = ''
as $$
  with candidates as materialized (
    select documents.id
    from public.documents
    where documents.clone_status in ('pending', 'recovering')
      and documents.clone_lease_expires_at <= now()
    order by documents.clone_lease_expires_at, documents.id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  ),
  claimed as (
    update public.documents
    set
      clone_status = 'recovering',
      clone_lease_token = gen_random_uuid(),
      clone_lease_expires_at = now() + make_interval(
        secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)
      )
    from candidates
    where documents.id = candidates.id
    returning
      documents.id,
      documents.owner,
      documents.clone_lease_token
  )
  select claimed.id, claimed.owner, claimed.clone_lease_token
  from claimed;
$$;

revoke all on function public.get_document_media_rollout_state()
  from public, anon, authenticated;
revoke all on function public.set_document_media_rollout_state(text, text)
  from public, anon, authenticated;
revoke all on function public.claim_document_media_cleanup_jobs(
  integer,
  integer
) from public, anon, authenticated;
revoke all on function public.claim_expired_document_clones(integer, integer)
  from public, anon, authenticated;

grant execute on function public.get_document_media_rollout_state()
  to service_role;
grant execute on function public.set_document_media_rollout_state(text, text)
  to service_role;
grant execute on function public.claim_document_media_cleanup_jobs(
  integer,
  integer
) to service_role;
grant execute on function public.claim_expired_document_clones(
  integer,
  integer
) to service_role;

grant select, insert, update, delete on table public.documents
  to authenticated, service_role;

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
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can upload own document images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'document-images'
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
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can read own document videos"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'document-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

create policy "Users can upload own document videos"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'document-videos'
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
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.documents
      where documents.owner = (select auth.uid())
        and documents.id::text = (storage.foldername(name))[2]
    )
  );
