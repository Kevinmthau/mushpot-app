# Mushpot

Minimalist writing app with an infinite Markdown canvas, inspired by distraction-free writing environments.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase (Postgres + Auth + Edge Functions)
- Netlify hosting
- CodeMirror 6 for Markdown editing
- `react-markdown` + `remark-gfm` for Markdown rendering

## Features

- Authenticated document workspace (`/`)
- Infinite-scroll editor canvas (`/doc/[id]`)
- Debounced autosave (500ms) with save status
- Word count + estimated reading time
- Focus mode and typewriter mode
- Share modal with:
  - Enable share link
  - Copy link
  - Rotate link token
  - Disable sharing
- Public shared read view (`/s/[id]/[token]`)

## 1) Supabase Setup

1. Create a Supabase project.
2. In **Authentication > URL Configuration**, set:
   - Site URL: your app URL (local and production as needed)
   - Redirect URLs:
     - `http://localhost:3000/auth/callback`
     - `https://<your-netlify-site>.netlify.app/auth/callback`
3. Create `.env.local` from `.env.example`:

```bash
cp .env.example .env.local
```

4. Fill in:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (required by the `get-shared-doc` edge function)

## 2) Database Schema + RLS

Run this SQL in Supabase SQL Editor (or apply via Supabase migrations):

```sql
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
```

Migration file is included at:
- `supabase/migrations/20260303164000_create_documents.sql`

## 3) Edge Function: `get-shared-doc`

Function path:
- `supabase/functions/get-shared-doc/index.ts`

It validates `docId + token` against `documents.share_enabled` and `documents.share_token`, then returns:

```json
{
  "title": "...",
  "content": "...",
  "updated_at": "..."
}
```

### Deploy edge function

1. Install Supabase CLI and login:

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

2. `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` are injected automatically in hosted Supabase Edge Functions.  
   You do not need to set `SUPABASE_SERVICE_ROLE_KEY` manually in the project secrets.

```bash
# only needed when serving functions locally:
# supabase functions serve --env-file supabase/functions/.env
```

3. Deploy as public function (no JWT required):

```bash
supabase functions deploy get-shared-doc --no-verify-jwt
```

4. Test:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/get-shared-doc" \
  -H "Content-Type: application/json" \
  -H "apikey: <anon-key>" \
  -H "Authorization: Bearer <anon-key>" \
  -d '{"docId":"<doc-id>","token":"<share-token>"}'
```

## 4) Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## 5) Netlify Deployment

### Build settings

- Build command: `npm run build`
- Publish directory: leave default for Next.js runtime
- Plugin: `@netlify/plugin-nextjs` (configured in `netlify.toml`)

### Environment variables in Netlify

Set:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

`SUPABASE_SERVICE_ROLE_KEY` is used by the Supabase Edge Function runtime, not by the Netlify-hosted Next.js app itself.

### Next.js on Netlify notes

- This project uses App Router and is compatible with Netlify’s Next.js runtime.
- Middleware is used for auth route protection.
- Dynamic shared page (`/s/[id]/[token]`) calls Supabase Edge Function with `cache: "no-store"` for fresh content.

## Routes

- `/auth` - email magic-link login
- `/` - authenticated document list + create document
- `/doc/[id]` - authenticated Markdown editor
- `/s/[id]/[token]` - public shared Markdown render
