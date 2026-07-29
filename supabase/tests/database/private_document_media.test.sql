begin;

select plan(68);

-- Schema, privilege, and helper-function assertions.
select is(
  (
    select phase
    from private.document_media_rollout_state
    where singleton
  ),
  'backfill',
  'media rollout starts in backfill mode'
);
select has_column(
  'public',
  'documents',
  'clone_status',
  'documents have clone status'
);
select has_column(
  'public',
  'documents',
  'clone_lease_token',
  'documents have clone lease tokens'
);
select has_column(
  'public',
  'documents',
  'clone_lease_expires_at',
  'documents have clone lease expiry'
);
select has_table(
  'public',
  'document_media_cleanup_jobs',
  'durable cleanup job table exists'
);
select has_table(
  'public',
  'document_media_backfill_snapshots',
  'backfill snapshot table exists'
);
select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.document_media_cleanup_jobs'::regclass
  ),
  'cleanup jobs have RLS enabled'
);
select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.document_media_backfill_snapshots'::regclass
  ),
  'backfill snapshots have RLS enabled'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.document_media_cleanup_jobs',
    'SELECT'
  ),
  'authenticated users cannot read cleanup jobs'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.document_media_backfill_snapshots',
    'SELECT'
  ),
  'authenticated users cannot read backfill snapshots'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.document_media_cleanup_jobs',
    'SELECT'
  ),
  'service role can read cleanup jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_document_media_cleanup_jobs(integer,integer)',
    'EXECUTE'
  ),
  'authenticated users cannot claim cleanup jobs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_document_media_cleanup_jobs(integer,integer)',
    'EXECUTE'
  ),
  'service role can claim cleanup jobs'
);
select has_trigger(
  'public',
  'documents',
  'documents_media_rollout_guard',
  'document writes have a rollout guard'
);
select has_trigger(
  'public',
  'documents',
  'documents_queue_media_cleanup',
  'document deletes queue cleanup'
);
select ok(
  private.document_content_has_valid_media_paths(
    '/m/document-images/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cover.png',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'https://project-ref.supabase.co'
  ),
  'same-document media path is accepted'
);
select ok(
  not private.document_content_has_valid_media_paths(
    '/m/document-images/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cover.png',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'https://project-ref.supabase.co'
  ),
  'cross-document media path is rejected'
);
select ok(
  not private.document_content_has_valid_media_paths(
    '/m/document-images/not-a-uuid/bad',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'https://project-ref.supabase.co'
  ),
  'malformed local media path is rejected'
);
select ok(
  private.document_content_has_valid_media_paths(
    'https://third-party.example/storage/v1/object/public/document-images/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/photo.png',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'https://project-ref.supabase.co'
  ),
  'third-party storage-like URL remains ordinary external media'
);
select ok(
  private.document_content_has_valid_media_paths(
    'https://third-party.example/m/document-images/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/photo.png',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'https://project-ref.supabase.co'
  ),
  'third-party URL with a stable-looking path remains external media'
);
select ok(
  not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.document_media_cleanup_jobs'::regclass
      and contype = 'f'
  ),
  'cleanup jobs survive user deletion because they have no foreign key'
);
select is(
  (
    select public
    from storage.buckets
    where id = 'document-images'
  ),
  true,
  'additive migration leaves the image bucket public'
);
select is(
  (
    select public
    from storage.buckets
    where id = 'document-videos'
  ),
  true,
  'additive migration leaves the video bucket public'
);

-- Minimal Auth rows satisfy the document owner foreign key.
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
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'media-owner-one@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'media-owner-two@example.test',
    '',
    now(),
    now(),
    now()
  );

