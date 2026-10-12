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

## Configuration

Settings such as the database URL and API keys come from environment variables. One server-only module, `lib/config`, reads and validates them. It has one getter per feature: `getDatabaseConfig()`, `getVisionConfig()`, `getSpotifyConfig()`, `getYouTubeConfig()` and `getStorageConfig()`. [`.env.example`](.env.example) lists every variable, with what it is, which feature needs it, where to get it, and its format.

Copy `.env.example` to `.env.local`, then fill in only the groups for the features you work on. Leave the others empty:

```sh
cp .env.example .env.local
```

- Next.js loads `.env.local` for `npm run dev`, `npm run build` and `npm start`. `npm test` does not read it. The tests set their own values, and pass with no variables set.
- Never commit `.env.local`. Git ignores every `.env*` file except `.env.example`.
- Write a `$` in a value as `\$`, because Next.js expands `$NAME` references. For example, write the password `pa$$word` as `pa\$\$word`.
- A missing variable shows up as an error that names it the first time a feature uses it, not when the app starts or builds. The getter for that feature throws a `ConfigError` that lists every missing or invalid variable of its group, but never their values. For example:

  ```text
  Spotify configuration is missing or invalid:
    - SPOTIFY_CLIENT_ID is missing
    - SPOTIFY_CLIENT_SECRET is missing
  ```

In production, set the same variables in the server's environment instead of a file. To add a variable, follow the Rules in [`AGENTS.md`](AGENTS.md).

## Continuous integration

The `CI` workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on GitHub Actions on every push to any branch and on every pull request.

- It uses Node.js 24 on Ubuntu. Other Node.js versions allowed by `engines` are not tested in CI.
- It installs dependencies with `npm ci`, then runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`, in that order. These are the same scripts you run locally. `npm ci` fails if `package-lock.json` is out of sync with `package.json`, so commit both together.
- If one check fails, the later checks still run, so a single run reports every problem. The run is red if any step fails. If the install fails, the checks are skipped.
- It needs no secrets, `.env` file or environment variables.

See the results in the repository's [Actions tab](https://github.com/qwopop/photo-music/actions/workflows/ci.yml), or in the `CI` check shown next to each commit and on each pull request.
