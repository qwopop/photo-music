/**
 * The app's database client. Server-only.
 *
 * Call `getDb()` only while handling a request, like the `lib/config`
 * getters (see the Rules in AGENTS.md): in a POST handler or server action,
 * or after a runtime API such as `await connection()` in a GET handler or
 * page. Never call it at module top level or inside `"use cache"` code, and
 * never log the config or the connection settings: they hold the password.
 *
 * Importing this module reads no environment variable and opens no
 * connection. The first `getDb()` call reads `DATABASE_URL` and creates a
 * `pg` pool, which connects on the first query.
 */
import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDatabaseConfig } from "../config";
import { connectionSettings } from "./connection";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * The client lives on `globalThis`, not in a module variable, so that a
 * module evaluated again (as hot reload in `npm run dev` does) reuses it
 * instead of opening a second pool.
 */
const store = globalThis as typeof globalThis & { __photoMusicDb?: Database };

/**
 * The Drizzle client over a shared `pg` pool, created on the first call.
 * Throws the `ConfigError` from `lib/config` when `DATABASE_URL` is missing
 * or invalid.
 */
export function getDb(): Database {
  if (store.__photoMusicDb) return store.__photoMusicDb;

  const pool = new Pool(connectionSettings(getDatabaseConfig()));
  // An idle connection that fails (such as when the server restarts) would
  // otherwise crash the process. The pool drops it and opens a new one on
  // the next query.
  pool.on("error", (error) => {
    console.error(`An idle PostgreSQL connection failed and was closed: ${error.message}`);
  });
  const db = drizzle({ client: pool, schema });
  store.__photoMusicDb = db;
  return db;
}

/**
 * Closes the pool, so that the process can exit, and forgets the client. The
 * next `getDb()` creates a new one. For tests and scripts; the app does not
 * call it.
 */
export async function closeDb(): Promise<void> {
  const db = store.__photoMusicDb;
  if (!db) return;
  delete store.__photoMusicDb;
  await db.$client.end();
}
