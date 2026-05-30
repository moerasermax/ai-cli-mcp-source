/**
 * Claude agent。也是整個 routing 的 fallback（matchesModel 永遠 true）。
 * 行為 1:1 還原 dist：cli-builder.js claude 分支 + parsers.js parseClaudeOutput。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';
import { debugLog } from '../core/debug.js';

const CLAUDE_MODELS = ['sonnet', 'sonnet[1m]', 'opus', 'opusplan', 'haiku'] as const;

const CLAUDE_REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, reasoningEffort, sessionId } = input;
  const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) {
    args.push('-r', sessionId, '--fork-session');
  }
  if (reasoningEffort) {
    args.push('--effort', reasoningEffort);
  }
  args.push('-p', prompt);
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }
  return { cliPath, args, cwd, agent: 'claude', prompt, resolvedModel };
}

function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  // Claude 有時直接吐單一 JSON
  try {
    return JSON.parse(stdout);
  } catch {
    /* fall through to NDJSON parsing */
  }
  try {
    const lines = stdout.trim().split('\n');
    let lastMessage: string | null = null;
    let assistantTextBuffer = '';
    let sessionId: string | null = null;
    const toolsMap = new Map<string, { tool: string; input: unknown; output: unknown }>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.session_id) {
          sessionId = parsed.session_id;
        }
        if (parsed.type === 'result' && parsed.result) {
          lastMessage = parsed.result;
        }
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'text' && typeof content.text === 'string') {
              assistantTextBuffer += content.text;
            }
            if (content.type === 'tool_use') {
              toolsMap.set(content.id, { tool: content.name, input: content.input, output: null });
            }
          }
        }
        if (parsed.type === 'user' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'tool_result' && content.tool_use_id) {
              const tool = toolsMap.get(content.tool_use_id);
              if (tool) {
                if (Array.isArray(content.content)) {
                  const textContent = content.content.find((c: any) => c.type === 'text');
                  tool.output = textContent?.text || null;
                } else {
                  tool.output = content.content;
                }
              }
            }
          }
        }
      } catch {
        debugLog(`[Debug] Skipping invalid JSON line in Claude output: ${line}`);
      }
    }
    const tools = Array.from(toolsMap.values());
    const fallbackMessage = assistantTextBuffer.trim() ? assistantTextBuffer : null;
    const message = lastMessage || fallbackMessage;
    if (message || sessionId || tools.length > 0) {
      return { message, session_id: sessionId, tools: tools.length > 0 ? tools : undefined };
    }
  } catch (e) {
    debugLog(`[Debug] Failed to parse Claude NDJSON output: ${e}`);
    return null;
  }
  return null;
}

export const claudeAgent: AgentDefinition = {
  id: 'claude',
  models: CLAUDE_MODELS,
  // fallback：任何沒被其他 agent 認領的 model 都走 claude
  matchesModel: () => true,
  binary: {
    envVarName: 'CLAUDE_CLI_NAME',
    defaultCliName: 'claude',
    localInstallPath: join(homedir(), '.claude', 'local', 'claude'),
  },
  reasoning: {
    supported: true,
    allowed: CLAUDE_REASONING,
    invalidMessage: 'Claude reasoning_effort supports only low, medium, high, xhigh, max.',
  },
  buildCommand,
  parseOutput,
};
