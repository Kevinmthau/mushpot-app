alter table public.documents
  drop constraint if exists documents_content_format_check;

alter table public.documents
  add constraint documents_content_format_check
  check (content_format in ('markdown_v1', 'page_json_v1', 'html_v1'));

-- PostgreSQL text values cannot contain NUL. The remaining opaque-HTML wire
-- constraints are byte based so the browser, database, and downloaded UTF-8
-- file agree at the exact 2 MiB boundary.
alter table public.documents
  add constraint documents_html_content_check
  check (
    content_format <> 'html_v1'
    or (
      content <> ''
      and octet_length(content) <= 2097152
    )
  );

-- Every non-Markdown format is hidden unless the client advertises that exact
-- token. Markdown remains available to clients deployed before capabilities.
drop policy if exists "Owners can select own documents" on public.documents;
create policy "Owners can select own documents"
  on public.documents
  for select
  using (
    auth.uid() = owner
    and (
      content_format = 'markdown_v1'
      or content_format = any(
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

-- HTML is opaque source. It intentionally has no managed-media references and
-- must never enter the Markdown `/m/...` scanner during rollout validation.
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
    when 'html_v1' then true
    else false
  end;
$$;

revoke all on function private.document_content_has_valid_media_paths(
  text,
  uuid,
  uuid,
  text,
  text
) from public, anon, authenticated;
