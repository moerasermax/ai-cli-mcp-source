/**
 * Codex agent。prompt 透過 stdin（positional `-`）送入，避免 Windows
 * shell:true 下 cmd.exe 重新切詞。行為 1:1 還原 dist。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';
import { debugLog } from '../core/debug.js';

const CODEX_MODELS = [
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
] as const;

const CODEX_REASONING = new Set(['low', 'medium', 'high', 'xhigh']);

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, reasoningEffort, sessionId } = input;
  let args: string[];
  if (sessionId) {
    args = ['exec', 'resume', sessionId];
  } else {
    args = ['exec'];
  }
  if (reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
  }
  if (resolvedModel && resolvedModel !== 'codex') {
    args.push('--model', resolvedModel);
  }
  // prompt 走 stdin（positional `-`）：Windows 下 shell:true，Node 不會跳脫 args，
  // cmd.exe 會對含空白/換行/數字的 prompt 重新切詞。Codex 文件：用 `-` 從 stdin 讀。
  args.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-');
  return { cliPath, args, cwd, agent: 'codex', prompt, resolvedModel, stdinPrompt: prompt };
}

function parseOutput(stdout: string, stderr: string): unknown {
  // Codex 把 stdout 與 stderr 合併解析（1:1 dist）
  const combined = `${stdout || ''}\n${stderr || ''}`;
  if (!combined.trim()) return null;
  try {
    const lines = combined.trim().split('\n');
    let lastMessage: string | null = null;
    let tokenCount: unknown = null;
    let threadId: string | null = null;
    const tools: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'thread.started' && parsed.thread_id) {
          threadId = parsed.thread_id;
        } else if (parsed.item?.type === 'agent_message') {
          lastMessage = parsed.item.text;
        } else if (parsed.msg?.type === 'agent_message') {
          lastMessage = parsed.msg.message;
        } else if (parsed.item?.type === 'reasoning') {
          /* skip reasoning */
        } else if (parsed.msg?.type === 'token_count') {
          tokenCount = parsed.msg;
        } else if (parsed.type === 'item.completed' && parsed.item?.type === 'mcp_tool_call') {
          tools.push({
            server: parsed.item.server,
            tool: parsed.item.tool,
            input: parsed.item.arguments,
            output: parsed.item.result,
          });
        } else if (parsed.type === 'item.completed' && parsed.item?.type === 'command_execution') {
          tools.push({
            tool: 'command_execution',
            input: { command: parsed.item.command },
            output: parsed.item.aggregated_output,
            exit_code: parsed.item.exit_code,
          });
        }
      } catch {
        debugLog(`[Debug] Skipping invalid JSON line: ${line}`);
      }
    }
    if (lastMessage || tokenCount || threadId || tools.length > 0) {
      return {
        message: lastMessage,
        token_count: tokenCount,
        session_id: threadId,
        tools: tools.length > 0 ? tools : undefined,
      };
    }
  } catch (e) {
    debugLog(`[Debug] Failed to parse Codex NDJSON output: ${e}`);
  }
  return null;
}

export const codexAgent: AgentDefinition = {
  id: 'codex',
  models: CODEX_MODELS,
  matchesModel: (model) => model === 'codex' || model.startsWith('gpt-'),
  binary: {
    envVarName: 'CODEX_CLI_NAME',
    defaultCliName: 'codex',
    localInstallPath: join(homedir(), '.codex', 'local', 'codex'),
  },
  reasoning: {
    supported: true,
    allowed: CODEX_REASONING,
    invalidMessage: 'Codex reasoning_effort supports only low, medium, high, xhigh.',
  },
  buildCommand,
  parseOutput,
};
