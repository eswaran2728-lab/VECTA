# AVSEC OPS

A Progressive Web App that digitizes AirAsia AVSEC's four daily security reports
(SEC 016, SEC 014, SEC 029, SEC 018) into one platform with role-based access, a live
supervisor dashboard, and PDF/Excel export.

## Stack

- Next.js 14 (App Router) + TypeScript (strict) + Tailwind CSS
- Supabase (Postgres, Auth, Row Level Security)
- Offline-first PWA: service worker app-shell cache + IndexedDB submission queue
- `@react-pdf/renderer` (form-faithful PDF export) and `xlsx` (Excel export)

## Getting started

1. Create a Supabase project.
2. Run the SQL migrations in `supabase/migrations/` in order (via the SQL editor, or
   `supabase db push` if you're using the CLI locally):
   - `0001_init_schema.sql` — reference tables, profiles, report tables, immutability triggers
   - `0002_rls.sql` — row level security policies
   - `0003_drafts.sql` — server-side draft storage
3. Copy `.env.example` to `.env.local` and fill in your Supabase project URL and anon key.
4. `npm install`
5. `npm run dev`

New users get a `profiles` row automatically on sign-up (via an `auth.users` trigger) with
role `OFFICER`; promote users to `SUPERVISOR` / `MANAGER` / `ADMIN` directly in the
`profiles` table (or build an admin UI on top of it — the schema and RLS already support it).

Auth is email magic-link (Supabase OTP) — no passwords to manage in the field.

## Project structure

- `src/app/reports/{sec016,sec014,sec029,sec018}` — the four report forms
- `src/app/reports/view/[type]/[id]` — read-only form-faithful report viewer
- `src/app/dashboard` — supervisor/manager dashboard (today view, shift compliance,
  bay board flags, flight coverage, shift summary, filters)
- `src/app/bay-board` — aircraft on-ground log + 4-hour SEC 029 flag
- `src/lib/schemas` — zod validation, one file per report, shared client + server side
- `src/lib/reports/actions.ts` — submit server actions (insert immutable `submitted` rows)
- `src/lib/reports/drafts.ts` — server-side draft autosave
- `src/lib/offline` — IndexedDB offline submission queue, sync provider, local draft autosave
- `src/lib/export` — PDF (`@react-pdf/renderer`) and Excel (`xlsx`) export
- `public/sw.js`, `public/manifest.json` — PWA app shell + install manifest

## Notes

- Submitted reports are immutable at the database level (a trigger blocks
  `UPDATE`/`DELETE` once `status = 'submitted'`); corrections should be modeled as a new
  submission referencing the original via `amendment_of`.
- `src/lib/supabase/database.types.ts` is a minimal hand-written stub. Once the Supabase
  project is linked, regenerate real types with `supabase gen types typescript` and
  re-parameterize the clients in `src/lib/supabase/{client,server,middleware}.ts`.
- PWA icons ship as a single SVG (`public/icons/icon.svg`) referenced from the manifest.
  For pixel-perfect iOS home-screen icons, export PNG sizes (180×180 apple-touch-icon,
  192/512 manifest icons) from that SVG and update `manifest.json` / `layout.tsx`.
