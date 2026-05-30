/**
 * 指令組裝協調器。對應 dist/cli-builder.js 的 buildCliCommand。
 *
 * 流程：
 *   驗證輸入 → 取得 prompt → 解析 model alias → 選 agent → reasoning 預設值與驗證
 *   → 呼叫該 agent.buildCommand()
 *
 * opencode 的 oc-<provider/model> 在這裡專門解析（先於一般 routing）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute } from 'node:path';
import type { AgentDefinition, AgentId, BuiltCommand } from '../agents/types.js';
import { selectAgentForModel, getAgent } from '../agents/registry.js';
import { resolveModelAlias } from '../models/catalog.js';
import { resolveReasoningEffort } from './reasoning.js';

const OPENCODE_MODEL_ERROR = 'Invalid OpenCode model. Expected exact syntax oc-<provider/model>.';

export interface BuildCliCommandOptions {
  prompt?: string;
  prompt_file?: string;
  workFolder: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
  cliPaths: Record<AgentId, string>;
}

interface ModelSelection {
  agent: AgentDefinition;
  resolvedModel: string;
  openCodeModel: string | null;
}

function isPotentialOpenCodeExplicitModel(rawModel: string): boolean {
  return rawModel.startsWith('oc-') || rawModel.trim().startsWith('oc-');
}

function extractOpenCodeModel(rawModel: string): string {
  if (rawModel !== rawModel.trim()) {
    throw new Error(OPENCODE_MODEL_ERROR);
  }
  if (!rawModel.startsWith('oc-')) {
    throw new Error(OPENCODE_MODEL_ERROR);
  }
  const remainder = rawModel.slice(3);
  const slashIndex = remainder.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(OPENCODE_MODEL_ERROR);
  }
  const provider = remainder.slice(0, slashIndex);
  const model = remainder.slice(slashIndex + 1);
  if (!provider || !model) {
    throw new Error(OPENCODE_MODEL_ERROR);
  }
  return remainder;
}

function resolveModelSelection(rawModel: string): ModelSelection {
  if (rawModel === 'opencode') {
    return { agent: getAgent('opencode'), resolvedModel: rawModel, openCodeModel: null };
  }
  if (isPotentialOpenCodeExplicitModel(rawModel)) {
    return {
      agent: getAgent('opencode'),
      resolvedModel: rawModel,
      openCodeModel: extractOpenCodeModel(rawModel),
    };
  }
  const resolvedModel = resolveModelAlias(rawModel);
  return {
    agent: selectAgentForModel(resolvedModel),
    resolvedModel,
    openCodeModel: null,
  };
}

export function buildCliCommand(options: BuildCliCommandOptions): BuiltCommand {
  if (!options.workFolder || typeof options.workFolder !== 'string') {
    throw new Error('Missing or invalid required parameter: workFolder');
  }
  const hasPrompt =
    !!options.prompt && typeof options.prompt === 'string' && options.prompt.trim() !== '';
  const hasPromptFile =
    !!options.prompt_file &&
    typeof options.prompt_file === 'string' &&
    options.prompt_file.trim() !== '';
  if (!hasPrompt && !hasPromptFile) {
    throw new Error('Either prompt or prompt_file must be provided');
  }
  if (hasPrompt && hasPromptFile) {
    throw new Error('Cannot specify both prompt and prompt_file. Please use only one.');
  }

  let prompt: string;
  if (hasPrompt) {
    prompt = options.prompt as string;
  } else {
    const promptFilePath = isAbsolute(options.prompt_file as string)
      ? (options.prompt_file as string)
      : pathResolve(options.workFolder, options.prompt_file as string);
    if (!existsSync(promptFilePath)) {
      throw new Error(`Prompt file does not exist: ${promptFilePath}`);
    }
    try {
      prompt = readFileSync(promptFilePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read prompt file: ${(error as Error).message}`);
    }
  }

  const cwd = pathResolve(options.workFolder);
  if (!existsSync(cwd)) {
    throw new Error(`Working folder does not exist: ${options.workFolder}`);
  }

  const rawModel = options.model || '';
  const { agent, resolvedModel, openCodeModel } = resolveModelSelection(rawModel);

  // reasoning 預設值：ultra alias 自動帶入（1:1 dist）
  let reasoningEffortArg = options.reasoning_effort;
  if (!reasoningEffortArg) {
    if (rawModel === 'codex-ultra') {
      reasoningEffortArg = 'xhigh';
    } else if (rawModel === 'claude-ultra') {
      reasoningEffortArg = 'max';
    }
  }

  // opencode（含 oc-）直接拒絕 reasoning_effort
  if (agent.id === 'opencode') {
    if (reasoningEffortArg && reasoningEffortArg.trim()) {
      throw new Error('reasoning_effort is not supported for opencode.');
    }
  }
  const reasoningEffort =
    agent.id === 'opencode'
      ? ''
      : resolveReasoningEffort(agent.reasoning, reasoningEffortArg);

  return agent.buildCommand({
    cliPath: options.cliPaths[agent.id],
    cwd,
    prompt,
    resolvedModel,
    rawModel,
    reasoningEffort,
    sessionId:
      options.session_id && typeof options.session_id === 'string'
        ? options.session_id
        : undefined,
    openCodeModel,
  });
}
