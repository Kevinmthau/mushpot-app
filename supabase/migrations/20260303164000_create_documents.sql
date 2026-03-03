create extension if not exists pgcrypto;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled',
  content text not null default '',
  share_enabled boolean not null default false,
  share_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_owner_updated_at_idx
  on public.documents (owner, updated_at desc);

create index if not exists documents_id_share_token_idx
  on public.documents (id, share_token);

create or replace function public.set_documents_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
before update on public.documents
for each row
execute function public.set_documents_updated_at();

alter table public.documents enable row level security;

create policy "Owners can select own documents"
  on public.documents
  for select
  using (auth.uid() = owner);

create policy "Owners can insert own documents"
  on public.documents
  for insert
  with check (auth.uid() = owner);

create policy "Owners can update own documents"
  on public.documents
  for update
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create policy "Owners can delete own documents"
  on public.documents
  for delete
  using (auth.uid() = owner);
