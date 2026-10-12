# Photo Music

A website where you upload a photo and get its mood, a featured song, a playlist, and Instagram captions to match.

- Project plan: [`_docs/plan.md`](_docs/plan.md)
- Rules for contributors and coding agents: [`AGENTS.md`](AGENTS.md)

## Requirements

- Node.js 22.12 or newer (an even-numbered release line: 22, 24 or 26+). Node.js 20 is not supported, because Vitest 5 requires Node.js 22.12+. The supported range is declared in `package.json` under `engines`.
- npm (comes with Node.js). Do not use yarn, pnpm or bun.

## Commands

Install dependencies:

```sh
npm install
```

Start the dev server, then open http://localhost:3000:

```sh
npm run dev
```

Create a production build:

```sh
npm run build
```

Serve the production build (run `npm run build` first):

```sh
npm start
```

Lint (`eslint --max-warnings=0`). This fails on any lint warning, not only on errors:

```sh
npm run lint
```

Type-check. This first runs `next typegen`, which generates Next's route types (such as `PageProps` and `LayoutProps`) into `.next/types/`, then runs `tsc --noEmit`. It works on a fresh clone without a build or dev run first:

```sh
npm run typecheck
```

Run the whole test suite once:

```sh
npm test
```

Run a single test file:

```sh
npx vitest run lib/greeting.test.ts
```

## Continuous integration

The `CI` workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on GitHub Actions on every push to any branch and on every pull request.

- It uses Node.js 24 on Ubuntu. Other Node.js versions allowed by `engines` are not tested in CI.
- It installs dependencies with `npm ci`, then runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`, in that order. These are the same scripts you run locally. `npm ci` fails if `package-lock.json` is out of sync with `package.json`, so commit both together.
- If one check fails, the later checks still run, so a single run reports every problem. The run is red if any step fails. If the install fails, the checks are skipped.
- It needs no secrets, `.env` file or environment variables.

See the results in the repository's [Actions tab](https://github.com/qwopop/photo-music/actions/workflows/ci.yml), or in the `CI` check shown next to each commit and on each pull request.

<!-- QA throwaway PR for #2, first commit. Do not merge. -->
<!-- QA throwaway PR for #2, second commit. -->
