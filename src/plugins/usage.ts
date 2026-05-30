/**
 * usage plugin 橋接。
 *
 * 原 dist 把外部 plugin 路徑寫死成絕對路徑；這裡改成由環境變數設定：
 *   AI_CLI_USAGE_PLUGIN_BIN = 外部 ai-cli-usage.mjs 的絕對路徑
 *
 * 未設定時回傳清楚的錯誤，而非靜默失敗。
 */

import { spawn } from 'node:child_process';

export const USAGE_PLUGIN_ENV = 'AI_CLI_USAGE_PLUGIN_BIN';

export interface UsageIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function getUsagePluginBin(): string | undefined {
  const bin = process.env[USAGE_PLUGIN_ENV];
  return bin && bin.trim() ? bin.trim() : undefined;
}

export function runUsagePlugin(args: string[], io: UsageIo): Promise<number> {
  const bin = getUsagePluginBin();
  if (!bin) {
    io.stderr(
      `usage plugin not configured. Set the ${USAGE_PLUGIN_ENV} environment variable to the absolute path of your ai-cli-usage.mjs.\n`
    );
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => io.stdout(chunk.toString()));
    child.stderr.on('data', (chunk) => io.stderr(chunk.toString()));
    child.on('error', (error) => {
      io.stderr(`Failed to run ai-cli usage plugin: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
