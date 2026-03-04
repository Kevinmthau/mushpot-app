# Repository Guidelines

## Project Structure & Module Organization
This is a Next.js App Router project (`app/`) with TypeScript and Tailwind.
- `app/`: route handlers and pages (`/`, `/auth`, `/doc/[id]`, `/s/[id]/[token]`)
- `components/`: UI and feature components (editor + auth)
- `lib/supabase/`: browser/server Supabase clients and generated types
- `supabase/`: SQL migrations and Edge Function source
- `public/`: static assets
- `proxy.ts`: auth protection for private routes

## Build, Test, and Development Commands
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
- Keep changes focused and preserve writing-first UX behavior.

## Testing Guidelines
There is no dedicated test framework configured yet. Current quality gate is:
- lint (`npm run lint`)
- production build (`npm run build`)

When adding tests, colocate them near feature code and use clear names like `feature-name.test.ts`.

## Commit & Pull Request Guidelines
Recent history favors short, imperative commit messages (e.g., `Prefer app URL for magic-link redirect on localhost`).
- Keep commit scope small and coherent.
- Reference affected areas in the commit body when useful.

PRs should include:
- concise problem/solution summary
- screenshots for UI changes
- notes on env/config or migration impacts
- manual verification steps (routes, auth, sharing flow)

## Security & Configuration Tips
- Required env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Optional hardening var: `NEXT_PUBLIC_APP_URL` for redirect overrides.
- Never commit `.env*` or service-role secrets.
- Keep shared-document token validation in the Supabase Edge Function path.
