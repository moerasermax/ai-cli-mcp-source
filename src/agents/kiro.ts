/**
 * Kiro CLI agent。
 * --no-interactive 模式可走一般 pipe（不需要 PTY），但 win32 需要 shell:false
 * 並把 prompt 當 positional（避免 npm shim/cmd.exe 問題）。
 *
 * 行為 1:1 還原 dist：cli-builder.js kiro 分支 + parsers.js parseKiroOutput
 * + process-service.js _startKiroProcess（win32 shell:false pipe）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';
import { stripAnsi } from '../core/ansi.js';

const KIRO_MODELS = [
  'kiro',
  'kiro-default',
  'kiro-deepseek-3.2',
  'kiro-minimax-m2.5',
  'kiro-minimax-m2.1',
  'kiro-glm-5',
  'kiro-qwen3-coder-next',
] as const;

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel } = input;
  const args = ['chat', '--no-interactive', '--trust-all-tools'];
  if (resolvedModel && resolvedModel !== 'kiro' && resolvedModel !== 'kiro-default') {
    // 剝掉 'kiro-' prefix：'kiro-glm-5' → '--model glm-5'
    const kiroModelArg = resolvedModel.startsWith('kiro-') ? resolvedModel.slice(5) : resolvedModel;
    args.push('--model', kiroModelArg);
  }
  args.push(prompt);
  return { cliPath, args, cwd, agent: 'kiro', prompt, resolvedModel };
}

function parseOutput(stdout: string): unknown {
  const stripped = stripAnsi(stdout).trim();
  return { message: stripped, agent: 'kiro' };
}

function resolveKiroLocalPath(): string {
  return process.platform === 'win32'
    ? join(
        process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
        'Kiro-Cli',
        'kiro-cli.exe'
      )
    : join(homedir(), '.kiro', 'local', 'kiro-cli');
}

export const kiroAgent: AgentDefinition = {
  id: 'kiro',
  models: KIRO_MODELS,
  matchesModel: (model) => model === 'kiro' || model.startsWith('kiro-'),
  binary: {
    envVarName: 'KIRO_CLI_NAME',
    defaultCliName: 'kiro-cli',
    localInstallPath: resolveKiroLocalPath(),
  },
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for kiro models.',
  },
  buildCommand,
  parseOutput,
  // kiro-cli.exe 是真實執行檔，win32 需 shell:false 避免 cmd.exe 重新切詞
  win32DirectExec: true,
};
