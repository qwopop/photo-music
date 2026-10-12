# AGENTS.md

Photo-to-music website: upload a photo, get its mood, a featured song, a playlist, and Instagram captions. Stack: Next.js (App Router) + TypeScript + PostgreSQL. Plan: `_docs/plan.md`. Backlog: GitHub issues.

## Commands

These match the scripts in `package.json`; update this list if they change.

- `npm install` - install dependencies (CI uses `npm ci`, which fails if `package-lock.json` is out of sync with `package.json`)
- `npm run dev` - start the dev server
- `npm run build` - production build
- `npm start` - serve the production build
- `npm run lint` - lint (`eslint --max-warnings=0`); fails on any warning, not only on errors
- `npm run typecheck` - generates Next's route types first (`next typegen`, into `.next/types/`), then runs `tsc --noEmit`
- `npm test` - the test suite (`vitest run`), without the database tests (`*.db.test.ts`)
- `npx vitest run path/to/file.test.ts` - one test file
- `npm run db:check` - check that the app can connect to the database in `DATABASE_URL`; it loads `.env.local` itself
- `npm run db:generate` - write a SQL migration into `lib/db/migrations` for the changes in `lib/db/schema.ts` (`drizzle-kit generate`; name it with `npm run db:generate -- --name <what_changed>`); needs no database, and writes nothing when the schema has not changed
- `npm run db:migrate` - apply the pending migrations to the database in `DATABASE_URL`; it loads `.env.local` itself
- `npm run test:db` - the database tests (`*.db.test.ts`), against a throwaway database that it creates, migrates and drops on the server in `DATABASE_URL` (on this computer only; the user needs `CREATEDB`); it loads `.env.local` itself
- `docker compose up -d --wait` - start the local PostgreSQL 18 (`docker-compose.yml`, port 54320) and wait until it accepts connections
- `docker compose down` - stop the local database and keep its data (`docker compose down -v` also deletes the data)

CI (`.github/workflows/ci.yml`, GitHub Actions, Node.js 24) runs on every push to any branch and on every pull request. Its `checks` job runs `npm ci`, then "Migrations match the schema" (`npm run db:generate`, which fails the job if it changes or adds a file in `lib/db/migrations`), lint, typecheck, test and build, with no database. Its `database` job starts the database with `docker compose up -d --wait` and runs `npm run db:check`, `npm run db:migrate` and `npm run test:db` (which also runs when the migrations failed). Any failing step turns the run red.

## Rules

- Dependencies are added in `package.json`. Do not add one without asking.
- Never commit secrets. Keep `.env*` files git-ignored and list every variable in `.env.example`.
- Read environment variables only through `lib/config` (lint fails on `process.env` anywhere else). Add a new variable to its schema in `lib/config/schema.ts` and to `.env.example` in the same commit.
- Code that runs outside Next.js, such as scripts and tool config files, reads settings through `lib/config/node.ts` and loads `.env.local` with `node --env-file-if-exists=.env.local`. App code keeps importing `lib/config`.
- Call the `lib/config` getters only while handling a request: in a POST handler or server action, or after a runtime API such as `await connection()` in a GET handler or page. Never call them at module top level or inside `"use cache"` code. This way build and tests need no secrets, and no value ends up in prerendered output.
- Pass SDKs their keys from `lib/config` instead of letting them read their own environment variables, such as the AWS SDK's `AWS_*` or Auth.js's `AUTH_SECRET`.
- Change the database only through migrations. Edit `lib/db/schema.ts`, run `npm run db:generate`, and commit the generated files with the schema change. Never edit a migration that is on `master`.
- App code gets the database from `getDb()` in `lib/db`, and calls it only while handling a request, like the `lib/config` getters.
- Tests that need PostgreSQL are named `*.db.test.ts` and run with `npm run test:db`, never in `npm test`.
- Never recommend or invent tracks that a music provider did not return. If Spotify or YouTube fails, fall back to a search link.
- Do not call the vision API again when regenerating recommendations; reuse the stored analysis.
- Photos are private: no public URLs, and guests' photos are never stored.
- Present moods as interpretations, not facts.
- Do not post to Instagram automatically; generate copy-ready text only.
- Run `npm run lint`, `npm run typecheck`, and `npm test` before committing.

## Documents

- `_docs/process.md` — how work is organized
