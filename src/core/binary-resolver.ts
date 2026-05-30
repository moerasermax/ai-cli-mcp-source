/**
 * CLI 二進位解析。1:1 還原自 dist/cli-utils.js 的解析邏輯，
 * 但改為吃 agent 的 BinaryConfig（envVarName / defaultCliName / localInstallPath）。
 *
 * 解析優先序：
 *   1. 環境變數覆寫（絕對路徑 or 簡單名稱；不允許相對路徑）
 *   2. localInstallPath（若存在且可執行）
 *   3. 在 PATH 上搜尋
 */

import { accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { AgentId, BinaryConfig } from '../agents/types.js';
import { debugLog } from './debug.js';

export interface CliBinaryStatus {
  configuredCommand: string;
  resolvedPath: string | null;
  available: boolean;
  lookup: 'env' | 'local' | 'path';
  error?: string;
}

function getPathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function getPathExtensions(): string[] {
  if (process.platform !== 'win32') {
    return [''];
  }
  // 真正的執行檔副檔名排在 '' 之前：npm 全域安裝會同時放 extensionless 的
  // bash shim 與 <name>.cmd。cmd.exe 無法執行 extensionless bash 腳本（exit 1
  // 空輸出），所以必須優先解析到 <name>.cmd / <name>.exe。
  const rawPathext = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  return [...rawPathext.split(';').filter(Boolean), ''];
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(commandName: string): string | null {
  const rawPath = process.env.PATH || '';
  if (!rawPath) {
    return null;
  }
  const pathEntries = rawPath.split(getPathDelimiter()).filter(Boolean);
  const extensions = getPathExtensions();
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, `${commandName}${extension}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function validateCustomCliName(envVarName: string, customCliName: string): string | null {
  if (isAbsolute(customCliName)) {
    return null;
  }
  if (
    customCliName.startsWith('./') ||
    customCliName.startsWith('../') ||
    customCliName.includes('/')
  ) {
    const fallback = customCliName.split('/').pop() || 'cli';
    return `Invalid ${envVarName}: Relative paths are not allowed. Use either a simple name (e.g., '${fallback}') or an absolute path (e.g., '/tmp/${fallback}-test')`;
  }
  return null;
}

export function inspectCliBinary(config: BinaryConfig): CliBinaryStatus {
  const customCliName = process.env[config.envVarName];
  const configuredCommand = customCliName || config.defaultCliName;

  if (customCliName) {
    const validationError = validateCustomCliName(config.envVarName, customCliName);
    if (validationError) {
      return { configuredCommand, resolvedPath: null, available: false, lookup: 'env', error: validationError };
    }
    if (isAbsolute(customCliName)) {
      return {
        configuredCommand,
        resolvedPath: customCliName,
        available: isExecutableFile(customCliName),
        lookup: 'env',
      };
    }
    const resolvedPath = findExecutableOnPath(configuredCommand);
    return { configuredCommand, resolvedPath, available: resolvedPath !== null, lookup: 'env' };
  }

  if (config.localInstallPath && isExecutableFile(config.localInstallPath)) {
    return { configuredCommand, resolvedPath: config.localInstallPath, available: true, lookup: 'local' };
  }

  const resolvedPath = findExecutableOnPath(configuredCommand);
  return { configuredCommand, resolvedPath, available: resolvedPath !== null, lookup: 'path' };
}

export function getCliCommandOrThrow(status: CliBinaryStatus): string {
  if (status.error) {
    throw new Error(status.error);
  }
  if (status.lookup === 'env' && !isAbsolute(status.configuredCommand)) {
    return status.configuredCommand;
  }
  return status.resolvedPath || status.configuredCommand;
}

/** 解析單一 agent 的 CLI 路徑（找不到不丟錯，回 command 名稱）。 */
export function resolveAgentCli(config: BinaryConfig): string {
  debugLog(`[Debug] Resolving CLI for ${config.defaultCliName}...`);
  return getCliCommandOrThrow(inspectCliBinary(config));
}

/** doctor 用：所有 agent 的二進位狀態。 */
export interface CliDoctorStatus {
  checks: {
    binaryAvailability: boolean;
    pathResolution: boolean;
    loginState: boolean;
    termsAcceptance: boolean;
  };
  [agentId: string]: CliBinaryStatus | CliDoctorStatus['checks'];
}

export function buildDoctorStatus(
  configs: Array<{ id: AgentId; config: BinaryConfig }>
): CliDoctorStatus {
  const status: CliDoctorStatus = {
    checks: {
      binaryAvailability: true,
      pathResolution: true,
      loginState: false,
      termsAcceptance: false,
    },
  };
  for (const { id, config } of configs) {
    status[id] = inspectCliBinary(config);
  }
  return status;
}
