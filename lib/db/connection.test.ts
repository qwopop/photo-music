import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS, connectionSettings } from "./connection";

// Builds pg clients from the settings without connecting, and checks what pg
// would do with them.

const URL_WITH_EVERYTHING = "postgresql://photo_music:leakcheck-pw@127.0.0.1:54320/photo_music";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connectionSettings", () => {
  it("passes the URL, a 10-second connect timeout and ssl: false", () => {
    expect(connectionSettings({ url: URL_WITH_EVERYTHING })).toStrictEqual({
      connectionString: URL_WITH_EVERYTHING,
      connectionTimeoutMillis: 10_000,
      ssl: false,
    });
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
  });

  it("does not import server-only or read the config itself", () => {
    const source = readFileSync(new URL("./connection.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s+["']server-only["']/m);
    expect(source).not.toMatch(/from\s+["']\.\.\/config(\/node|\/index)?["']/);
  });

  describe("with libpq variables set", () => {
    function stubLibpqVariables(): void {
      vi.stubEnv("PGSSLMODE", "require");
      vi.stubEnv("PGHOST", "192.0.2.1");
      vi.stubEnv("PGPORT", "6543");
      vi.stubEnv("PGUSER", "someone_else");
      vi.stubEnv("PGPASSWORD", "wrong");
      vi.stubEnv("PGDATABASE", "other");
    }

    it("uses the URL's host, port, user, password and database, and no TLS", () => {
      stubLibpqVariables();
      const client = new Client(connectionSettings({ url: URL_WITH_EVERYTHING }));

      expect(client.host).toBe("127.0.0.1");
      expect(client.port).toBe(54320);
      expect(client.user).toBe("photo_music");
      expect(client.password).toBe("leakcheck-pw");
      expect(client.database).toBe("photo_music");
      expect(client.ssl).toBe(false);
    });

    it.each([
      ["sslmode=no-verify", { rejectUnauthorized: false }],
      ["sslmode=verify-full", {}],
      ["ssl=true", true],
    ])("uses TLS when the URL asks for it with %s", (query, ssl) => {
      stubLibpqVariables();
      const client = new Client(connectionSettings({ url: `${URL_WITH_EVERYTHING}?${query}` }));

      expect(client.ssl).toStrictEqual(ssl);
      expect(client.host).toBe("127.0.0.1");
    });

    it("reads them only for parts that the URL leaves out", () => {
      stubLibpqVariables();
      const client = new Client(connectionSettings({ url: "postgresql://photo_music@127.0.0.1:54320/photo_music" }));

      expect(client.password).toBe("wrong");
      expect(client.host).toBe("127.0.0.1");
      expect(client.ssl).toBe(false);
    });
  });
});
