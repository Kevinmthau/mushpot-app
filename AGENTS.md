# Repository Guidelines

## Project Structure & Module Organization
This is a Next.js App Router project with TypeScript, Tailwind v4, Supabase, and a client-side document cache.
- `app/(private)`: authenticated document list and editor routes (`/`, `/doc/[id]`)
- `app/auth`: magic-link sign-in UI, server action, PKCE confirm route, and fallback callback page
- `app/s/[id]/[token]`: public shared-document page plus Open Graph image route
- `components/auth`: auth form and submit state UI
- `components/documents`: document list and create-document flow
- `components/editor`: editor shell, share modal, clone/delete hooks, image upload, and shared-document renderer
- `components/pwa`: auth persistence, retry sync, and service worker registration
- `lib/`: document cache/sync helpers, shared-document helpers, markdown utilities, and Supabase clients/types
- `supabase/`: SQL migrations plus the `get-shared-doc` Edge Function
- `public/`: manifest, service worker, offline page, and app icons
- `proxy.ts`: auth protection and Supabase session/cookie handling for private routes

## Build, Test, and Development Commands
- `npm run newchange -- <branch-name>`: create a task branch from local `main`
- `npm install`: install dependencies
- `npm run dev`: start local dev server at `http://localhost:3000`
- `npm run lint`: run ESLint checks
- `npm run build`: create production build (required before merge)
- `npm run start`: run built app locally

Use `npm run lint && npm run build` before opening a PR.

## Coding Style & Naming Conventions
- Language: TypeScript (`.ts`/`.tsx`), 2-space indentation, semicolons enabled.
- Follow ESLint config in `eslint.config.mjs`; do not disable rules without rationale.
- Components: PascalCase exports (`AuthForm`, `EditorClient`).
- Route files and utility modules: lowercase file names where practical.
- Keep changes focused and preserve the writing-first, cache-first UX.
- Preserve the current auth flow shape: magic links redirect to `/auth/confirm`, not directly to protected routes.
- When changing document rendering or sharing behavior, keep editor output and shared-document rendering aligned.

## Testing Guidelines
There is no dedicated test framework configured yet. Current quality gate is:
- lint (`npm run lint`)
- production build (`npm run build`)

When adding tests, colocate them near feature code and use clear names like `feature-name.test.ts`.
Manual verification matters for auth, autosave/sync, sharing, and image uploads when those areas are touched.

## Commit & Pull Request Guidelines
Recent history favors short, imperative commit messages (e.g., `Prefer app URL for magic-link redirect on localhost`).
- Keep commit scope small and coherent.
- Reference affected areas in the commit body when useful.

PRs should include:
- concise problem/solution summary
- screenshots for UI changes
- notes on env/config or migration impacts
- manual verification steps (routes, auth, sharing flow)

## Branch Workflow
- Never commit directly to `main`.
- Before starting a requested change, create a dedicated branch from local `main`.
- Use `npm run newchange -- <branch-name>` to create the branch.
- Keep one task per branch so each change can be reviewed in its own PR.
- Push the branch and open a PR for review before merging.

## Security & Configuration Tips
- Required env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Optional app URL override: `NEXT_PUBLIC_APP_URL` for auth/share URL generation, especially on localhost or behind proxies.
- Never commit `.env*` or service-role secrets.
- `SUPABASE_SERVICE_ROLE_KEY` belongs in the Supabase Edge Function runtime, not the Next.js app env.
- Keep shared-document token validation in the Supabase Edge Function path.
- Keep `document-images` storage access owner-scoped via Supabase policies.
