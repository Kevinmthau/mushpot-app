insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'document-images',
  'document-images',
  true,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/svg+xml'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'document-videos',
  'document-videos',
  true,
  104857600,
  array[
    'video/mp4',
    'video/quicktime'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read own document videos" on storage.objects;
create policy "Users can read own document videos"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'document-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.documents
      where documents.owner = auth.uid()
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

drop policy if exists "Users can upload own document videos" on storage.objects;
create policy "Users can upload own document videos"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'document-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.documents
      where documents.owner = auth.uid()
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

drop policy if exists "Users can update own document videos" on storage.objects;
create policy "Users can update own document videos"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'document-videos'
    and owner = auth.uid()
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.documents
      where documents.owner = auth.uid()
        and documents.id::text = (storage.foldername(name))[2]
    )
  )
  with check (
    bucket_id = 'document-videos'
    and owner = auth.uid()
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.documents
      where documents.owner = auth.uid()
        and documents.id::text = (storage.foldername(name))[2]
    )
  );

drop policy if exists "Users can delete own document videos" on storage.objects;
create policy "Users can delete own document videos"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'document-videos'
    and owner = auth.uid()
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.documents
      where documents.owner = auth.uid()
        and documents.id::text = (storage.foldername(name))[2]
    )
  );
