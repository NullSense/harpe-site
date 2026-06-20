#!/usr/bin/env node
/**
 * Harpe MCP server (stdio). Zero-config: defaults HARPE_DUMP_DATASET to the public
 * HF dataset so the dump deep-index + knowledge graph work out of the box. Override
 * the env (or set Upstash / AI keys) for private datasets or the analyze tool.
 *
 * Register in Claude Code:
 *   claude mcp add harpe -- npx -y @harpe/mcp
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

process.env.HARPE_DUMP_DATASET ||= 'NullSense/harpe-art';

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive; log to stderr (stdout is the MCP channel).
  console.error('[harpe-mcp] ready — search_art, artist, subject, resolve, item');
}

main().catch((err) => {
  console.error('[harpe-mcp] fatal:', err);
  process.exit(1);
});
