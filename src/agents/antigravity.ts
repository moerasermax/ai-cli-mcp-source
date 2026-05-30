/**
 * Antigravity CLI (agy) — Google Gemini 後繼 CLI (2026/05)。
 *
 * 關鍵：agy.exe 在 stdout 不是 TTY 時會靜默不輸出。所以 win32 必須走 ConPTY
 * （spawnMode pty）。模型由 agy CLI 內部依登入帳號決定，不接受 --model flag。
 *
 * 行為 1:1 還原 dist：cli-builder.js antigravity 分支 + parsers.js parseAntigravityOutput
 * + process-service.js _startAntigravityPty。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';

// agy 的模型由 CLI 內部決定（依登入帳號的 Google AI tier），不接受 --model flag。
// 'Gemini 3.5 Flash (High)' / 'Gemini 3.1 Pro (High)' 為 agy settings.json 的正式名稱寫法。
const ANTIGRAVITY_MODELS = [
  'agy',
  'agy-default',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.1 Pro (High)',
] as const;

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, sessionId } = input;
  // - agy 用 --print (-p) 做非互動單次模式
  // - --dangerously-skip-permissions 自動核准工具呼叫
  // - 不支援 --model flag（用 Google AI 帳號預設）
  // - cwd 自動作為 workspace
  const args = ['--dangerously-skip-permissions'];
  if (sessionId) {
    args.push('--conversation', sessionId);
  }
  args.push('-p', prompt);
  return { cliPath, args, cwd, agent: 'antigravity', prompt, resolvedModel };
}

/**
 * agy --print 輸出格式（v1.0.2）：
 *   致 User
 *   ---
 *   <body 多行>
 *   ---
 * 沒有 JSON、沒有 token stats、沒有 session_id。
 */
function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const blockMatch = trimmed.match(/^致\s*User\s*\r?\n---\r?\n([\s\S]+?)\r?\n---\s*$/);
  if (blockMatch) {
    return { message: blockMatch[1].trim() };
  }
  return { message: trimmed };
}

function resolveAntigravityLocalPath(): string {
  return process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.agy', 'bin', 'agy');
}

export const antigravityAgent: AgentDefinition = {
  id: 'antigravity',
  models: ANTIGRAVITY_MODELS,
  // 路由：agy / agy-default / agy-* / antigravity* / *-agy / 大寫 "Gemini ..."
  // 大寫 "Gemini " 區別於 lowercase gemini-cli 模型（本框架已不支援 gemini）。
  matchesModel: (model) =>
    model === 'agy' ||
    model === 'agy-default' ||
    model.startsWith('agy-') ||
    model.startsWith('antigravity') ||
    model.endsWith('-agy') ||
    model.startsWith('Gemini '),
  binary: {
    envVarName: 'AGY_CLI_NAME',
    defaultCliName: 'agy',
    localInstallPath: resolveAntigravityLocalPath(),
  },
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for antigravity (agy) models.',
  },
  buildCommand,
  parseOutput,
  // agy 在 win32 非 TTY 下靜默無輸出 → 強制走 ConPTY
  win32SpawnMode: 'pty',
};
