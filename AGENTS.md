# AGENTS.md

## Purpose
This repo is a minimalist writing app with an infinite-scroll Markdown editor, Supabase auth/data, and Netlify hosting.

## Tech Stack
- Next.js App Router + TypeScript + Tailwind
- CodeMirror 6 for Markdown editing
- `react-markdown` + `remark-gfm` for read rendering
- Supabase (Postgres, Auth, Edge Functions)
- Netlify deployment with `@netlify/plugin-nextjs`

## Core Product Constraints
- Keep documents as continuous vertical canvases (no page breaks/pagination UI).
- Keep UI distraction-free: centered writing column, minimal chrome, calm styling.
- `/` and `/doc/*` must require login.
- `/s/[id]/[token]` must stay public and read-only.

## Important Paths
- App routes:
  - `app/page.tsx` (documents list)
  - `app/doc/[id]/page.tsx` (editor)
  - `app/s/[id]/[token]/page.tsx` (shared view)
  - `app/auth/*` (magic link auth)
- Editor/UI:
  - `components/editor/editor-client.tsx`
  - `components/editor/share-modal.tsx`
- Supabase clients:
  - `lib/supabase/client.ts`
  - `lib/supabase/server.ts`
- Middleware/protection:
  - `proxy.ts`
- Database migration:
  - `supabase/migrations/20260303164000_create_documents.sql`
- Edge function:
  - `supabase/functions/get-shared-doc/index.ts`

## Local Dev
- Install: `npm install`
- Dev server: `npm run dev`
- Lint: `npm run lint`
- Build: `npm run build`

Always run lint + build before finishing changes.

## Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key is acceptable)
- `SUPABASE_SERVICE_ROLE_KEY` (do not expose client-side)

Never commit `.env*` files or secrets.

## Data/Auth Rules
- `documents.owner` must map to `auth.users.id`.
- RLS must enforce owner-only CRUD in `public.documents`.
- Keep `updated_at` behavior intact (trigger-based update).

## Sharing Rules
- Share links must require both `docId` and `share_token`.
- Token should remain high entropy (current implementation uses 64-char NanoID).
- Shared fetch path goes through `get-shared-doc` edge function.
- Do not bypass token validation by querying document content directly from public clients.

## Deployment Notes
- Netlify runtime via `netlify.toml`.
- Supabase edge function deploy command:
  - `supabase functions deploy get-shared-doc --no-verify-jwt`
- Ensure Supabase Auth redirect URL includes:
  - `/auth/callback` for local and production domains.

## Change Guidance
- Prefer small, focused edits.
- If schema changes, add a new migration file (do not rewrite existing applied migrations).
- Preserve existing writing-focused UX (focus mode, typewriter mode, autosave status, word count, reading time).
