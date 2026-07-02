/**
 * Model 目錄與 alias 表。
 * 1:1 還原自實際運行的 dist/model-catalog.js（含 antigravity/kiro，無 gemini）。
 *
 * 各 agent 的 model 清單其實也定義在各自的 agents/<name>.ts，
 * 這裡彙整出對外的 models payload 與描述字串。
 */

import { listAgents, getAgent } from '../agents/registry.js';
import type { AgentId } from '../agents/types.js';

export interface ModelAliasDetail {
  name: string;
  resolvesTo: string;
  agent: AgentId;
  defaultReasoningEffort?: string;
}

/** alias → 實際 model。1:1 還原 dist。 */
export const MODEL_ALIASES: Record<string, string> = {
  'claude-ultra': 'opus',
  'codex-ultra': 'gpt-5.5',
  'agy-ultra': 'agy-default',
  'antigravity-ultra': 'agy-default',
  'kiro-ultra': 'kiro-default',
};

/** alias 詳細資訊（給 models payload 用）。 */
export const MODEL_ALIAS_DETAILS: ModelAliasDetail[] = [
  { name: 'claude-ultra', resolvesTo: 'opus', agent: 'claude', defaultReasoningEffort: 'max' },
  { name: 'codex-ultra', resolvesTo: 'gpt-5.5', agent: 'codex', defaultReasoningEffort: 'xhigh' },
  { name: 'agy-ultra', resolvesTo: 'agy-default', agent: 'antigravity' },
  { name: 'antigravity-ultra', resolvesTo: 'agy-default', agent: 'antigravity' },
  { name: 'kiro-ultra', resolvesTo: 'kiro-default', agent: 'kiro' },
];

/** direct-api 動態 model 後端提示。 */
export const DIRECT_API_DYNAMIC_BACKEND = {
  explicitPrefixes: {
    or: 'openrouter',
    ds: 'dashscope',
  },
  explicitPattern: '<provider>-<model>',
  providersConfig: '~/.local/share/ai-cli/providers.json',
  modelsAreDynamic: true,
} as const;

export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] || model;
}

/** 依固定顯示順序取得各 agent 的 model 清單。 */
function modelsByAgent(): Record<AgentId, readonly string[]> {
  const out = {} as Record<AgentId, readonly string[]>;
  for (const agent of listAgents()) {
    out[agent.id] = agent.models;
  }
  return out;
}

/** run 工具描述用的「Supported models」一行字串。1:1 對齊 dist 順序。 */
export function getSupportedModelsDescription(): string {
  const byAgent = modelsByAgent();
  return [
    '"claude-ultra", "codex-ultra", "agy-ultra", "kiro-ultra"',
    ...byAgent.claude.map((m) => `"${m}"`),
    ...byAgent.codex.map((m) => `"${m}"`),
    ...byAgent.antigravity.map((m) => `"${m}"`),
    ...byAgent.forge.map((m) => `"${m}"`),
    ...byAgent['direct-api'].map((m) => `"${m}"`),
    ...byAgent.kiro.map((m) => `"${m}"`),
  ].join(', ');
}

/** model 參數的長描述。1:1 還原 dist。 */
export function getModelParameterDescription(): string {
  const byAgent = modelsByAgent();
  const all = [
    ...byAgent.claude,
    ...byAgent.codex,
    ...byAgent.antigravity,
    ...byAgent.kiro,
    ...byAgent.forge,
    ...byAgent['direct-api'],
  ];
  return `The model to use. Aliases: "claude-ultra" (auto max effort), "codex-ultra" (auto xhigh reasoning), "agy-ultra" (Antigravity CLI), "kiro-ultra" (Kiro CLI default). Standard: ${all
    .map((m) => `"${m}"`)
    .join(
      ', '
    )}. direct-api accepts provider-prefixed models using "or-<model>" for OpenRouter, "ds-<model>" for DashScope, or "<provider>-<model>" for provider keys configured in ~/.local/share/ai-cli/providers.json. "forge" is a provider key, not a Forge model family selector. Antigravity (agy) uses whichever model is configured by the agy CLI (Google AI tier default). Kiro uses its CLI default for "kiro" and "kiro-default"; model names starting with "kiro-" are passed through with --model unless they resolve to the default.`;
}

/** models 工具的完整 payload。1:1 還原 dist。 */
export function getModelsPayload() {
  const byAgent = modelsByAgent();
  return {
    aliases: MODEL_ALIAS_DETAILS,
    claude: byAgent.claude,
    codex: byAgent.codex,
    antigravity: byAgent.antigravity,
    kiro: byAgent.kiro,
    forge: byAgent.forge,
    'direct-api': byAgent['direct-api'],
    dynamicModelBackends: {
      'direct-api': DIRECT_API_DYNAMIC_BACKEND,
    },
  };
}
