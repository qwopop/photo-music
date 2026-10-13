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

Run the test suite once. It needs no database: the tests that need PostgreSQL run with `npm run test:db` instead (see [Database tests](#database-tests)):

```sh
npm test
```

Run a single test file:

```sh
npx vitest run lib/greeting.test.ts
```

## Private temporary image upload

`POST /api/upload` accepts `multipart/form-data` with exactly one file in the
`image` field. JPEG, **static PNG** and WebP (including animated WebP) are
detected from their contents; filenames and declared MIME types are ignored.
The server fully decodes the image with sharp, rejecting corrupt/truncated data
and images above **25,000,000 decoded pixels** (including all WebP animation
frames together).

PNG has two checks, and both must pass. First, before any decoder runs, a
bounded linear scan of the bytes requires a complete PNG datastream: valid
chunk lengths and CRCs, `IHDR` first, consecutive `IDAT` chunks and a complete
terminal `IEND` (bytes after `IEND` are not part of the image and are ignored).
sharp alone can recover pixels from a PNG whose `IEND` is missing or cut off,
so such a file is rejected here. Second, sharp decodes every pixel.

**APNG (animated PNG) is not supported and is rejected.** A PNG containing any
`acTL`, `fcTL` or `fdAT` animation chunk before its `IEND` fails with HTTP 415
`INVALID_IMAGE` during that first scan, before decoding and before anything is
retained. This applies whether the default image is part of the animation or a
separate fallback image, to incomplete animation chunk sequences, and whatever
filename or MIME type the client sends. APNG frames are never reconstructed or
decoded, and the declared frame count or size never drives allocation, loops
or decompression. No request field, header, query parameter, filename or MIME
type can change this policy.

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
Analysis that uses a public upload handle therefore only ever receives an image
admitted by this strict public policy: never an APNG or an incomplete PNG.
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
| 415 | `INVALID_IMAGE` | Empty, unsupported, corrupt, incompletely framed (for example a PNG without a complete `IEND`), animated PNG (APNG) or over-pixel-limit image |
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

The synthetic PNG/APNG fixtures in `lib/image/fixtures/` (see its README)
exercise the rejections: for example, `apng-default-frame.apng` or
`missing-iend.png` returns 415 `INVALID_IMAGE`, even when sent as
`type=image/jpeg`.

Do not paste a live upload handle into public logs or issue comments. Release
it through the server-only API after processing, or let its ten-minute TTL expire.

## Accounts

Accounts are optional; guests can still use the home page and upload without a database.
To try sign-up locally:

```sh
docker compose up -d --wait
npm run db:migrate
npm run dev
```

Open `/signup`. Emails are trimmed, keep their letter case, follow Zod 4's default
`z.email()` pattern and have at most 254 characters. Account uniqueness and login
ignore letter case; plus-addresses remain distinct accounts. Passwords are
NFKC-normalized before hashing and checking, with 8–128 Unicode code points,
including spaces (spaces are not trimmed). There are no other password rules.
Passwords use argon2id with memory 19,456 KiB, two iterations and parallelism one.

Sessions last 30 days from sign-in and are never extended. The
`photo_music_session` cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`,
with no `Domain`; its value is a random 32-byte base64url token. Only the token's
SHA-256 hash is stored in `sessions`. Logging out submits a POST, removes the
cookie and ends that browser's session on the server. Other browsers stay signed
in. Secure cookies need HTTPS in deployment; modern browsers also support them
on trustworthy localhost origins.

Later server code uses `getCurrentUser()` from `lib/auth` only while handling a
request. Check it in every server action, route handler and page that reads or
changes a user's data, and never cache it or its session lookup. It returns only
`{ id, email }` or `null`; a database outage throws so callers do not mistake it
for a guest. The header catches such outages and keeps public pages available.
No password, hash, token or database error detail is logged or returned in form
state. Failed forms preserve only the email and their safe messages.

Repeated-attempt limits do not exist yet (#41). Changing or resetting a password
and verifying email ownership do not exist yet (#40).

## Dominant photo palette

Server-side analysis and result-page theming share this contract from
`lib/palette` (a server-only module):

```ts
import { extractPalette, type PaletteResult } from "@/lib/palette";

// extractPalette(bytes: Buffer): Promise<PaletteResult>
// PaletteResult = { colors: string[]; brightness: number }
const palette = await extractPalette(photoBytes);
```

For a lossless photo with three red pixels and one blue pixel, the result is:

```json
{
  "colors": ["#ff0000", "#0000ff", "#0000ff", "#0000ff", "#0000ff", "#0000ff"],
  "brightness": 0.1775
}
```

`colors` always contains six lowercase `#rrggbb` slots. The deterministic
algorithm decodes JPEG, PNG or WebP, converts pixels to sRGB, and samples at
most **256×256 (65,536) pixels** with nearest-neighbor resizing inside that box,
preserving aspect ratio and never enlarging an image. It groups nearby shades
into **5-bit-per-channel RGB buckets** (at most 32,768 buckets). Each bucket's
representative is its rounded alpha-weighted mean RGB, ordered by decreasing
alpha weight; ties use ascending hex color value. The six most prevalent
representatives are returned. With fewer than six, the least-prevalent returned
color repeats to fill the remaining slots while preserving order. Solid images
repeat their actual color; no white, black or other filler color is invented.
Sampling can omit very small regions in a large image, and colors are visual
representatives rather than mood interpretations or accessibility guarantees.

`brightness` is finite and in **[0, 1]**. It measures all sampled visible pixels,
independently of the palette's six entries, using the mean normalized sRGB
weighted brightness:

```text
per-pixel brightness = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255
result = sum(alpha * per-pixel brightness) / sum(alpha)
```

Fully transparent pixels contribute no color or brightness; partially
transparent pixels contribute proportionally to alpha. A black image yields 0,
a white image 1, and equal black/white regions approximately 0.5. An image with
no visible sampled pixels rejects with `PaletteError.code = "NO_VISIBLE_PIXELS"`
and the fixed message `The image has no visible pixels.`

Animated **WebP uses its first visual frame** for the palette, while
validation still decodes all WebP frames and checks their aggregate pixel
count.

Direct extraction reuses the upload validator, including its **10 MiB file
limit**, **25,000,000 decoded-pixel limit** and the PNG container check
(complete chunk framing, CRCs and the mandatory terminal `IEND`) before
sampling. Empty, unsupported, malformed, corrupt or truncated content rejects
with the fixed safe `INVALID_IMAGE` error; an oversized file uses
`FILE_TOO_LARGE`.

`extractPalette` is a direct server-side utility, not public upload admission,
and it differs from upload in one way: for APNG it explicitly requests the
validator's internal **default-image** policy instead of rejecting. For a
well-framed APNG it uses **the PNG's default `IDAT` image**, which may differ
from the first animation frame. The container/CRC/`IEND` check and the file
and default-image pixel limits still apply, but the APNG animation chunks are
opaque: their frames are not decoded, selected or validated, and their
aggregate pixels are not bounded. `POST /api/upload` always uses the rejecting
policy, and no client input can select the internal one.
`PaletteError` exposes only a stable code and fixed user-facing message, with no decoder
details or photo logging. Original bytes are never mutated, cached or written
to disk; extraction requires no database, network service or API key.

The later analysis API (#12) will call this function using a consumed private
upload buffer, which the strict public policy has already admitted (so it is
never an APNG), and the results page (#13) will receive the shared
`PaletteResult`, including repeated color slots. This issue adds no HTTP route
or page styling.

## Shared mood interpretation

Browser and server code import the same plain data contract:

```ts
import {
  PRIMARY_EMOTIONS, moodResultSchema, moodResultJsonSchema,
  type PrimaryEmotion, type MoodResult,
} from "@/lib/mood";

const result: MoodResult = moodResultSchema.parse(untrustedResult);
// Or use moodResultSchema.safeParse(untrustedResult) to inspect success/errors.
// moodResultJsonSchema is generated from this Zod schema, using Zod 4's API.
```

Every result has exactly four required fields:

| Field | Bounds |
| --- | --- |
| `primaryEmotion` | `happy`, `sad`, `calm`, `energetic`, or `romantic`, case-sensitive |
| `secondaryMoods` | 0–3 free-form nonblank tags, each 1–40 characters |
| `explanation` | Nonblank text, 1–500 characters |
| `confidence` | Finite number, 0–1 inclusive |

```json
{
  "primaryEmotion": "calm",
  "secondaryMoods": ["dreamy", "quiet anticipation"],
  "explanation": "The soft evening light suggests a calm atmosphere.",
  "confidence": 0.7
}
```

Missing/extra fields, numeric strings, NaN and Infinity are invalid. Valid
strings keep their original spaces and case; there is no coercion, trimming,
normalization or default value. Lengths follow the installed Zod 4.6.6 string
checks (Unicode code points), including for astral characters such as emoji.
The exported JSON-serializable draft-2020-12 JSON Schema preserves required
fields, enum, count/length/number bounds, nonblank patterns and
`additionalProperties: false`. Types are inferred from that same Zod source.
`MOOD_EXAMPLES` exports five synthetic, valid interpretive examples.

Moods describe a reading of the photo's scenery, lighting, colors and
atmosphere. Confidence is the strength of that interpretation, not a factual
claim about a person's feelings or a calibrated guarantee. Importing or
validating this shared module requires no Next runtime, API key, environment
variable, database or network call. Provider integration and the analysis API
remain separate tasks (#11 and #12).

## Configuration

Settings such as the database URL and API keys come from environment variables. One server-only module, `lib/config`, reads and validates them. It has one getter per feature: `getDatabaseConfig()`, `getVisionConfig()`, `getSpotifyConfig()`, `getYouTubeConfig()` and `getStorageConfig()`. [`.env.example`](.env.example) lists every variable, with what it is, which feature needs it, where to get it, and its format.

Copy `.env.example` to `.env.local`, then fill in only the groups for the features you work on. Leave the others empty:

```sh
cp .env.example .env.local
```

- Next.js loads `.env.local` for `npm run dev`, `npm run build` and `npm start`. `npm test` does not read it. The tests set their own values, and pass with no variables set.
- `npm run db:check`, `npm run db:migrate` and `npm run test:db` run outside Next.js and load only `.env.local` (not `.env` or other `.env.*` files), using Node's own parser (`node --env-file-if-exists=.env.local`). As in Next.js, a variable set in the shell wins over the file. Node's parser neither expands `$NAME` nor unescapes `\$`.
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

## Database schema and migrations

The tables are defined with [Drizzle ORM](https://orm.drizzle.team/) in TypeScript, in [`lib/db/schema.ts`](lib/db/schema.ts). So far there is one table, `users`. Every change to the tables is a plain SQL migration in [`lib/db/migrations/`](lib/db/migrations), which `drizzle-kit generate` writes and which is committed. App code gets the database from `getDb()` in `lib/db`, only while handling a request (see the Rules in [`AGENTS.md`](AGENTS.md)).

Apply the pending migrations to the database in `DATABASE_URL`. Run this after starting the database, and after pulling new migrations:

```sh
npm run db:migrate
```

- It prints the name of each migration it applied, or that the database is already up to date. When it cannot connect, it fails with the same messages as `npm run db:check`.
- The pending migrations run in one transaction: if one fails, none of them is applied, and the command names the one that failed and the server's reason.
- It refuses to run, and applies nothing, when the database has not applied a migration that is older than the newest one it has. This happens when two branches each add a migration. Drizzle would skip such a migration for good, so the command names it instead. Generate it again on top of the newest migration, or start a local database over (see below).

To change the schema:

1. Edit `lib/db/schema.ts`. Name every column in snake_case, such as `text("password_hash")`.
2. Generate a migration, named after what changed:

   ```sh
   npm run db:generate -- --name add_display_name
   ```

3. Review the generated SQL in `lib/db/migrations/`. If drizzle-kit asks whether a column was renamed, answer carefully: a new column instead of a rename loses the old column's data.
4. Apply it locally with `npm run db:migrate`, then commit the schema change together with the generated files (the SQL file and the changes in `lib/db/migrations/meta/`).

`npm run db:generate` needs no database and no `DATABASE_URL`. When the schema has not changed, it writes nothing. CI runs it and fails if it would write a migration that is not committed.

- Never edit or delete a migration that is on `master`. There are no down migrations, so fix a mistake forward with a new migration. Locally, you can start over instead: `docker compose down -v`, `docker compose up -d --wait`, then `npm run db:migrate`.
- Do not use `drizzle-kit push`, `drizzle-kit migrate` or `drizzle-kit studio`. [`drizzle.config.ts`](drizzle.config.ts) has no database credentials on purpose: `npm run db:migrate` is the only way to apply migrations, so every database runs the same committed SQL and records it in its history table, `drizzle.__drizzle_migrations`.

### Database tests

Tests that need PostgreSQL are named `*.db.test.ts`, and `npm test` never runs them. Start the [local database](#local-database), then run them:

```sh
npm run test:db
```

- It needs a running database on this computer, and a database user with the `CREATEDB` privilege. The local database's user has it. On another server, a superuser can grant it with `ALTER ROLE <user> CREATEDB;`.
- Each run creates its own database, named `photo_music_test_` plus a random suffix, on the server in `DATABASE_URL`. It applies the migrations to it with the same code as `npm run db:migrate`, runs the tests against it, and drops it at the end, also when a test fails. It never changes the `DATABASE_URL` database itself, so you do not need to run `npm run db:migrate` first.
- It runs only against a server on this computer. For a `DATABASE_URL` host other than `localhost`, `127.0.0.1` or `::1`, it stops before connecting.
- Like `npm run db:check`, it loads `.env.local`, and a `DATABASE_URL` set in the shell wins over the file. When it cannot test, for example because the database is not running, it fails with a short message instead of skipping the tests.

A run that was killed can leave a `photo_music_test_...` database behind. To remove it, open a SQL shell (`\q` quits):

```sh
docker compose exec db psql -U photo_music -d photo_music
```

List the leftover test databases:

```sql
\l photo_music_test_*
```

Drop one of them by its name:

```sql
DROP DATABASE photo_music_test_0123456789ab WITH (FORCE);
```

Or, while no `npm run test:db` is running, drop all of them at once:

```sql
SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE starts_with(datname, 'photo_music_test_') \gexec
```

## Continuous integration

The `CI` workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on GitHub Actions on every push to any branch and on every pull request. It has two jobs, `checks` and `database`, which run side by side on Ubuntu with Node.js 24. Other Node.js versions allowed by `engines` are not tested in CI. The run is red if any step of either job fails.

The `checks` job:

- It installs dependencies with `npm ci`, then runs `npm run db:generate`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`, in that order. These are the same scripts you run locally.
- The first check, "Migrations match the schema", runs `npm run db:generate`. It fails if that changed or added any file in `lib/db/migrations`, which means that `lib/db/schema.ts` changed without a committed migration: run `npm run db:generate` and commit the result. It also fails when drizzle-kit needs to ask whether a column was renamed, which it cannot ask in CI. `npm ci` fails if `package-lock.json` is out of sync with `package.json`, so commit both together.
- If one check fails, the later checks still run, so a single run reports every problem. If the install fails, the checks are skipped.
- It needs no secrets, `.env` file, environment variables or database.

The `database` job:

- It installs dependencies with `npm ci`, starts the database from `docker-compose.yml` with `docker compose up -d --wait`, and runs `npm run db:check`, as described in [Local database](#local-database).
- Then it applies the migrations with `npm run db:migrate`, and runs the database tests with `npm run test:db`, as described in [Database schema and migrations](#database-schema-and-migrations). The database tests also run when the migrations failed, as long as the database started.
- If a step fails, it prints the database container's log (`docker compose logs db`). At the end it always removes the container and its volume with `docker compose down -v`.
- It sets only `DATABASE_URL`, to the local URL from `.env.example`, which is not a secret. It uses no secrets.

See the results in the repository's [Actions tab](https://github.com/qwopop/photo-music/actions/workflows/ci.yml), or in the `CI` check shown next to each commit and on each pull request.
