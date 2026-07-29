# Mushpot

Mushpot is a minimalist Markdown writing app built with Next.js and Supabase. Private documents load through a local IndexedDB cache and reconcile with Supabase in the background, while shared documents are published through a Supabase Edge Function and rendered as clean read-only pages.

## Current Feature Set

- Email magic-link sign-in with a scanner-resistant `/auth/verify` step and PKCE/token confirmation
- Authenticated document list with instant document creation
- Markdown editor with title editing, debounced autosave, reading-time display, clone, and delete
- Image and video upload by drag/drop or paste into private Supabase Storage buckets
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
- `/auth/verify`: user-confirmed email link verification
- `/auth/confirm`: exchange the PKCE auth code or token hash for a session
- `/auth/callback`: client-side fallback completion page
- `/`: authenticated document list
- `/doc/[id]`: authenticated document editor
- `/m/[bucket]/[...path]`: authenticated redirect to short-lived document-media URLs
- `/s/[id]/[token]`: public shared document
- `/s/[id]/[token]/m/[bucket]/[...path]`: share-validated redirect to short-lived document-media URLs
- `/s/[id]/[token]/opengraph-image`: generated social preview image for shared docs

## Repository Layout

- `app/(private)`: authenticated document list and editor routes
- `app/auth`: auth page, server action, verify page, PKCE/token confirm route, fallback callback page
- `app/s/[id]/[token]`: shared document page, media redirect, and Open Graph image route
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
# Required in production. Optional in local development when CAPTCHA is disabled.
NEXT_PUBLIC_TURNSTILE_SITE_KEY=...
```

Notes:

- `NEXT_PUBLIC_APP_URL` is used for auth redirect generation and shared-link origins.
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is Cloudflare Turnstile's public site key. Production sign-in fails closed when it is missing; local development can omit it.
- `npm run build` does not require Supabase env vars, but running authenticated pages does.
- `SUPABASE_SERVICE_ROLE_KEY` is not used by the Next.js app directly. It is required by the Supabase Edge Function runtime when serving `get-shared-doc` locally.
- Set the Edge Function secret `ALLOWED_ORIGINS` to the comma-separated app origins that may invoke `get-shared-doc` from a browser. Server-to-server calls do not send an `Origin` header.

## Supabase Setup

1. Create a Supabase project.
2. In Supabase Auth URL settings, set your Site URL and add full `/auth/verify` and `/auth/confirm` URLs to the allowed redirect list.
   Local examples: `http://localhost:3000/auth/verify`, `http://localhost:3000/auth/confirm`
3. Configure a custom SMTP server for Supabase Auth magic-link email delivery:
   - In Resend, verify the sending domain and create an API key for SMTP.
   - In Supabase Dashboard, open Authentication email settings and enable custom SMTP.
   - Use host `smtp.resend.com`, port `465`, username `resend`, and the Resend API key as the password.
   - Use a verified-domain sender address, such as `no-reply@yourdomain.com`, with sender name `Mushpot`.
   - Do not store the Resend API key in this repository or in the Next.js app environment.
   - After saving, review Supabase Auth email rate limits before public launch.
4. Configure CAPTCHA protection for magic-link requests:
   - Create a Cloudflare Turnstile widget and allow the production app hostname. Add `localhost` when testing the widget locally.
   - Put the widget's public site key in `NEXT_PUBLIC_TURNSTILE_SITE_KEY` for the deployed Next.js app.
   - In Supabase Dashboard, open **Authentication > Bot and Abuse Protection**, enable CAPTCHA, select Cloudflare Turnstile, and save the widget's secret key there.
   - Keep the Turnstile secret out of this repository and out of all `NEXT_PUBLIC_` environment variables.
   - Local development may omit the site key to disable CAPTCHA. Production deliberately rejects magic-link requests when the site key is missing.
5. Update the Supabase Auth Confirm signup and Magic Link templates so scanners do not consume one-time links before the user opens them:

```html
<h2>Open Mushpot</h2>
<p>Continue to finish signing in.</p>
<p>
  <a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email">Open Mushpot</a>
</p>
```

   The app always sends `emailRedirectTo` as `/auth/verify?next=...`, so the `&token_hash=...` suffix is expected.
6. Apply every SQL migration in `supabase/migrations/` in chronological order.
   The final private-media policy change is
   `20260717172439_secure_private_document_media.sql`.
7. Deploy the public Edge Function used for shared-document reads:

```bash
supabase functions deploy get-shared-doc --no-verify-jwt
```

For local Edge Function serving, provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function runtime.

### Auth Email Verification

After custom SMTP and the custom email templates are enabled, verify the production auth flow with an email address outside the Supabase project team. Request a link from `/auth`, confirm it arrives from the configured Resend sender, open the email link, press Continue on `/auth/verify`, and confirm the app signs in. Check Resend delivery logs and Supabase Auth logs if the email is delayed or rejected.

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
- For the private-media rollout, deploy the updated Next.js app and
  `get-shared-doc` Edge Function before applying the final private-bucket
  migration, or release all three together. Applying only the migration makes
  legacy shared media unavailable until the updated application code is live.
- Media left behind by documents deleted before this release becomes private
  but is not removed automatically. Inventory and remove those pre-existing
  orphans with an administrator/service-role maintenance job.

## Behavior Notes

- Private routes are protected in `proxy.ts`.
- `/auth/verify` and `/auth/confirm` only redirect to internal app paths from the `next` query param.
- The app favors local cached document data first, then reconciles with Supabase in the background.
- Dirty cached documents are retried on startup, when the app regains focus, and when the browser comes back online.
- Share links are bearer URLs: anyone with the full `/s/[id]/[token]` URL can read that document until the token is rotated or sharing is disabled.
- Uploaded media lives in private, owner-scoped `document-images` and `document-videos` buckets. Documents store stable `/m/...` paths; authenticated owner views and public share responses exchange those paths for short-lived signed Storage URLs.
- Media URLs retained by documents cloned before the private-media rollout remain usable. Deleting a source document is blocked while another document still references media from its folder.
- Deletion records a durable media-cleanup job before removing the document row, and signed-in startup maintenance retries interrupted cleanup. Interrupted clones are similarly recovered after a grace period so partial media and permanent “copying…” rows do not accumulate.
- Shared-document rendering supports GitHub Flavored Markdown and remote/public images, so third-party image hosts can receive reader requests for embedded remote assets.
