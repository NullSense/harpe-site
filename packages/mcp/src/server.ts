import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

/** Build the Harpe MCP server with all tools registered (transport-agnostic). */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'harpe', version: '0.1.0' });
  registerTools(server);
  return server;
}
