import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // `next dev` otherwise appends a managed block to AGENTS.md when it detects
  // an AI coding agent. AGENTS.md is maintained by hand in this repo.
  agentRules: false,
};

export default nextConfig;
