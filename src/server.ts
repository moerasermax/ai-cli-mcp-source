/**
 * 預設進入點。等同 dist/server.js：直接啟動 MCP server。
 * Claude Code 的 mcpServers 設定指向編譯後的 dist/server.js。
 */

export { debugLog } from './core/debug.js';
export { runMcpServer, AiCliMcpServer } from './app/mcp.js';
export { runCli } from './app/cli.js';

import { runMcpServer } from './app/mcp.js';

if (!process.env.VITEST) {
  runMcpServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
