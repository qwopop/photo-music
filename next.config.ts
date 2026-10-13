import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16.4's cached-shell resume omits visible HTML after no-JS form actions.
  // Render request-specific auth HTML directly, including the session header.
  cacheComponents: false,
  partialPrefetching: false,
  // `next dev` otherwise appends a managed block to AGENTS.md when it detects
  // an AI coding agent. AGENTS.md is maintained by hand in this repo.
  agentRules: false,
};

export default nextConfig;
