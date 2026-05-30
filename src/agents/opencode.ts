/**
 * OpenCode agent。支援動態 model：oc-<provider/model>。
 * routing 由 command-builder 專門攔截（model === 'opencode' 或 oc- 開頭），
 * 所以 matchesModel 在標準 routing 不會被用到，但仍保留正確判斷。
 *
 * 行為 1:1 還原 dist。opencode 失敗時保留 raw 輸出（preserveRawOnFailure）。
 */

import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';

const OPENCODE_MODELS = ['opencode'] as const;

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, sessionId, openCodeModel } = input;
  const args = ['run', '--format', 'json', '--dir', cwd];
  if (sessionId) {
    args.push('--session', sessionId);
  }
  if (openCodeModel) {
    args.push('--model', openCodeModel);
  }
  args.push(prompt);
  return { cliPath, args, cwd, agent: 'opencode', prompt, resolvedModel };
}

function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  let sessionId: string | null = null;
  let currentStepBuffer = '';
  let latestCompletedStep: unknown = null;
  let hasStepFinish = false;
  let hasParseableAssistantText = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed.sessionID === 'string' && parsed.sessionID) {
      sessionId = parsed.sessionID;
    }
    if (parsed.type === 'step_start') {
      currentStepBuffer = '';
      continue;
    }
    if (parsed.type === 'text' && parsed.part?.type === 'text' && typeof parsed.part.text === 'string') {
      currentStepBuffer += parsed.part.text;
      hasParseableAssistantText = true;
      continue;
    }
    if (parsed.type === 'step_finish') {
      hasStepFinish = true;
      latestCompletedStep = {
        message: currentStepBuffer,
        session_id: sessionId || undefined,
        tokens: parsed.part?.tokens,
        cost: parsed.part?.cost,
      };
    }
  }
  if (hasStepFinish && latestCompletedStep) {
    return latestCompletedStep;
  }
  if (hasParseableAssistantText) {
    return { message: currentStepBuffer, session_id: sessionId || undefined };
  }
  return null;
}

export const opencodeAgent: AgentDefinition = {
  id: 'opencode',
  models: OPENCODE_MODELS,
  matchesModel: (model) => model === 'opencode' || model.startsWith('oc-'),
  binary: {
    envVarName: 'OPENCODE_CLI_NAME',
    defaultCliName: 'opencode',
  },
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for opencode.',
  },
  buildCommand,
  parseOutput,
  preserveRawOnFailure: true,
};
