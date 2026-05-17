# Mushpot

Mushpot is a minimalist Markdown writing app built with Next.js and Supabase. Private documents load through a local IndexedDB cache and reconcile with Supabase in the background, while shared documents are published through a Supabase Edge Function and rendered as clean read-only pages.

## Current Feature Set

- Email magic-link sign-in with PKCE confirmation at `/auth/confirm`
- Authenticated document list with instant document creation
- Markdown editor with title editing, debounced autosave, reading-time display, clone, and delete
- Image upload by drag/drop or paste into Markdown documents via a public Supabase Storage bucket
- Secret bearer share links with enable, copy, rotate, and disable controls
- Public shared document pages with generated Open Graph images
- IndexedDB-backed document cache plus background retry sync for unsaved local edits
- PWA assets including a web app manifest, production service worker, and offline fallback page

## Stack

- Next.js 16 App Router
- React 19 + TypeScript
- Tailwind CSS v4
- CodeMirror 6
- Supabase Auth, Postgres, Storage, and Edge Functions
- `react-markdown` + `remark-gfm` for shared-document rendering

## Routes

- `/auth`: request a magic link
- `/auth/confirm`: exchange the PKCE auth code for a session
- `/auth/callback`: client-side fallback completion page
- `/`: authenticated document list
- `/doc/[id]`: authenticated document editor
- `/s/[id]/[token]`: public shared document
- `/s/[id]/[token]/opengraph-image`: generated social preview image for shared docs

## Repository Layout

- `app/(private)`: authenticated document list and editor routes
- `app/auth`: auth page, server action, PKCE confirm route, fallback callback page
- `app/s/[id]/[token]`: shared document page and Open Graph image route
- `components/auth`: auth form UI
- `components/documents`: document list and create flow
- `components/editor`: editor, share modal, image upload, clone/delete hooks, shared-doc renderer
- `components/pwa`: auth persistence, sync manager, service worker registration
- `lib/`: Supabase clients, document cache, sync helpers, shared-document helpers, markdown utilities
- `supabase/migrations`: database and storage setup
- `supabase/functions/get-shared-doc`: share-token validation and public shared-doc fetch
- `public`: manifest, service worker, offline page, and app icons
- `proxy.ts`: route protection and auth-cookie/session refresh handling

## Architecture Notes

- Private pages are dynamic server routes. Keep `app/(private)/layout.tsx` dynamic so production builds do not try to prerender authenticated Supabase pages.
- Auth redirect path validation and app-origin resolution live in `lib/app-url.ts`. Use those helpers instead of open-coding `next` path or forwarded-host logic.
- Shared document metadata and Open Graph generation use `lib/shared-document.ts`, which calls the `get-shared-doc` Edge Function rather than querying private tables directly.
- Document row select strings, editor/list shapes, and cache/editor mapping helpers live in `lib/documents.ts`.
- `components/documents/use-document-list.ts` owns the cache-first document list load and background Supabase refresh.
- `components/editor/use-editor-document.ts` owns cache-first editor document loading, session validation, and Supabase reconciliation.
- `components/editor/use-document-draft.ts` owns local draft state, debounced IndexedDB writes, autosave retries, and share-state timestamp merging.
- `lib/doc-cache.ts` is best-effort IndexedDB storage. `lib/document-sync.ts` retries dirty cached documents on startup, focus, online, and interval triggers through the PWA startup components.

## Environment Variables

Create `.env.local` with:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
# Optional but recommended when localhost or proxies should redirect to a canonical app URL.
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Notes:

- `NEXT_PUBLIC_APP_URL` is used for auth redirect generation and shared-link origins.
- `npm run build` does not require Supabase env vars, but running authenticated pages does.
- `SUPABASE_SERVICE_ROLE_KEY` is not used by the Next.js app directly. It is required by the Supabase Edge Function runtime when serving `get-shared-doc` locally.

## Supabase Setup

1. Create a Supabase project.
2. In Supabase Auth URL settings, set your Site URL and add full `/auth/confirm` URLs to the allowed redirect list.
   Local example: `http://localhost:3000/auth/confirm`
3. Apply the SQL migrations in `supabase/migrations/`:
   - `20260303164000_create_documents.sql`
   - `20260304102000_create_document_images_bucket.sql`
4. Deploy the public Edge Function used for shared-document reads:

```bash
supabase functions deploy get-shared-doc --no-verify-jwt
```

For local Edge Function serving, provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function runtime.

## Development

```bash
npm install
npm run dev
```

Quality gate before merge:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Unit tests run on [Vitest](https://vitest.dev/). Tests live next to their
sources as `<name>.test.ts`. Use `npm run test:watch` while developing and
`npm run test:coverage` for a coverage report.

## Deployment Notes

- `netlify.toml` is included for Netlify deployments and runs `npm run build`.
- Any Next.js-compatible host can work as long as the public env vars are set and the `get-shared-doc` Supabase Edge Function is deployed.
- The production service worker is registered only in production builds.

## Behavior Notes

- Private routes are protected in `proxy.ts`.
- `/auth/confirm` only redirects to internal app paths from the `next` query param.
- The app favors local cached document data first, then reconciles with Supabase in the background.
- Dirty cached documents are retried on startup, when the app regains focus, and when the browser comes back online.
- Share links are bearer URLs: anyone with the full `/s/[id]/[token]` URL can read that document until the token is rotated or sharing is disabled.
- Uploaded document images live in the public `document-images` bucket; bucket policies restrict who can manage them, but the file URLs themselves are publicly fetchable.
- Shared-document rendering supports GitHub Flavored Markdown and remote/public images, so third-party image hosts can receive reader requests for embedded remote assets.