-- Backfill: owners can write their own rows, cannot cross owners, and cannot
-- delete until all legacy media is migrated.
set local "request.jwt.claims" =
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '11111111-1111-4111-8111-111111111111';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select lives_ok(
  $$
    insert into public.documents (id, owner, title, content)
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'Owner one',
      ''
    )
  $$,
  'owner one can insert an owned document during backfill'
);
select throws_ok(
  $$
    insert into public.documents (id, owner, title, content)
    values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '22222222-2222-4222-8222-222222222222',
      'Wrong owner',
      ''
    )
  $$,
  'owner one cannot insert a document for owner two'
);
select lives_ok(
  $$
    update public.documents
    set title = 'Owner one updated'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  'document updates remain available during backfill'
);
select throws_ok(
  $$
    delete from public.documents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '55000',
  'Document deletion is temporarily unavailable during media migration.',
  'document deletion is blocked during backfill'
);

reset role;
set local "request.jwt.claims" =
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '22222222-2222-4222-8222-222222222222';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select is(
  (
    select count(*)
    from public.documents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  0::bigint,
  'owner two cannot see owner one document'
);
select lives_ok(
  $$
    insert into public.documents (id, owner, title, content)
    values (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '22222222-2222-4222-8222-222222222222',
      'Owner two',
      ''
    )
  $$,
  'owner two can insert an owned document'
);

reset role;
reset "request.jwt.claims";
reset "request.jwt.claim.sub";
reset "request.jwt.claim.role";

-- Frozen: every client document mutation is rejected while the final pass runs.
update private.document_media_rollout_state
set
  phase = 'frozen',
  supabase_origin = 'https://project-ref.supabase.co'
where singleton;

set local "request.jwt.claims" =
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '11111111-1111-4111-8111-111111111111';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select throws_ok(
  $$
    insert into public.documents (id, owner, title, content)
    values (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '11111111-1111-4111-8111-111111111111',
      'Frozen insert',
      ''
    )
  $$,
  '55000',
  'Document writes are temporarily frozen for media migration.',
  'insert is blocked while frozen'
);
select throws_ok(
  $$
    update public.documents
    set title = 'Frozen update'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '55000',
  'Document writes are temporarily frozen for media migration.',
  'update is blocked while frozen'
);
select throws_ok(
  $$
    delete from public.documents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '55000',
  'Document writes are temporarily frozen for media migration.',
  'delete is blocked while frozen'
);

reset role;
reset "request.jwt.claims";
reset "request.jwt.claim.sub";
reset "request.jwt.claim.role";

-- Enforced: local media must be canonical and document-owned. Third-party and
-- normal external media remain valid.
update private.document_media_rollout_state
set phase = 'enforced'
where singleton;

set local "request.jwt.claims" =
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '11111111-1111-4111-8111-111111111111';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select lives_ok(
  $$
    update public.documents
    set content =
      '![cover](/m/document-images/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cover.png)'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  'same-document media is accepted in enforced mode'
);
select throws_ok(
  $$
    update public.documents
    set content =
      '![cross](/m/document-images/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cover.png)'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '23514',
  'Document media must be stored under the document owner and ID.',
  'cross-document media is rejected in enforced mode'
);
select throws_ok(
  $$
    update public.documents
    set content = '![bad](/m/document-images/not-a-uuid/bad)'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '23514',
  'Document media must be stored under the document owner and ID.',
  'malformed local media is rejected in enforced mode'
);
select lives_ok(
  $$
    update public.documents
    set content =
      '![third party](https://third-party.example/storage/v1/object/public/document-images/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/photo.png)'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  'third-party storage-like URL is allowed'
);
select lives_ok(
  $$
    update public.documents
    set content = '![external](https://cdn.example.test/photo.png)'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  'ordinary external media is allowed'
);
select lives_ok(
  $$
    delete from public.documents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  'direct document delete succeeds in enforced mode'
);

reset role;
reset "request.jwt.claims";
reset "request.jwt.claim.sub";
reset "request.jwt.claim.role";

select is(
  (
    select count(*)
    from public.document_media_cleanup_jobs
    where owner = '11111111-1111-4111-8111-111111111111'
      and document_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  1::bigint,
  'direct document delete queues one durable cleanup job'
);
select is(
  (
    select attempt_count
    from public.document_media_cleanup_jobs
    where owner = '11111111-1111-4111-8111-111111111111'
      and document_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  0,
  'new cleanup tombstone is immediately claimable without a failure count'
);

set local "request.jwt.claims" =
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '11111111-1111-4111-8111-111111111111';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select throws_ok(
  $$
    insert into public.documents (id, owner, title, content)
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'Reused ID',
      ''
    )
  $$,
  '55000',
  'Document ID is still reserved for media cleanup.',
  'client cannot reuse an ID while its cleanup tombstone exists'
);

reset role;
reset "request.jwt.claims";
reset "request.jwt.claim.sub";
reset "request.jwt.claim.role";

select lives_ok(
  $$
    delete from auth.users
    where id = '22222222-2222-4222-8222-222222222222'
  $$,
  'deleting owner two cascades through the document'
);
select is(
  (
    select count(*)
    from public.documents
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  0::bigint,
  'owner deletion removes the owned document'
);
select is(
  (
    select count(*)
    from public.document_media_cleanup_jobs
    where owner = '22222222-2222-4222-8222-222222222222'
      and document_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  1::bigint,
  'auth-user cascade queues and retains the media cleanup job'
);
select is(
  (
    select count(*)
    from auth.users
    where id = '22222222-2222-4222-8222-222222222222'
  ),
  0::bigint,
  'cleanup job does not prevent auth-user deletion'
);

-- Neither anon nor authenticated callers can access maintenance state through
-- tables or service-role-only RPCs.
set local "request.jwt.claims" = '{"role":"anon"}';
set local "request.jwt.claim.role" = 'anon';
set local role anon;

select throws_ok(
  $$ select count(*) from public.document_media_cleanup_jobs $$,
  'anon cannot query cleanup jobs'
);
select throws_ok(
  $$ select * from public.claim_document_media_cleanup_jobs(1, 60) $$,
  'anon cannot invoke the cleanup claim RPC'
);

reset role;
set local "request.jwt.claims" =
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local "request.jwt.claim.sub" =
  '11111111-1111-4111-8111-111111111111';
set local "request.jwt.claim.role" = 'authenticated';
set local role authenticated;

select throws_ok(
  $$ select count(*) from public.document_media_cleanup_jobs $$,
  'authenticated caller cannot query cleanup jobs'
);
select throws_ok(
  $$ select * from public.claim_document_media_cleanup_jobs(1, 60) $$,
  'authenticated caller cannot invoke the cleanup claim RPC'
);

-- Storage policies authorize the owner/document path and do not depend on the
-- storage object's owner_id, including service-role-created copies.
select lives_ok(
  $$
    insert into public.documents (id, owner, title, content)
    values (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '11111111-1111-4111-8111-111111111111',
      'Storage policy document',
      ''
    )
  $$,
  'owner can create a document for Storage policy tests'
);
select lives_ok(
  $$
    insert into storage.objects (bucket_id, name)
    values (
      'document-images',
      '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cover.png'
    )
  $$,
  'image upload is allowed under an owned document path'
);
select throws_ok(
  $$
    insert into storage.objects (bucket_id, name)
    values (
      'document-images',
      '22222222-2222-4222-8222-222222222222/cccccccc-cccc-4ccc-8ccc-cccccccccccc/foreign.png'
    )
  $$,
  'image upload is rejected under another owner path'
);
select throws_ok(
  $$
    insert into storage.objects (bucket_id, name)
    values (
      'document-images',
      '11111111-1111-4111-8111-111111111111/dddddddd-dddd-4ddd-8ddd-dddddddddddd/missing.png'
    )
  $$,
  'image upload is rejected when the path document does not exist'
);
select lives_ok(
  $$
    insert into storage.objects (bucket_id, name)
    values (
      'document-videos',
      '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/clip.mp4'
    )
  $$,
  'video upload is allowed under an owned document path'
);
select is(
  (
    select count(*)
    from storage.objects
    where name like
      '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/%'
  ),
  2::bigint,
  'owner can read both document-owned Storage objects'
);
select lives_ok(
  $$
    update storage.objects
    set name =
      '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cover-2.png'
    where bucket_id = 'document-images'
      and name =
        '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cover.png'
  $$,
  'owner can update an object within the owned document path'
);
select throws_ok(
  $$
    update storage.objects
    set name =
      '11111111-1111-4111-8111-111111111111/dddddddd-dddd-4ddd-8ddd-dddddddddddd/cover.png'
    where bucket_id = 'document-images'
      and name =
        '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cover-2.png'
  $$,
  'owner cannot move an object to a missing document path'
);
select lives_ok(
  $$
    delete from storage.objects
    where bucket_id = 'document-images'
      and name =
        '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cover-2.png'
  $$,
  'owner can delete an image while its document exists'
);
select lives_ok(
  $$
    delete from storage.objects
    where bucket_id = 'document-videos'
      and name =
        '11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/clip.mp4'
  $$,
  'owner can delete a video while its document exists'
);

reset role;
reset "request.jwt.claims";
reset "request.jwt.claim.sub";
reset "request.jwt.claim.role";

-- Atomic maintenance claims skip active leases and reclaim expired leases.
update public.document_media_cleanup_jobs
set
  next_attempt_at = now() + interval '1 day',
  lease_token = null,
  lease_expires_at = null;

insert into public.document_media_cleanup_jobs (
  document_id,
  owner,
  next_attempt_at
)
values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '11111111-1111-4111-8111-111111111111',
  now() - interval '1 minute'
);

create temporary table first_cleanup_claim on commit drop as
select *
from public.claim_document_media_cleanup_jobs(1, 60);

select is(
  (select count(*) from first_cleanup_claim),
  1::bigint,
  'first cleanup worker claims the due job'
);
select is(
  (
    select count(*)
    from public.claim_document_media_cleanup_jobs(1, 60)
  ),
  0::bigint,
  'competing cleanup worker skips an active lease'
);

update public.document_media_cleanup_jobs
set lease_expires_at = now() - interval '1 minute'
where document_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

create temporary table reclaimed_cleanup_job on commit drop as
select *
from public.claim_document_media_cleanup_jobs(1, 60);

select is(
  (select count(*) from reclaimed_cleanup_job),
  1::bigint,
  'cleanup worker reclaims a stale lease'
);
select ok(
  (
    select first_cleanup_claim.lease_token <>
      reclaimed_cleanup_job.lease_token
    from first_cleanup_claim
    cross join reclaimed_cleanup_job
  ),
  'stale cleanup lease receives a new token'
);

-- Expired pending clones are atomically claimed as recovering and cannot be
-- claimed again until the new server lease expires.
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
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '11111111-1111-4111-8111-111111111111',
  'Expired pending clone',
  '',
  'pending',
  '99999999-9999-4999-8999-999999999999',
  now() - interval '1 minute'
);

create temporary table claimed_expired_clone on commit drop as
select *
from public.claim_expired_document_clones(1, 120);

select is(
  (select count(*) from claimed_expired_clone),
  1::bigint,
  'maintenance claims one expired pending clone'
);
select is(
  (select document_id from claimed_expired_clone),
  'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid,
  'expired clone claim returns the expected document'
);
select is(
  (
    select clone_status
    from public.documents
    where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  'recovering',
  'claimed expired clone is marked recovering'
);
select ok(
  (
    select clone_lease_token <>
      '99999999-9999-4999-8999-999999999999'::uuid
    from public.documents
    where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  'claimed expired clone receives a new server lease token'
);
select is(
  (
    select count(*)
    from public.claim_expired_document_clones(1, 120)
  ),
  0::bigint,
  'active recovering clone lease is not claimed twice'
);

select * from finish();
rollback;
