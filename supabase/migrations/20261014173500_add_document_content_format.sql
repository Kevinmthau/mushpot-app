alter table public.documents
  add column if not exists content_format text;

-- Rows created before structured pages existed are Markdown documents.
update public.documents
set content_format = 'markdown_v1'
where content_format is null;

alter table public.documents
  alter column content_format set default 'markdown_v1',
  alter column content_format set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.documents'::regclass
      and conname = 'documents_content_format_check'
  ) then
    alter table public.documents
      add constraint documents_content_format_check
      check (content_format in ('markdown_v1', 'page_json_v1'));
  end if;
end;
$$;

create or replace function private.document_content_has_page_envelope(
  p_content text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  page_document jsonb;
begin
  begin
    page_document := p_content::jsonb;
  exception
    when others then
      return false;
  end;

  return jsonb_typeof(page_document) = 'object'
    and page_document ->> 'schema' = 'mushpot.page'
    and jsonb_typeof(page_document -> 'content') = 'object'
    and page_document -> 'content' ->> 'type' = 'doc';
end;
$$;

-- Page rows are invisible to a client that has not explicitly advertised the
-- structured format. This is a deploy/rollback fence: an already-open older
-- app may keep running after the migration, but it must never receive page JSON
-- and mistake it for Markdown. Markdown remains available to every version.
drop policy if exists "Owners can select own documents" on public.documents;
create policy "Owners can select own documents"
  on public.documents
  for select
  using (
    auth.uid() = owner
    and (
      content_format = 'markdown_v1'
      or 'page_json_v1' = any(
        string_to_array(
          replace(
            coalesce(
              coalesce(
                nullif(current_setting('request.headers', true), ''),
                '{}'
              )::jsonb ->> 'x-mushpot-content-formats',
              ''
            ),
            ' ',
            ''
          ),
          ','
        )
      )
    )
  );

create or replace function private.document_page_media_url_is_valid(
  p_media_url text,
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
  absolute_match text[];
  configured_origin text := lower(rtrim(p_supabase_origin, '/'));
  configured_storage_origin text;
  origin_match text[];
begin
  if p_media_url is null
    or p_media_url = ''
    or p_media_url <> btrim(p_media_url)
    or p_media_url ~ '[[:cntrl:][:space:]\\]'
  then
    return false;
  end if;

  -- Stable app media paths always carry owner/document identity, even before
  -- the project origin has been configured.
  if p_media_url like '/m/%' then
    return private.document_content_has_valid_media_paths(
      p_media_url,
      p_owner,
      p_document_id,
      coalesce(nullif(configured_origin, ''), 'https://document-media-rollout.invalid')
    );
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

  -- Only URLs on the configured project origins enter the legacy public-
  -- storage scanner. An unrelated external URL may contain `/m/...` in its
  -- query or path without being mistaken for managed document media.
  if configured_origin is not null
    and configured_origin <> ''
    and (
      lower(p_media_url) like configured_origin || '/storage/v1/%'
      or lower(p_media_url) like
        coalesce(configured_storage_origin, configured_origin) || '/storage/v1/%'
    )
  then
    return private.document_content_has_valid_media_paths(
      p_media_url,
      p_owner,
      p_document_id,
      configured_origin
    );
  end if;

  if p_media_url like '//%'
    or (
      p_media_url ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and p_media_url !~* '^https?://'
    )
  then
    return false;
  end if;

  if p_media_url ~* '^https?://' then
    absolute_match := regexp_match(
      p_media_url,
      '^(https?://)([^/?#]+)([/?#].*)?$',
      'i'
    );
    return absolute_match is not null
      and position('@' in absolute_match[2]) = 0;
  end if;

  -- Safe relative URLs are valid external/public page media too.
  return true;
end;
$$;

create or replace function private.document_page_content_has_valid_media_paths(
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
  page_document jsonb;
  page_node jsonb;
  media_attributes jsonb;
  media_url text;
begin
  begin
    page_document := p_content::jsonb;
  exception
    when others then
      return false;
  end;

  if jsonb_typeof(page_document) is distinct from 'object'
    or not (
      page_document ?& array[
        'schema',
        'version',
        'theme',
        'width',
        'content'
      ]
    )
    or (page_document - 'schema' - 'version' - 'theme' - 'width' - 'content')
      <> '{}'::jsonb
    or page_document ->> 'schema' is distinct from 'mushpot.page'
    or page_document -> 'version' is distinct from '1'::jsonb
    or coalesce(page_document ->> 'theme', '') not in ('paper', 'editorial')
    or coalesce(page_document ->> 'width', '') not in ('prose', 'wide')
    or jsonb_typeof(page_document -> 'content') is distinct from 'object'
    or page_document -> 'content' ->> 'type' is distinct from 'doc'
  then
    return false;
  end if;

  for page_node in
    with recursive page_nodes (node) as (
      select page_document -> 'content'
      union all
      select child.value
      from page_nodes
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(page_nodes.node -> 'content') = 'array'
            then page_nodes.node -> 'content'
          else '[]'::jsonb
        end
      ) as child(value)
    )
    select node
    from page_nodes
  loop
    if jsonb_typeof(page_node) is distinct from 'object'
      or (
        page_node ? 'content'
        and jsonb_typeof(page_node -> 'content') is distinct from 'array'
      )
    then
      return false;
    end if;

    if page_node ->> 'type' not in ('image', 'video') then
      continue;
    end if;

    media_attributes := page_node -> 'attrs';
    if jsonb_typeof(media_attributes) is distinct from 'object'
      or jsonb_typeof(media_attributes -> 'src') is distinct from 'string'
      or media_attributes ->> 'src' = ''
    then
      return false;
    end if;

    media_url := media_attributes ->> 'src';
    if not private.document_page_media_url_is_valid(
      media_url,
      p_owner,
      p_document_id,
      p_supabase_origin
    ) then
      return false;
    end if;

    if page_node ->> 'type' = 'video'
      and media_attributes ? 'poster'
      and media_attributes -> 'poster' <> 'null'::jsonb
    then
      if jsonb_typeof(media_attributes -> 'poster') is distinct from 'string'
        or media_attributes ->> 'poster' = ''
      then
        return false;
      end if;

      media_url := media_attributes ->> 'poster';
      if not private.document_page_media_url_is_valid(
        media_url,
        p_owner,
        p_document_id,
        p_supabase_origin
      ) then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function private.document_content_has_valid_media_paths(
  p_content text,
  p_owner uuid,
  p_document_id uuid,
  p_supabase_origin text,
  p_content_format text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_content_format
    when 'markdown_v1' then
      private.document_content_has_valid_media_paths(
        p_content,
        p_owner,
        p_document_id,
        p_supabase_origin
      )
    when 'page_json_v1' then
      private.document_page_content_has_valid_media_paths(
        p_content,
        p_owner,
        p_document_id,
        p_supabase_origin
      )
    else false
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

  -- A previously loaded client does not know about content_format. Its clone
  -- flow creates a Markdown pending row, then can try to finalize it with a
  -- structured page payload. Reject that transition rather than permanently
  -- labelling page JSON as Markdown (or regex-rewriting strings inside it).
  if tg_op = 'UPDATE'
    and old.content_format = 'markdown_v1'
    and old.clone_status = 'pending'
    and new.content_format = 'markdown_v1'
    and new.clone_status is null
    and private.document_content_has_page_envelope(new.content)
  then
    raise exception using
      errcode = '55000',
      message = 'This clone was started by an older app version. Reload Mushpot and clone it again.';
  end if;

  -- Validate structured rows in every writable rollout phase. In particular,
  -- this keeps a stale Markdown editor from replacing a page with raw text
  -- while the media rollout is still in backfill mode.
  if tg_op in ('INSERT', 'UPDATE')
    and new.content_format = 'page_json_v1'
    and not private.document_page_content_has_valid_media_paths(
      new.content,
      new.owner,
      new.id,
      rollout_supabase_origin
    )
  then
    raise exception using
      errcode = '23514',
      message = 'Structured page content is invalid or contains media outside this document.';
  end if;

  if rollout_phase = 'enforced'
    and tg_op in ('INSERT', 'UPDATE')
    and new.content_format = 'markdown_v1'
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

revoke all on function private.document_page_content_has_valid_media_paths(
  text,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
revoke all on function private.document_page_media_url_is_valid(
  text,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
revoke all on function private.document_content_has_page_envelope(text)
  from public, anon, authenticated;
revoke all on function private.document_content_has_valid_media_paths(
  text,
  uuid,
  uuid,
  text,
  text
) from public, anon, authenticated;
