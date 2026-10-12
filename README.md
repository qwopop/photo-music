# Photo Music

A website where you upload a photo and get its mood, a featured song, a playlist, and Instagram captions to match.

- Project plan: [`_docs/plan.md`](_docs/plan.md)
- Rules for contributors and coding agents: [`AGENTS.md`](AGENTS.md)

## Requirements

- Node.js 22.12 or newer (an even-numbered release line: 22, 24 or 26+). Node.js 20 is not supported, because Vitest 5 requires Node.js 22.12+. The supported range is declared in `package.json` under `engines`.
- npm (comes with Node.js). Do not use yarn, pnpm or bun.
- Docker with Compose v2, needed only for the [local database](#local-database): Docker Desktop on Windows and macOS, or Docker Engine with the Compose plugin on Linux. Lint, typecheck, test and build need no Docker and no database.

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

## Private temporary image upload

`POST /api/upload` accepts `multipart/form-data` with exactly one file in the
`image` field. JPEG, PNG and WebP are detected from their contents; filenames
and declared MIME types are ignored. The server fully decodes the image with
sharp, rejecting corrupt/truncated data and images above **25,000,000 decoded
pixels** (including all frames of animated images).

The inclusive file limit is **10 MiB (10,485,760 bytes)**. The entire multipart
request, including boundaries and headers, is limited to **10 MiB + 64 KiB
(10,551,296 bytes)**. The actual incoming stream is bounded before multipart
parsing, independently of `Content-Length`. An over-limit chunk is discarded
and the stream is cancelled; no remaining body is read or parsed.

Success is HTTP 201 with `Cache-Control: no-store`:

```json
{
  "upload": {
    "id": "<opaque random handle>",
    "mimeType": "image/jpeg",
    "size": 270,
    "expiresAt": "2026-01-01T00:10:00.000Z"
  }
}
```

The handle has 256 bits of cryptographic randomness and is a private capability:
keep it out of logs and public links. The response contains no photo bytes,
filename, storage path, or URL. `GET /api/upload` returns 405; there is no HTTP
route for retrieving uploaded bytes. All upload responses are uncacheable.

Validated original bytes remain only in process memory, for **10 minutes** after
acceptance. An unref'ed timer deletes them even without a later request. The
temporary store admits at most **100 uploads** and **100 MiB (104,857,600 bytes)**
of original image buffers across all entries. At capacity, another image is
rejected without retention; release, consumption, and expiry restore capacity.
Parsing and bounded image decoding also require transient memory, so these
retained-byte limits are not a total process-memory limit.

Future server-side analysis imports `consumeUpload(id)` or `releaseUpload(id)`
from the server-only `lib/upload/store` module. Consumption removes the entry
before returning `{ bytes, mimeType, size }` and succeeds once. Unknown,
expired, consumed or released handles return `undefined`; release is idempotent.
Guests and signed-in users share this temporary path. Uploading requires no
login, database, object storage, API key or external call, and never saves a
photo to disk, `public/`, logs or photo history.

This process-local store loses uploads when the server restarts. A handle must
be processed by the same instance; it cannot move between workers or serverless
instances. Durable deployment design belongs to issue #33.

Failures have `{ "error": { "code": "...", "message": "..." } }`, with fixed
safe messages and no underlying exception details:

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `INVALID_UPLOAD` | Non-multipart, malformed body, missing boundary, or a missing/duplicate/non-file `image` field |
| 415 | `INVALID_IMAGE` | Empty, unsupported, corrupt or over-pixel-limit image |
| 413 | `FILE_TOO_LARGE` | File exceeds 10 MiB |
| 413 | `REQUEST_TOO_LARGE` | Multipart body exceeds 10 MiB + 64 KiB |
| 503 | `UPLOAD_CAPACITY_EXCEEDED` | Temporary entry or retained-byte capacity is full |
| 500 | `UPLOAD_FAILED` | Unexpected internal failure |

Start `npm run dev`, then run this local smoke check from the repository root
using the synthetic fixture (no personal photo is needed):

```sh
curl --silent --show-error --include \
  -F 'image=@lib/upload/fixtures/sample.jpg;type=image/jpeg' \
  http://localhost:3000/api/upload
```

Do not paste a live upload handle into public logs or issue comments. Release
it through the server-only API after processing, or let its ten-minute TTL expire.

## Configuration

Settings such as the database URL and API keys come from environment variables. One server-only module, `lib/config`, reads and validates them. It has one getter per feature: `getDatabaseConfig()`, `getVisionConfig()`, `getSpotifyConfig()`, `getYouTubeConfig()` and `getStorageConfig()`. [`.env.example`](.env.example) lists every variable, with what it is, which feature needs it, where to get it, and its format.

Copy `.env.example` to `.env.local`, then fill in only the groups for the features you work on. Leave the others empty:

```sh
cp .env.example .env.local
```

- Next.js loads `.env.local` for `npm run dev`, `npm run build` and `npm start`. `npm test` does not read it. The tests set their own values, and pass with no variables set.
- `npm run db:check` runs outside Next.js and loads only `.env.local` (not `.env` or other `.env.*` files), using Node's own parser (`node --env-file-if-exists=.env.local`). As in Next.js, a variable set in the shell wins over the file. Node's parser neither expands `$NAME` nor unescapes `\$`.
- Never commit `.env.local`. Git ignores every `.env*` file except `.env.example`.
- Write a `$` in a value as `\$`, because Next.js expands `$NAME` references. For example, write the password `pa$$word` as `pa\$\$word`. The database password is the exception: percent-encode its special characters in `DATABASE_URL` instead (`$` as `%24`, `@` as `%40`), so that the URL reads the same in Next.js and in `npm run db:check`. For example, the password `pa$$word` becomes `pa%24%24word`.
- A missing variable shows up as an error that names it the first time a feature uses it, not when the app starts or builds. The getter for that feature throws a `ConfigError` that lists every missing or invalid variable of its group, but never their values. For example:

  ```text
  Spotify configuration is missing or invalid:
    - SPOTIFY_CLIENT_ID is missing
    - SPOTIFY_CLIENT_SECRET is missing
  ```

In production, set the same variables in the server's environment instead of a file. To add a variable, follow the Rules in [`AGENTS.md`](AGENTS.md).

## Local database

The app stores its data in PostgreSQL 18. [`docker-compose.yml`](docker-compose.yml) runs it in Docker for development, with fixed development credentials. The data lives in a Docker volume, not in the repo.

Start the database. The command returns once the database accepts connections. The first start also downloads the image and creates the database, which takes a little longer:

```sh
docker compose up -d --wait
```

Then set this URL in `.env.local` (copied from `.env.example`, see [Configuration](#configuration)):

```text
DATABASE_URL=postgresql://photo_music:photo_music_dev@localhost:54320/photo_music
```

Check that the app can connect. It prints one line with the PostgreSQL version, the database and the user, or else the reason it could not connect:

```sh
npm run db:check
```

Stop the database and keep its data:

```sh
docker compose down
```

Delete all data and start over. You need this after changing the credentials or the PostgreSQL major version in `docker-compose.yml`, because the image applies those only when it creates a new, empty volume:

```sh
docker compose down -v
docker compose up -d --wait
```

Open a SQL shell (`\q` quits):

```sh
docker compose exec db psql -U photo_music -d photo_music
```

- The database listens only on this computer (`127.0.0.1`), on port 54320 rather than PostgreSQL's usual 5432, so that it does not clash with a PostgreSQL server that is already installed and listening on 5432. Because nothing else can reach it, the credentials are development defaults rather than secrets, and they are committed.
- Without Docker, any PostgreSQL 18 server works: create a user and a database for the app, point `DATABASE_URL` in `.env.local` at that server, and run `npm run db:check`.

## Continuous integration

The `CI` workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on GitHub Actions on every push to any branch and on every pull request. It has two jobs, `checks` and `database`, which run side by side on Ubuntu with Node.js 24. Other Node.js versions allowed by `engines` are not tested in CI. The run is red if any step of either job fails.

The `checks` job:

- It installs dependencies with `npm ci`, then runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`, in that order. These are the same scripts you run locally. `npm ci` fails if `package-lock.json` is out of sync with `package.json`, so commit both together.
- If one check fails, the later checks still run, so a single run reports every problem. If the install fails, the checks are skipped.
- It needs no secrets, `.env` file, environment variables or database.

The `database` job:

- It installs dependencies with `npm ci`, starts the database from `docker-compose.yml` with `docker compose up -d --wait`, and runs `npm run db:check`, as described in [Local database](#local-database).
- If a step fails, it prints the database container's log (`docker compose logs db`). At the end it always removes the container and its volume with `docker compose down -v`.
- It sets only `DATABASE_URL`, to the local URL from `.env.example`, which is not a secret. It uses no secrets.

See the results in the repository's [Actions tab](https://github.com/qwopop/photo-music/actions/workflows/ci.yml), or in the `CI` check shown next to each commit and on each pull request.
