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

Lint:

```sh
npm run lint
```

Type-check (`tsc --noEmit`):

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
