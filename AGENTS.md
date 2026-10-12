# AGENTS.md

Photo-to-music website: upload a photo, get its mood, a featured song, a playlist, and Instagram captions. Stack: Next.js (App Router) + TypeScript + PostgreSQL. Plan: `_docs/plan.md`. Backlog: GitHub issues.

## Commands

The project is not scaffolded yet (issue #1). These are the intended commands; update this list if the real scripts differ.

- `npm install` - install dependencies
- `npm run dev` - start the dev server
- `npm run build` - production build
- `npm run lint` - lint
- `npm run typecheck` - TypeScript check (`tsc --noEmit`)
- `npm test` - the whole test suite
- `npx vitest run path/to/file.test.ts` - one test file

## Rules

- Dependencies are added in `package.json`. Do not add one without asking.
- Never commit secrets. Keep `.env*` files git-ignored and list every variable in `.env.example`.
- Never recommend or invent tracks that a music provider did not return. If Spotify or YouTube fails, fall back to a search link.
- Do not call the vision API again when regenerating recommendations; reuse the stored analysis.
- Photos are private: no public URLs, and guests' photos are never stored.
- Present moods as interpretations, not facts.
- Do not post to Instagram automatically; generate copy-ready text only.
- Run `npm run lint`, `npm run typecheck`, and `npm test` before committing.

## Documents

- `_docs/process.md` — how work is organized
