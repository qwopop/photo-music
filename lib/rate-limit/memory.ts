import type { RateLimitRepository } from "./index";

/** In-memory repository for tests. */
export function memoryRateLimitRepository(): RateLimitRepository & { rows: { scope: string; keyHash: string; at: Date }[] } {
  const rows: { scope: string; keyHash: string; at: Date }[] = [];
  return {
    rows,
    async count(scope, keyHash, since) {
      const hits = rows.filter((row) => row.scope === scope && row.keyHash === keyHash && row.at > since);
      const oldest = hits.reduce<Date | null>((first, row) => (!first || row.at < first ? row.at : first), null);
      return { count: hits.length, oldest };
    },
    async add(scope, keyHash, at) { rows.push({ scope, keyHash, at }); },
    async deleteBefore(cutoff) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].at <= cutoff) rows.splice(i, 1);
    },
    async clear(scope, keyHash) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].scope === scope && rows[i].keyHash === keyHash) rows.splice(i, 1);
    },
  };
}
