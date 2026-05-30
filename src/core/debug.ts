/** debug 紀錄。設 MCP_CLAUDE_DEBUG=true 才會輸出到 stderr。 */
const debugMode = process.env.MCP_CLAUDE_DEBUG === 'true';

export function debugLog(message?: unknown, ...optionalParams: unknown[]): void {
  if (debugMode) {
    console.error(message, ...optionalParams);
  }
}
