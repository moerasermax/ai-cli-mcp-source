/**
 * 指令組裝協調器。對應 dist/cli-builder.js 的 buildCliCommand。
 *
 * 流程：
 *   驗證輸入 → 取得 prompt → 解析 model alias → 選 agent → reasoning 預設值與驗證
 *   → 呼叫該 agent.buildCommand()
 *
 * direct-api 的 <provider>-<model> 在這裡專門解析（先於一般 routing）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute } from 'node:path';
import type { AgentDefinition, AgentId, BuiltCommand } from '../agents/types.js';
import { selectAgentForModel, getAgent } from '../agents/registry.js';
import { resolveDirectApiModel } from '../agents/direct-api.js';
import { resolveModelAlias } from '../models/catalog.js';
import { resolveReasoningEffort } from './reasoning.js';
import {
  loadUserConfigSnapshot,
  resolveConfiguredReasoningEffort,
  type UserConfig,
} from './user-config.js';
import { debugLog } from './debug.js';

export interface BuildCliCommandOptions {
  prompt?: string;
  prompt_file?: string;
  workFolder: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
  cliPaths: Partial<Record<AgentId, string>>;
}

interface ModelSelection {
  agent: AgentDefinition;
  resolvedModel: string;
  providerName?: string;
  providerModel?: string;
}

function resolveModelSelection(rawModel: string, config: UserConfig): ModelSelection {
  if (rawModel) {
    const directApiModel = resolveDirectApiModel(rawModel);
    if (directApiModel) {
      return {
        agent: getAgent('direct-api'),
        resolvedModel: directApiModel.modelName,
        providerName: directApiModel.providerName,
        providerModel: directApiModel.modelName,
      };
    }
  }
  const aliasedModel = resolveModelAlias(rawModel, config);
  const directApiAliasModel = aliasedModel !== rawModel ? resolveDirectApiModel(aliasedModel) : null;
  if (directApiAliasModel) {
    return {
      agent: getAgent('direct-api'),
      resolvedModel: directApiAliasModel.modelName,
      providerName: directApiAliasModel.providerName,
      providerModel: directApiAliasModel.modelName,
    };
  }
  return {
    agent: selectAgentForModel(aliasedModel),
    resolvedModel: aliasedModel,
  };
}

/**
 * 呼叫端未指定 reasoning_effort 時，套用設定檔／內建預設。
 * 與明確指定不同：這裡任何「該 agent 不支援」的情況都靜默略過，不丟錯。
 */
function resolveDefaultReasoningEffort(
  agent: AgentDefinition,
  rawModel: string,
  config: UserConfig
): string {
  const configured = resolveConfiguredReasoningEffort(rawModel, config);
  if (!configured) return '';
  if (!agent.reasoning.supported) {
    debugLog(`[Config] Skipping default reasoning "${configured}": ${agent.id} does not support it`);
    return '';
  }
  if (agent.reasoning.allowed && !agent.reasoning.allowed.has(configured)) {
    debugLog(
      `[Config] Skipping default reasoning "${configured}": not allowed for ${agent.id}; using its CLI default`
    );
    return '';
  }
  return configured;
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
  // 這一次組指令從頭到尾只讀一次設定檔：alias 與 reasoning 必須來自同一份設定，
  // 否則中途被改動就會組出「A 版 alias + B 版 reasoning」這種兩邊都不對的指令。
  const userConfig = loadUserConfigSnapshot();
  const { agent, resolvedModel, providerName, providerModel } = resolveModelSelection(
    rawModel,
    userConfig
  );

  // reasoning：呼叫端明確指定 → 照舊驗證（不合法就丟錯）。
  // 未指定 → 由持久化設定 / 內建 ultra 預設補上，但只在該 agent 真的吃得下時才套用；
  // 設定檔是「全域偏好」而非該次呼叫的明確意圖，不該讓 kiro/agy 這種不支援 reasoning
  // 的 agent 因此整個 run 失敗。
  const explicitEffort = options.reasoning_effort;
  let reasoningEffort: string;
  if (typeof explicitEffort === 'string' && explicitEffort.trim() !== '') {
    reasoningEffort = resolveReasoningEffort(agent.reasoning, explicitEffort);
  } else {
    reasoningEffort = resolveDefaultReasoningEffort(agent, rawModel, userConfig);
  }

  return agent.buildCommand({
    cliPath: options.cliPaths[agent.id] || '',
    cwd,
    prompt,
    resolvedModel,
    rawModel,
    reasoningEffort,
    sessionId:
      options.session_id && typeof options.session_id === 'string'
        ? options.session_id
        : undefined,
    providerName,
    providerModel,
  });
}
