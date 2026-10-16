begin;

select plan(33);

select has_column(
  'public',
  'documents',
  'content_format',
  'documents have a content format discriminator'
);

select col_type_is(
  'public',
  'documents',
  'content_format',
  'text',
  'the content format discriminator is text'
);

select col_not_null(
  'public',
  'documents',
  'content_format',
  'the content format discriminator is required'
);

select is(
  (
    select column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name = 'content_format'
  ),
  '''markdown_v1''::text',
  'legacy-compatible inserts default to Markdown'
);

select ok(
  not exists (
    select 1
    from public.documents
    where content_format is null
  ),
  'the migration backfilled every pre-existing document format'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
  ),
  4::bigint,
  'the additive format migration leaves document RLS policies unchanged'
);

select ok(
  not private.document_content_has_valid_media_paths(
    '{',
    '77777777-7777-4777-8777-777777777777'::uuid,
    '88888888-8888-4888-8888-888888888888'::uuid,
    'https://project-ref.supabase.co',
    'page_json_v1'
  ),
  'malformed page JSON fails media validation'
);

select ok(
  not private.document_content_has_valid_media_paths(
    '[]',
    '77777777-7777-4777-8777-777777777777'::uuid,
    '88888888-8888-4888-8888-888888888888'::uuid,
    'https://project-ref.supabase.co',
    'page_json_v1'
  ),
  'a non-object page envelope fails media validation'
);

select ok(
  private.document_content_has_valid_media_paths(
    '<img src="/m/document-images/foreign/path.png">',
    '77777777-7777-4777-8777-777777777777'::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid,
    'https://project-ref.supabase.co',
    'html_v1'
  ),
  'HTML media-rollout validation is an explicit opaque no-op'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '77777777-7777-4777-8777-777777777777',
  'authenticated',
  'authenticated',
  'content-format-owner@example.test',
  '',
  now(),
  now(),
  now()
);

insert into public.documents (id, owner, title, content)
values (
  '88888888-8888-4888-8888-888888888888',
  '77777777-7777-4777-8777-777777777777',
  'Legacy-compatible document',
  '# Markdown'
);

select is(
  (
    select content_format
    from public.documents
    where id = '88888888-8888-4888-8888-888888888888'
  ),
  'markdown_v1',
  'omitting the discriminator creates a Markdown document during rollout'
);

select lives_ok(
  $$
    insert into public.documents (
      id,
      owner,
      title,
      content,
      content_format
    )
    values (
      '99999999-9999-4999-8999-999999999999',
      '77777777-7777-4777-8777-777777777777',
      'Structured page',
      '{"schema":"mushpot.page","version":1,"theme":"paper","width":"prose","content":{"type":"doc","content":[{"type":"paragraph"}]}}',
      'page_json_v1'
    )
  $$,
  'the page JSON format is accepted'
);

select lives_ok(
  $$
    insert into public.documents (
      id,
      owner,
      title,
      content,
      content_format
    )
    values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '77777777-7777-4777-8777-777777777777',
      'Exact HTML limit',
      repeat('a', 2097152),
      'html_v1'
    )
  $$,
  'HTML accepts exactly 2 MiB of UTF-8 source'
);

select throws_ok(
  $$
    insert into public.documents (owner, content, content_format)
    values (
      '77777777-7777-4777-8777-777777777777',
      repeat('a', 2097153),
      'html_v1'
    )
  $$,
  '23514',
  null,
  'HTML rejects source over 2 MiB'
);

select throws_ok(
  $$
    insert into public.documents (owner, content, content_format)
    values (
      '77777777-7777-4777-8777-777777777777',
      '',
      'html_v1'
    )
  $$,
  '23514',
  null,
  'HTML rejects empty source'
);

select throws_ok(
  $$
    insert into public.documents (
      id,
      owner,
      title,
      content,
      content_format
    )
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '77777777-7777-4777-8777-777777777777',
      'Unsupported document',
      '',
      'future_json_v2'
    )
  $$,
  '23514',
  null,
  'unknown document formats are rejected'
);

update private.document_media_rollout_state
set supabase_origin = null
where singleton;

set local "request.jwt.claims" =
  '{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '77777777-7777-4777-8777-777777777777';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select is(
  (
    select count(*)
    from public.documents
    where id = '88888888-8888-4888-8888-888888888888'
  ),
  1::bigint,
  'legacy Markdown remains visible without a page capability'
);

select is(
  (
    select count(*)
    from public.documents
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ),
  0::bigint,
  'HTML is hidden without its exact capability'
);

set local "request.headers" =
  '{"x-mushpot-content-formats":"markdown_v1,page_json_v1"}';

select is(
  (
    select count(*)
    from public.documents
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ),
  0::bigint,
  'the page capability does not expose HTML'
);

select throws_ok(
  $sql$
    update public.documents
    set
      content_format = 'page_json_v1',
      content = '# stale editor content'
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  '23514',
  'Structured page content is invalid or contains media outside this document.',
  'page rows are validated while the media rollout is still in backfill'
);

select lives_ok(
  $sql$
    update public.documents
    set
      content_format = 'page_json_v1',
      content = $page$
        {
          "schema":"mushpot.page",
          "version":1,
          "theme":"paper",
          "width":"prose",
          "content":{"type":"doc","content":[{"type":"paragraph"}]}
        }
      $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  'a valid page row remains writable during backfill'
);

reset "request.headers";

select is(
  (
    select count(*)
    from public.documents
    where id = '88888888-8888-4888-8888-888888888888'
  ),
  0::bigint,
  'a stale private client cannot select structured page JSON'
);

set local "request.headers" =
  '{"x-mushpot-content-formats":"markdown_v1,page_json_v1"}';

select is(
  (
    select count(*)
    from public.documents
    where id = '88888888-8888-4888-8888-888888888888'
  ),
  1::bigint,
  'a page-capable private client can select structured rows'
);

set local "request.headers" =
  '{"x-mushpot-content-formats":"markdown_v1,html_v1"}';

select is(
  (
    select count(*)
    from public.documents
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ),
  1::bigint,
  'the exact HTML capability exposes HTML rows'
);

select is(
  (
    select count(*)
    from public.documents
    where id = '88888888-8888-4888-8888-888888888888'
  ),
  0::bigint,
  'the HTML capability does not expose page rows'
);

set local "request.headers" =
  '{"x-mushpot-content-formats":"markdown_v1,page_json_v1,html_v1"}';

select lives_ok(
  $sql$
    update public.documents
    set content = $page$
      {
        "schema":"mushpot.page",
        "version":1,
        "theme":"paper",
        "width":"prose",
        "content":{
          "type":"doc",
          "content":[{
            "type":"image",
            "attrs":{
              "src":"/m/document-images/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888/owned.png"
            }
          }]
        }
      }
    $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  'an owned stable media path is accepted before the Supabase origin is configured'
);

select lives_ok(
  $sql$
    update public.documents
    set content = $page$
      {
        "schema":"mushpot.page",
        "version":1,
        "theme":"paper",
        "width":"prose",
        "content":{
          "type":"doc",
          "content":[{
            "type":"image",
            "attrs":{
              "src":"https://cdn.example.test/public/image.png?redirect=/m/document-images/77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/foreign.png"
            }
          }]
        }
      }
    $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  'an external page image is accepted before the Supabase origin is configured'
);

select throws_ok(
  $sql$
    update public.documents
    set content = $page$
      {
        "schema":"mushpot.page",
        "version":1,
        "theme":"paper",
        "width":"prose",
        "content":{
          "type":"doc",
          "content":[{
            "type":"image",
            "attrs":{
              "src":"/m/document-images/77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/foreign.png"
            }
          }]
        }
      }
    $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  '23514',
  'Structured page content is invalid or contains media outside this document.',
  'a foreign stable media path is rejected before the Supabase origin is configured'
);

reset role;

update private.document_media_rollout_state
set supabase_origin = 'https://project-ref.supabase.co'
where singleton;

set local role authenticated;

select lives_ok(
  $sql$
    update public.documents
    set content = $page$
      {
        "schema":"mushpot.page",
        "version":1,
        "theme":"paper",
        "width":"prose",
        "content":{
          "type":"doc",
          "content":[{
            "type":"image",
            "attrs":{
              "src":"https://project-ref.supabase.co/storage/v1/object/public/document-images/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888/legacy.png"
            }
          }]
        }
      }
    $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  'configured legacy Supabase media is validated and accepted for its owning document'
);

insert into public.documents (
  id,
  owner,
  title,
  content,
  clone_status,
  clone_lease_token,
  clone_lease_expires_at
)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '77777777-7777-4777-8777-777777777777',
  'Old page clone',
  '',
  'pending',
  '11111111-1111-4111-8111-111111111111',
  now() + interval '10 minutes'
);

select throws_ok(
  $sql$
    update public.documents
    set
      title = 'Old page clone (copy)',
      content = $page$
        {
          "schema":"mushpot.page",
          "version":1,
          "theme":"paper",
          "width":"prose",
          "content":{"type":"doc","content":[{"type":"paragraph"}]}
        }
      $page$,
      clone_status = null,
      clone_lease_token = null,
      clone_lease_expires_at = null
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  $sql$,
  '55000',
  'This clone was started by an older app version. Reload Mushpot and clone it again.',
  'an old client cannot finalize page JSON into a Markdown clone'
);

insert into public.documents (
  id,
  owner,
  title,
  content,
  clone_status,
  clone_lease_token,
  clone_lease_expires_at
)
values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '77777777-7777-4777-8777-777777777777',
  'Markdown clone',
  '',
  'pending',
  '22222222-2222-4222-8222-222222222222',
  now() + interval '10 minutes'
);

select lives_ok(
  $sql$
    update public.documents
    set
      title = 'Markdown clone (copy)',
      content = '# copied Markdown',
      clone_status = null,
      clone_lease_token = null,
      clone_lease_expires_at = null
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  $sql$,
  'genuine Markdown clones still finalize during backfill'
);

reset role;

update private.document_media_rollout_state
set
  phase = 'enforced',
  supabase_origin = 'https://project-ref.supabase.co'
where singleton;

set local role authenticated;

select lives_ok(
  $sql$
    update public.documents
    set
      content_format = 'page_json_v1',
      content = $page$
        {
          "schema":"mushpot.page",
          "version":1,
          "theme":"paper",
          "width":"prose",
          "content":{
            "type":"doc",
            "content":[{
              "type":"paragraph",
              "content":[{
                "type":"text",
                "text":"/m/document-images/77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/mentioned.png",
                "marks":[{
                  "type":"link",
                  "attrs":{
                    "href":"/m/document-images/77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/linked.png"
                  }
                }]
              }]
            }]
          }
        }
      $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  'page prose and links may mention foreign managed-media-looking paths'
);

select throws_ok(
  $sql$
    update public.documents
    set content = $page$
      {
        "schema":"mushpot.page",
        "version":1,
        "theme":"paper",
        "width":"prose",
        "content":{
          "type":"doc",
          "content":[{
            "type":"image",
            "attrs":{
              "src":"/m/document-images/77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/foreign.png"
            }
          }]
        }
      }
    $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  '23514',
  'Structured page content is invalid or contains media outside this document.',
  'a typed page image cannot reference another document path'
);

select throws_ok(
  $sql$
    update public.documents
    set content = $page$
      {
        "schema":"mushpot.page",
        "version":1,
        "theme":"paper",
        "width":"prose",
        "content":{
          "type":"doc",
          "content":[{
            "type":"video",
            "attrs":{
              "src":"https://cdn.example.test/video.mp4",
              "poster":"/m/document-images/77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/foreign-poster.png"
            }
          }]
        }
      }
    $page$
    where id = '88888888-8888-4888-8888-888888888888'
  $sql$,
  '23514',
  'Structured page content is invalid or contains media outside this document.',
  'a typed page video poster cannot reference another document path'
);

reset role;
reset "request.jwt.claims";
reset "request.jwt.claim.sub";
reset "request.jwt.claim.role";
reset "request.headers";

select * from finish();

rollback;
