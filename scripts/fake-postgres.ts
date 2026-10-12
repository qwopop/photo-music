/**
 * Test helper: a tiny TCP server that speaks just enough of the PostgreSQL
 * wire protocol to test `db:check` without a database. Not for production.
 *
 * - "silent": accepts connections and never answers, like a stuck server.
 * - "wrong-password": answers the login with the error a real server sends
 *   for a wrong password, then closes the connection.
 * - "wrong-password-cp1251": the same, with the message in Russian and
 *   encoded as Windows-1251, as a Windows server with Russian lc_messages
 *   sends it. It is not valid UTF-8.
 * - "ok": logs anyone in without a password and answers every query with
 *   one row (version, database, user), like PostgreSQL 18.
 *
 * It does not support SSL, so URLs must not ask for it.
 */
import { createServer, type AddressInfo, type Socket } from "node:net";

export type FakePostgresMode = "silent" | "wrong-password" | "wrong-password-cp1251" | "ok";

export interface FakePostgres {
  port: number;
  /** Connections accepted so far. */
  readonly connections: number;
  /** Connections that the client ended with a Terminate message. */
  readonly terminated: number;
  /** Connections that are still open. */
  readonly open: number;
  close(): Promise<void>;
}

export const FAKE_SERVER_VERSION = "18.0 (fake)";

export async function startFakePostgres(mode: FakePostgresMode): Promise<FakePostgres> {
  const sockets = new Set<Socket>();
  let connections = 0;
  let terminated = 0;

  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (mode === "silent") return;

    let buffer = Buffer.alloc(0);
    let startedUp = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // The startup message has no type byte: Int32 length, then the body.
      if (!startedUp) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        startedUp = true;
        if (mode === "wrong-password" || mode === "wrong-password-cp1251") {
          const text = mode === "wrong-password" ? WRONG_PASSWORD : RUSSIAN_CP1251;
          socket.end(errorResponse({ S: "FATAL", V: "FATAL", C: "28P01", M: text }));
          return;
        }
        socket.write(Buffer.concat([message("R", int32(0)), readyForQuery()]));
      }
      // Every later message: Byte1 type, Int32 length (including itself), body.
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const type = String.fromCharCode(buffer[0]);
        buffer = buffer.subarray(1 + buffer.readInt32BE(1));
        if (type === "X") {
          terminated += 1;
          socket.end();
        } else if (type === "Q") {
          socket.write(
            Buffer.concat([
              rowDescription(["server_version", "database_name", "user_name"]),
              dataRow([FAKE_SERVER_VERSION, "photo_music", "photo_music"]),
              message("C", cstring("SELECT 1")),
              readyForQuery(),
            ]),
          );
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    get connections() {
      return connections;
    },
    get terminated() {
      return terminated;
    },
    get open() {
      return sockets.size;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A TCP port on 127.0.0.1 where nothing listens (it was free a moment ago). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function cstring(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

function message(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, "ascii"), int32(body.length + 4), body]);
}

function readyForQuery(): Buffer {
  return message("Z", Buffer.from("I", "ascii"));
}

const WRONG_PASSWORD = 'password authentication failed for user "photo_music"';

/** The start of the Russian translation of WRONG_PASSWORD, in Windows-1251. */
const RUSSIAN_CP1251 = Buffer.concat([
  Buffer.from([0xef, 0xee, 0xeb, 0xfc, 0xe7, 0xee, 0xe2, 0xe0, 0xf2, 0xe5, 0xeb, 0xfc]),
  Buffer.from(' "photo_music" ', "ascii"),
  Buffer.from([0xed, 0xe5, 0x20, 0xef, 0xf0, 0xee, 0xf8, 0xb8, 0xeb]),
]);

/** An ErrorResponse. Each field is a string (sent as UTF-8) or raw bytes. */
function errorResponse(fields: Record<string, string | Buffer>): Buffer {
  const parts = Object.entries(fields).map(([key, value]) =>
    Buffer.concat([
      Buffer.from(key, "ascii"),
      typeof value === "string" ? Buffer.from(value, "utf8") : value,
      Buffer.from([0]),
    ]),
  );
  return message("E", Buffer.concat([...parts, Buffer.from([0])]));
}

function rowDescription(names: readonly string[]): Buffer {
  const TEXT_TYPE_OID = 25;
  const fields = names.map((name) =>
    Buffer.concat([cstring(name), int32(0), int16(0), int32(TEXT_TYPE_OID), int16(-1), int32(-1), int16(0)]),
  );
  return message("T", Buffer.concat([int16(names.length), ...fields]));
}

function dataRow(values: readonly string[]): Buffer {
  const columns = values.map((value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([int32(bytes.length), bytes]);
  });
  return message("D", Buffer.concat([int16(values.length), ...columns]));
}
